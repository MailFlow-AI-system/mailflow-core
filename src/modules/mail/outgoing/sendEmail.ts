import { createHash } from 'node:crypto'
import { assertMailContext, type MailContext } from '../context/types.js'
import type { SendEmailInput } from './contract.js'
import {
  MessageConflictError,
  type OutgoingMail,
  type ProviderAttachment,
  ProviderRejectedError,
} from './types.js'

export { MessageConflictError } from './types.js'
export async function sendEmail(
  { repository, deliver, resolveAttachments }: OutgoingMail,
  context: MailContext,
  input: SendEmailInput,
) {
  assertMailContext(context)
  const deliveryKey = `mail/${encodeURIComponent(context.workspaceId)}/${encodeURIComponent(context.userId)}/${input.id}`
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const record = await repository.reserve({ ...input, ...context, payloadHash, deliveryKey })
  if (record.payloadHash !== payloadHash)
    throw new MessageConflictError('This id belongs to a different message')
  if (!record.providerId) {
    // Resend retains keys for 24 hours; uncertain attempts must not be sent again after expiry.
    if (Date.now() - record.createdAt.getTime() >= 23 * 60 * 60 * 1000)
      throw new MessageConflictError('The retry window has expired')
    let attachments: ProviderAttachment[] = []
    if (input.attachments.length) {
      if (!resolveAttachments) throw new Error('Attachment storage unavailable')
      attachments = await resolveAttachments(context, input.attachments)
    }
    const attempt = await repository.beginAttempt(context, input.id)
    if (!attempt) return { id: record.id, status: 'sent' as const }
    let providerId: string
    try {
      providerId = await deliver(
        { ...input, attachments },
        record.deliveryKey ?? `mail/${context.userId}/${input.id}`,
      )
    } catch (error) {
      if (error instanceof ProviderRejectedError)
        await repository.markRejected(context, input.id, attempt)
      throw error
    }
    await repository.markSent(context, input.id, providerId)
  }
  return { id: record.id, status: 'sent' as const }
}

import { createHash } from 'node:crypto'
import type { SendEmailInput } from './contract.js'
import type { OutgoingMail } from './types.js'

export class MessageConflictError extends Error {}
export async function sendEmail(
  { repository, deliver }: OutgoingMail,
  userId: string,
  input: SendEmailInput,
) {
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const record = await repository.reserve({ ...input, userId, payloadHash })
  if (record.payloadHash !== payloadHash)
    throw new MessageConflictError('This id belongs to a different message')
  if (!record.providerId) {
    // Resend retains keys for 24 hours; uncertain attempts must not be sent again after expiry.
    if (Date.now() - record.createdAt.getTime() >= 23 * 60 * 60 * 1000)
      throw new MessageConflictError('The retry window has expired')
    const providerId = await deliver(input, `mail/${userId}/${input.id}`)
    await repository.markSent(userId, input.id, providerId)
  }
  return { id: record.id, status: 'sent' as const }
}

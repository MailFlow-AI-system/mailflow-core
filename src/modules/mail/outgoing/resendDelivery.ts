import { Resend } from 'resend'
import { z } from 'zod'
import { type OutgoingMail, ProviderRejectedError } from './types.js'

const rejectedErrors = new Set([
  'validation_error',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_parameter',
  'missing_required_field',
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'invalid_access',
  'invalid_region',
  'monthly_quota_exceeded',
  'daily_quota_exceeded',
  'rate_limit_exceeded',
])

export function createResendDelivery(
  environment: Record<string, string | undefined>,
): OutgoingMail['deliver'] {
  const config = z
    .object({ RESEND_API_KEY: z.string().min(1), RESEND_FROM_EMAIL: z.email() })
    .parse(environment)
  const resend = new Resend(config.RESEND_API_KEY)
  return async (message, idempotencyKey) => {
    const { data, error } = await resend.emails.send(
      {
        from: `MailFlow <${config.RESEND_FROM_EMAIL}>`,
        to: message.to,
        ...(message.cc.length ? { cc: message.cc } : {}),
        ...(message.bcc.length ? { bcc: message.bcc } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments.map(({ filename, content, contentId, contentType }) => ({
          filename,
          content,
          ...(contentId ? { contentId } : {}),
          ...(contentType ? { contentType } : {}),
        })),
      },
      { idempotencyKey },
    )
    if (
      error &&
      rejectedErrors.has(error.name) &&
      error.statusCode !== null &&
      [400, 401, 403, 422, 429].includes(error.statusCode)
    )
      throw new ProviderRejectedError('Email delivery failed')
    if (error || !data?.id) throw new Error('Email delivery failed')
    return data.id
  }
}

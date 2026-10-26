import { Resend } from 'resend'
import { z } from 'zod'
import type { OutgoingMail } from './types.js'

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
    if (error || !data?.id) throw new Error('Email delivery failed')
    return data.id
  }
}

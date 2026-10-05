import { expect, it, vi } from 'vitest'
import { createQueuedEmailTransport } from './queuedTransport.js'

it('bounds the provider request, preserves its key and sanitizes provider failures', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response('provider-sensitive-body', { status: 503 }))
  const send = createQueuedEmailTransport('synthetic-key', fetcher)
  const delivery = {
    from: 'noreply@mailflow.invalid',
    to: 'local@mailflow.invalid',
    subject: 'Test',
    html: '<p>Test</p>',
    text: 'Test',
  }
  await expect(
    send(delivery, { idempotencyKey: 'onboarding-email/synthetic-job' }),
  ).rejects.toThrow('Queued account email delivery failed')
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.resend.com/emails',
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: {
        Authorization: 'Bearer synthetic-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'onboarding-email/synthetic-job',
      },
    }),
  )
  await expect(send(delivery)).rejects.toThrow('requires an idempotency key')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

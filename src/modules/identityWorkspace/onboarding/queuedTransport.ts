import type { AccountEmailTransport } from '../accountEmails/index.js'

export function createQueuedEmailTransport(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): AccountEmailTransport {
  return async (delivery, options) => {
    if (!options?.idempotencyKey) throw new Error('Queued delivery requires an idempotency key')
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey,
      },
      body: JSON.stringify(delivery),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Queued account email delivery failed')
    }
    await response.body?.cancel()
  }
}

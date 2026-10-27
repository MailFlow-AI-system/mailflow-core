import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResendDelivery } from './resendDelivery.js'
import { ProviderRejectedError } from './types.js'

const message = {
  id: 'id',
  to: ['ada@example.test'],
  cc: ['copy@example.test'],
  bcc: ['hidden@example.test'],
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [{ filename: 'hello.txt', content: 'SGVsbG8=' }],
}
afterEach(() => vi.unstubAllGlobals())
describe('Resend delivery', () => {
  it('uses the installed SDK with the configured server sender and idempotency key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-id' }))
    vi.stubGlobal('fetch', fetcher)
    const deliver = createResendDelivery({
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'sender@example.test',
    })
    expect(await deliver(message, 'key')).toBe('provider-id')
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://api.resend.com/emails')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('key')
    expect(JSON.parse(init?.body as string)).toMatchObject({
      from: 'MailFlow <sender@example.test>',
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      attachments: message.attachments,
    })
  })
  it('fails for provider errors or missing confirmation ids', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ message: 'secret', name: 'validation_error' }, { status: 422 }),
      )
      .mockResolvedValueOnce(Response.json({}))
    vi.stubGlobal('fetch', fetcher)
    const deliver = createResendDelivery({
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'sender@example.test',
    })
    await expect(deliver(message, 'key')).rejects.toThrow('Email delivery failed')
    await expect(deliver(message, 'key')).rejects.toThrow('Email delivery failed')
  })
})

it('forwards inline image content ids and MIME types through the Resend SDK', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-id' }))
  vi.stubGlobal('fetch', fetcher)
  const deliver = createResendDelivery({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'sender@example.test',
  })
  await deliver(
    {
      ...message,
      attachments: [
        {
          filename: 'image.png',
          content: 'aGVsbG8=',
          contentId: 'mailflow-inline-1',
          contentType: 'image/png',
        },
      ],
    },
    'key',
  )
  const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)
  expect(body.attachments).toEqual([
    {
      filename: 'image.png',
      content: 'aGVsbG8=',
      content_id: 'mailflow-inline-1',
      content_type: 'image/png',
    },
  ])
})

it('distinguishes explicit provider rejection from ambiguous delivery outcomes', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { name: 'validation_error', statusCode: 422, message: 'invalid attachment' },
        { status: 422 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ name: 'internal_server_error', message: 'unknown' }, { status: 500 }),
    )
    .mockResolvedValueOnce(
      Response.json(
        { name: 'concurrent_idempotent_requests', message: 'in progress' },
        { status: 409 },
      ),
    )
    .mockRejectedValueOnce(new Error('connection reset'))
  vi.stubGlobal('fetch', fetcher)
  const deliver = createResendDelivery({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'sender@example.test',
  })
  await expect(deliver(message, 'key')).rejects.toBeInstanceOf(ProviderRejectedError)
  for (let index = 0; index < 3; index++) {
    const error = await deliver(message, 'key').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ProviderRejectedError)
  }
})

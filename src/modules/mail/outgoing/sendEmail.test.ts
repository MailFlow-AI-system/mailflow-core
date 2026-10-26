import { describe, expect, it, vi } from 'vitest'
import { sendEmailSchema } from './contract.js'
import { sendEmail } from './sendEmail.js'
import type { OutgoingMail, OutgoingRepository } from './types.js'

const input = {
  id: '00000000-0000-4000-8000-000000000001',
  to: ['ada@example.test'],
  cc: [],
  bcc: [],
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
}
function setup() {
  const record = {
    id: input.id,
    payloadHash: '',
    providerId: null as string | null,
    createdAt: new Date(),
  }
  const repository: OutgoingRepository = {
    reserve: vi.fn(async (value) => {
      record.payloadHash ||= value.payloadHash
      return record
    }),
    markSent: vi.fn(async () => {}),
    listSent: vi.fn(async () => []),
  }
  const deliver = vi.fn<OutgoingMail['deliver']>(async () => 'provider-id')
  return { repository, deliver, record }
}
describe('sendEmail', () => {
  it('reserves before real delivery and persists only the provider-confirmed result', async () => {
    const { repository, deliver } = setup()
    expect(await sendEmail({ repository, deliver }, 'user', input)).toEqual({
      id: input.id,
      status: 'sent',
    })
    expect(repository.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user', id: input.id }),
    )
    expect(deliver).toHaveBeenCalledWith(input, `mail/user/${input.id}`)
    expect(repository.markSent).toHaveBeenCalledWith('user', input.id, 'provider-id')
    expect(vi.mocked(repository.reserve).mock.invocationCallOrder[0]).toBeLessThan(
      deliver.mock.invocationCallOrder[0] ?? 0,
    )
  })
  it('does not mark provider failures as sent, and reuses the same key on retry', async () => {
    const { repository, deliver } = setup()
    deliver.mockRejectedValueOnce(new Error('provider secret'))
    await expect(sendEmail({ repository, deliver }, 'user', input)).rejects.toThrow(
      'provider secret',
    )
    expect(repository.markSent).not.toHaveBeenCalled()
    await sendEmail({ repository, deliver }, 'user', input)
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([
      `mail/user/${input.id}`,
      `mail/user/${input.id}`,
    ])
  })
  it('returns an already sent message without contacting the provider again', async () => {
    const { repository, deliver, record } = setup()
    await sendEmail({ repository, deliver }, 'user', input)
    record.providerId = 'provider-id'
    await sendEmail({ repository, deliver }, 'user', input)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('rejects reuse of an id with changed content', async () => {
    const { repository, deliver } = setup()
    await sendEmail({ repository, deliver }, 'user', input)
    await expect(
      sendEmail({ repository, deliver }, 'user', { ...input, subject: 'Changed' }),
    ).rejects.toThrow('different message')
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('refuses uncertain retries beyond the provider idempotency window', async () => {
    const { repository, deliver, record } = setup()
    record.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await expect(sendEmail({ repository, deliver }, 'user', input)).rejects.toThrow('expired')
    expect(deliver).not.toHaveBeenCalled()
  })
  it('recovers from a persistence failure with the same provider key', async () => {
    const { repository, deliver } = setup()
    vi.mocked(repository.markSent).mockRejectedValueOnce(new Error('database unavailable'))
    await expect(sendEmail({ repository, deliver }, 'user', input)).rejects.toThrow()
    await sendEmail({ repository, deliver }, 'user', input)
    expect(deliver.mock.calls[0]?.[1]).toBe(deliver.mock.calls[1]?.[1])
  })
})

it('preserves legacy retry hashes when the optional recipient name is blank', async () => {
  const { repository, deliver, record } = setup()
  await sendEmail({ repository, deliver }, 'user', input)
  record.providerId = 'provider-id'
  await sendEmail(
    { repository, deliver },
    'user',
    sendEmailSchema.parse({ ...input, recipientName: '  ' }),
  )
  expect(deliver).toHaveBeenCalledTimes(1)
})

it('rejects a changed recipient name when reusing the same delivery id', async () => {
  const { repository, deliver } = setup()
  await sendEmail({ repository, deliver }, 'user', { ...input, recipientName: 'Ada' })
  await expect(
    sendEmail({ repository, deliver }, 'user', { ...input, recipientName: 'Grace' }),
  ).rejects.toThrow('different message')
  expect(deliver).toHaveBeenCalledTimes(1)
})

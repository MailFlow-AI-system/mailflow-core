import { describe, expect, it, vi } from 'vitest'
import { sendEmailSchema } from './contract.js'
import { sendEmail } from './sendEmail.js'
import type { OutgoingMail, OutgoingRepository } from './types.js'

const scope = { workspaceId: 'workspace-a', userId: 'user' }
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
    deliveryKey: `mail/workspace-a/user/${input.id}` as string | null,
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
  it('separates opaque workspace and owner segments in provider idempotency keys', async () => {
    const { repository, deliver, record } = setup()
    vi.mocked(repository.reserve).mockImplementationOnce(async (value) => ({
      ...record,
      payloadHash: value.payloadHash,
      deliveryKey: value.deliveryKey,
    }))
    await sendEmail(
      { repository, deliver },
      { workspaceId: 'workspace/a', userId: 'owner/b' },
      input,
    )
    expect(deliver).toHaveBeenCalledWith(input, `mail/workspace%2Fa/owner%2Fb/${input.id}`)
  })
  it('preserves an explicitly authorized legacy delivery key and requires workspace context', async () => {
    const { repository, deliver, record } = setup()
    record.deliveryKey = null
    await sendEmail({ repository, deliver }, scope, input)
    expect(deliver).toHaveBeenCalledWith(input, `mail/user/${input.id}`)
    await expect(
      sendEmail({ repository, deliver }, { ...scope, workspaceId: '' }, input),
    ).rejects.toThrow()
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('reserves before real delivery and persists only the provider-confirmed result', async () => {
    const { repository, deliver } = setup()
    expect(await sendEmail({ repository, deliver }, scope, input)).toEqual({
      id: input.id,
      status: 'sent',
    })
    expect(repository.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user', id: input.id }),
    )
    expect(deliver).toHaveBeenCalledWith(input, `mail/workspace-a/user/${input.id}`)
    expect(repository.markSent).toHaveBeenCalledWith(scope, input.id, 'provider-id')
    expect(vi.mocked(repository.reserve).mock.invocationCallOrder[0]).toBeLessThan(
      deliver.mock.invocationCallOrder[0] ?? 0,
    )
  })
  it('does not mark provider failures as sent, and reuses the same key on retry', async () => {
    const { repository, deliver } = setup()
    deliver.mockRejectedValueOnce(new Error('provider secret'))
    await expect(sendEmail({ repository, deliver }, scope, input)).rejects.toThrow(
      'provider secret',
    )
    expect(repository.markSent).not.toHaveBeenCalled()
    await sendEmail({ repository, deliver }, scope, input)
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([
      `mail/workspace-a/user/${input.id}`,
      `mail/workspace-a/user/${input.id}`,
    ])
  })
  it('returns an already sent message without contacting the provider again', async () => {
    const { repository, deliver, record } = setup()
    await sendEmail({ repository, deliver }, scope, input)
    record.providerId = 'provider-id'
    await sendEmail({ repository, deliver }, scope, input)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('rejects reuse of an id with changed content', async () => {
    const { repository, deliver } = setup()
    await sendEmail({ repository, deliver }, scope, input)
    await expect(
      sendEmail({ repository, deliver }, scope, { ...input, subject: 'Changed' }),
    ).rejects.toThrow('different message')
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('refuses uncertain retries beyond the provider idempotency window', async () => {
    const { repository, deliver, record } = setup()
    record.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await expect(sendEmail({ repository, deliver }, scope, input)).rejects.toThrow('expired')
    expect(deliver).not.toHaveBeenCalled()
  })
  it('recovers from a persistence failure with the same provider key', async () => {
    const { repository, deliver } = setup()
    vi.mocked(repository.markSent).mockRejectedValueOnce(new Error('database unavailable'))
    await expect(sendEmail({ repository, deliver }, scope, input)).rejects.toThrow()
    await sendEmail({ repository, deliver }, scope, input)
    expect(deliver.mock.calls[0]?.[1]).toBe(deliver.mock.calls[1]?.[1])
  })
})

it('preserves legacy retry hashes when the optional recipient name is blank', async () => {
  const { repository, deliver, record } = setup()
  await sendEmail({ repository, deliver }, scope, input)
  record.providerId = 'provider-id'
  await sendEmail(
    { repository, deliver },
    scope,
    sendEmailSchema.parse({ ...input, recipientName: '  ' }),
  )
  expect(deliver).toHaveBeenCalledTimes(1)
})

it('rejects a changed recipient name when reusing the same delivery id', async () => {
  const { repository, deliver } = setup()
  await sendEmail({ repository, deliver }, scope, { ...input, recipientName: 'Ada' })
  await expect(
    sendEmail({ repository, deliver }, scope, { ...input, recipientName: 'Grace' }),
  ).rejects.toThrow('different message')
  expect(deliver).toHaveBeenCalledTimes(1)
})

it('reserves references before resolving bytes, uses resolved files only at delivery, and skips reads on confirmed retry', async () => {
  const { repository, deliver, record } = setup()
  const references = [{ id: '00000000-0000-4000-8000-000000000002', contentId: 'image-1' }]
  const binaries = [
    { filename: 'image.png', content: 'aGVsbG8=', contentId: 'image-1', contentType: 'image/png' },
  ]
  const resolveAttachments = vi.fn(async () => binaries)
  await sendEmail({ repository, deliver, resolveAttachments }, scope, {
    ...input,
    attachments: references,
  })
  expect(repository.reserve).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: references }),
  )
  expect(resolveAttachments).toHaveBeenCalledWith(scope, references)
  expect(vi.mocked(repository.reserve).mock.invocationCallOrder[0]).toBeLessThan(
    resolveAttachments.mock.invocationCallOrder[0] ?? 0,
  )
  expect(deliver).toHaveBeenCalledWith(
    { ...input, attachments: binaries },
    `mail/workspace-a/user/${input.id}`,
  )
  record.providerId = 'provider-id'
  await sendEmail({ repository, deliver, resolveAttachments }, scope, {
    ...input,
    attachments: references,
  })
  expect(resolveAttachments).toHaveBeenCalledTimes(1)
  expect(deliver).toHaveBeenCalledTimes(1)
})

it('does not contact the provider when storage resolution fails', async () => {
  const { repository, deliver } = setup()
  await expect(
    sendEmail(
      {
        repository,
        deliver,
        resolveAttachments: async () => {
          throw new Error('unverified')
        },
      },
      scope,
      {
        ...input,
        attachments: [{ id: '00000000-0000-4000-8000-000000000002' }],
      },
    ),
  ).rejects.toThrow('unverified')
  expect(deliver).not.toHaveBeenCalled()
  expect(repository.markSent).not.toHaveBeenCalled()
})

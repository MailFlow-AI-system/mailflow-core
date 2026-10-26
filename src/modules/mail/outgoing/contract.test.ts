import { describe, expect, it } from 'vitest'
import { sendEmailSchema } from './contract.js'

const input = {
  id: '00000000-0000-4000-8000-000000000001',
  to: ['ada@example.test'],
  cc: [],
  bcc: [],
  subject: 'Inline image',
  html: '<img src="cid:mailflow-inline-1">',
  text: 'Inline image',
  attachments: [{ id: '00000000-0000-4000-8000-000000000002', contentId: 'mailflow-inline-1' }],
}
describe('stored attachment reference contract', () => {
  it('accepts stable attachment ids and CID mapping', () => {
    expect(sendEmailSchema.safeParse(input).success).toBe(true)
  })
  it.each(['bad\r\nHeader: injected', 'a'.repeat(128)])(
    'rejects invalid content ids',
    (contentId) => {
      expect(
        sendEmailSchema.safeParse({
          ...input,
          attachments: [{ ...input.attachments[0], contentId }],
        }).success,
      ).toBe(false)
    },
  )
})

describe('optional recipient display name', () => {
  it('accepts missing and blank names and trims provided names', () => {
    expect(sendEmailSchema.parse(input).recipientName).toBeUndefined()
    expect(sendEmailSchema.parse({ ...input, recipientName: '   ' }).recipientName).toBeUndefined()
    expect(
      sendEmailSchema.parse({ ...input, recipientName: '  Ada Lovelace  ' }).recipientName,
    ).toBe('Ada Lovelace')
  })
  it.each(['a'.repeat(201), 'Ada\r\nInjected: value'])(
    'rejects invalid recipient names',
    (recipientName) => {
      expect(sendEmailSchema.safeParse({ ...input, recipientName }).success).toBe(false)
    },
  )
})

it('rejects legacy binary-bearing requests, repeated attachment ids and repeated content ids', () => {
  expect(
    sendEmailSchema.safeParse({
      ...input,
      attachments: [{ filename: 'hello.txt', content: 'aGVsbG8=' }],
    }).success,
  ).toBe(false)
  expect(
    sendEmailSchema.safeParse({
      ...input,
      attachments: [input.attachments[0], input.attachments[0]],
    }).success,
  ).toBe(false)
  expect(
    sendEmailSchema.safeParse({
      ...input,
      attachments: [
        input.attachments[0],
        { id: '00000000-0000-4000-8000-000000000003', contentId: 'mailflow-inline-1' },
      ],
    }).success,
  ).toBe(false)
  expect(
    sendEmailSchema.safeParse({
      ...input,
      attachments: Array.from({ length: 11 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    }).success,
  ).toBe(false)
})

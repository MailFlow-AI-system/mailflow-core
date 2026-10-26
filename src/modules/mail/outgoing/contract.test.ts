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
  attachments: [
    {
      filename: 'image.png',
      content: 'aGVsbG8=',
      contentId: 'mailflow-inline-1',
      contentType: 'image/png',
    },
  ],
}
describe('inline image attachment contract', () => {
  it('accepts CID images with explicit MIME type', () => {
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

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { validImageContent } from '../attachments/imageValidation.js'
import {
  ensureMailSeedAttachment,
  type MailSeedAttachmentFixture,
  type MailSeedAttachmentOperations,
  mailSeedAttachmentFixtures,
} from './seedAttachments.js'

const context = { workspaceId: 'workspace-a', userId: 'owner-a' }
const fixture: MailSeedAttachmentFixture = {
  messageKey: 'fixture-message',
  position: 0,
  filename: 'mailflow-qa-inline.png',
  contentType: 'image/png',
  contentId: 'mailflow-qa-inline-image',
  bytes: Buffer.from('fixture image bytes'),
}

function setup(
  existing: Awaited<ReturnType<MailSeedAttachmentOperations['findAssociation']>> = null,
) {
  const operations: MailSeedAttachmentOperations = {
    findAssociation: vi.fn(async () => existing),
    create: vi.fn(async () => ({
      id: 'attachment-a',
      uploadUrl: 'https://storage.test/upload',
      headers: {},
    })),
    upload: vi.fn(async () => {}),
    complete: vi.fn(async () => ({ status: 'clean' })),
    resolveReferences: vi.fn(async () => [
      { filename: fixture.filename, content: fixture.bytes.toString('base64') },
    ]),
    associate: vi.fn(async () => {}),
  }
  return operations
}

describe('mail seed attachments', () => {
  it('validates uploaded content through attachment completion before associating it', async () => {
    const operations = setup()

    await expect(ensureMailSeedAttachment(operations, context, 'message-a', fixture)).resolves.toBe(
      'inserted',
    )
    expect(operations.create).toHaveBeenCalledWith(context, {
      filename: fixture.filename,
      contentType: fixture.contentType,
      size: fixture.bytes.length,
      sha256: expect.any(String),
    })
    expect(operations.upload).toHaveBeenCalledWith('https://storage.test/upload', {}, fixture.bytes)
    expect(operations.complete).toHaveBeenCalledWith(context, 'attachment-a')
    expect(operations.resolveReferences).toHaveBeenCalledWith(context, [
      { id: 'attachment-a', contentId: fixture.contentId },
    ])
    expect(operations.associate).toHaveBeenCalledWith({
      ...context,
      messageId: 'message-a',
      attachmentId: 'attachment-a',
      position: fixture.position,
      contentId: fixture.contentId,
    })
  })

  it('validates existing fixture associations without creating duplicate uploads', async () => {
    const operations = setup({
      id: 'attachment-existing',
      contentId: fixture.contentId,
      filename: fixture.filename,
      contentType: fixture.contentType,
      size: fixture.bytes.length,
      sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
    })

    await expect(ensureMailSeedAttachment(operations, context, 'message-a', fixture)).resolves.toBe(
      'existing',
    )
    expect(operations.create).not.toHaveBeenCalled()
    expect(operations.upload).not.toHaveBeenCalled()
    expect(operations.complete).not.toHaveBeenCalled()
    expect(operations.associate).not.toHaveBeenCalled()
    expect(operations.resolveReferences).toHaveBeenCalledWith(context, [
      { id: 'attachment-existing', contentId: fixture.contentId },
    ])
  })

  it('refuses attachments that failed verification or do not match the fixture', async () => {
    const incomplete = setup()
    incomplete.complete = vi.fn(async () => ({ status: 'error' }))
    await expect(
      ensureMailSeedAttachment(incomplete, context, 'message-a', fixture),
    ).rejects.toThrow('complete cleanly')
    expect(incomplete.associate).not.toHaveBeenCalled()

    const corrupted = setup()
    corrupted.resolveReferences = vi.fn(async () => [
      { filename: fixture.filename, content: Buffer.from('different bytes').toString('base64') },
    ])
    await expect(
      ensureMailSeedAttachment(corrupted, context, 'message-a', fixture),
    ).rejects.toThrow('does not match')
    expect(corrupted.associate).not.toHaveBeenCalled()
  })

  it('defines deterministic PNG and PDF fixtures and links the image by CID', () => {
    expect(mailSeedAttachmentFixtures).toHaveLength(2)
    expect(mailSeedAttachmentFixtures[0]?.contentType).toBe('image/png')
    expect(mailSeedAttachmentFixtures[0]?.bytes.subarray(0, 8)).toEqual(
      Buffer.from('89504e470d0a1a0a', 'hex'),
    )
    expect(
      validImageContent('image/png', mailSeedAttachmentFixtures[0]?.bytes ?? Buffer.alloc(0)),
    ).toBe(true)
    expect(mailSeedAttachmentFixtures[1]?.contentType).toBe('application/pdf')
    expect(mailSeedAttachmentFixtures[1]?.bytes.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(mailSeedAttachmentFixtures[1]?.bytes.toString()).toContain('%%EOF')
  })
})

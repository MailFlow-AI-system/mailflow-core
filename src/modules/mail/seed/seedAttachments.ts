import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { AttachmentService } from '../attachments/service.js'
import type { AttachmentMetadata } from '../attachments/types.js'
import type { MailContext } from '../context/types.js'
import type { MailPool } from '../inbox/listMessages/types.js'
import {
  attachments,
  inboxMessageAttachments,
} from '../infrastructure/database/schema/attachments.js'
import { inWorkspaceTransaction } from '../infrastructure/database/workspaceTransaction.js'
import { seedMailMessages } from './fixtures.js'
import { mailSeedId } from './seedMail.js'

export type MailSeedAttachmentFixture = {
  messageKey: string
  position: number
  filename: string
  contentType: string
  contentId: string | null
  bytes: Buffer
}

export type MailSeedAttachmentAssociation = {
  id: string
  contentId: string | null
  filename: string
  contentType: string
  size: number
  sha256: string
}

export type MailSeedAttachmentOperations = {
  findAssociation: (
    context: MailContext,
    messageId: string,
    position: number,
  ) => Promise<MailSeedAttachmentAssociation | null>
  create: (
    context: MailContext,
    metadata: AttachmentMetadata,
  ) => Promise<{ id: string; uploadUrl: string; headers: Record<string, string> }>
  upload: (url: string, headers: Record<string, string>, bytes: Buffer) => Promise<void>
  complete: (context: MailContext, attachmentId: string) => Promise<{ status: string }>
  resolveReferences: (
    context: MailContext,
    refs: { id: string; contentId?: string }[],
  ) => Promise<{ filename: string; content: string }[]>
  associate: (input: {
    workspaceId: string
    userId: string
    messageId: string
    attachmentId: string
    position: number
    contentId: string | null
  }) => Promise<void>
}

const inlineImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
  'base64',
)

function createPdfFixture() {
  const stream = 'BT /F1 16 Tf 72 720 Td (MailFlow QA attachment) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output)
}

const inlineMessage = seedMailMessages[0]
const invoiceMessage = seedMailMessages[10]
if (!inlineMessage || !invoiceMessage) throw new Error('Mail QA attachment messages are missing')

export const mailSeedAttachmentFixtures: MailSeedAttachmentFixture[] = [
  {
    messageKey: inlineMessage.id,
    position: 0,
    filename: 'mailflow-qa-inline.png',
    contentType: 'image/png',
    contentId: 'mailflow-qa-inline-image',
    bytes: inlineImage,
  },
  {
    messageKey: invoiceMessage.id,
    position: 0,
    filename: 'mailflow-qa-invoice.pdf',
    contentType: 'application/pdf',
    contentId: null,
    bytes: createPdfFixture(),
  },
]

function fixtureMetadata(fixture: MailSeedAttachmentFixture): AttachmentMetadata {
  return {
    filename: fixture.filename,
    contentType: fixture.contentType,
    size: fixture.bytes.length,
    sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
  }
}

async function verifyFixtureContent(
  operations: MailSeedAttachmentOperations,
  context: MailContext,
  attachmentId: string,
  fixture: MailSeedAttachmentFixture,
) {
  const ref =
    fixture.contentId === null
      ? { id: attachmentId }
      : { id: attachmentId, contentId: fixture.contentId }
  const resolved = await operations.resolveReferences(context, [ref])
  const file = resolved[0]
  if (
    !file ||
    file.filename !== fixture.filename ||
    !Buffer.from(file.content, 'base64').equals(fixture.bytes)
  )
    throw new Error('Mail QA attachment content does not match its fixture')
}

export async function ensureMailSeedAttachment(
  operations: MailSeedAttachmentOperations,
  context: MailContext,
  messageId: string,
  fixture: MailSeedAttachmentFixture,
): Promise<'inserted' | 'existing'> {
  const metadata = fixtureMetadata(fixture)
  const existing = await operations.findAssociation(context, messageId, fixture.position)
  if (existing) {
    if (
      existing.contentId !== fixture.contentId ||
      existing.filename !== metadata.filename ||
      existing.contentType !== metadata.contentType ||
      existing.size !== metadata.size ||
      existing.sha256 !== metadata.sha256
    )
      throw new Error('Existing Mail QA attachment association does not match its fixture')
    await verifyFixtureContent(operations, context, existing.id, fixture)
    return 'existing'
  }

  const started = await operations.create(context, metadata)
  await operations.upload(started.uploadUrl, started.headers, fixture.bytes)
  const completed = await operations.complete(context, started.id)
  if (completed.status !== 'clean') throw new Error('Mail QA attachment did not complete cleanly')
  await verifyFixtureContent(operations, context, started.id, fixture)
  await operations.associate({
    ...context,
    messageId,
    attachmentId: started.id,
    position: fixture.position,
    contentId: fixture.contentId,
  })
  return 'inserted'
}

export async function seedMailAttachments(
  operations: MailSeedAttachmentOperations,
  workspaceId: string,
  userId: string,
): Promise<{ inserted: number; existing: number }> {
  let inserted = 0
  let existing = 0
  const context = { workspaceId, userId }
  for (const fixture of mailSeedAttachmentFixtures) {
    const messageId = mailSeedId(workspaceId, fixture.messageKey)
    const result = await ensureMailSeedAttachment(operations, context, messageId, fixture)
    if (result === 'inserted') inserted++
    else existing++
  }
  return { inserted, existing }
}

export function createMailSeedAttachmentOperations({
  pool,
  service,
}: {
  pool: MailPool
  service: AttachmentService
}): MailSeedAttachmentOperations {
  return {
    findAssociation: (context, messageId, position) =>
      inWorkspaceTransaction(pool, context.workspaceId, async (client) => {
        const [row] = await drizzle({ client })
          .select({
            id: attachments.id,
            contentId: inboxMessageAttachments.contentId,
            filename: attachments.filename,
            contentType: attachments.contentType,
            size: attachments.size,
            sha256: attachments.sha256,
          })
          .from(inboxMessageAttachments)
          .innerJoin(
            attachments,
            and(
              eq(attachments.id, inboxMessageAttachments.attachmentId),
              eq(attachments.userId, inboxMessageAttachments.userId),
              eq(attachments.workspaceId, inboxMessageAttachments.workspaceId),
            ),
          )
          .where(
            and(
              eq(inboxMessageAttachments.workspaceId, context.workspaceId),
              eq(inboxMessageAttachments.userId, context.userId),
              eq(inboxMessageAttachments.messageId, messageId),
              eq(inboxMessageAttachments.position, position),
            ),
          )
          .limit(1)
        return row ?? null
      }),
    create: (context, metadata) => service.create(context, metadata),
    upload: async (url, headers, bytes) => {
      let response: Response
      const body = new Uint8Array(bytes.byteLength)
      body.set(bytes)
      try {
        response = await fetch(url, { method: 'PUT', headers, body })
      } catch {
        throw new Error('Mail QA attachment upload failed')
      }
      if (!response.ok) throw new Error('Mail QA attachment upload failed')
    },
    complete: (context, attachmentId) => service.complete(context, attachmentId),
    resolveReferences: (context, refs) => service.resolveReferences(context, refs),
    associate: async (input) => {
      const inserted = await inWorkspaceTransaction(pool, input.workspaceId, async (client) =>
        drizzle({ client })
          .insert(inboxMessageAttachments)
          .values(input)
          .onConflictDoNothing({
            target: [
              inboxMessageAttachments.workspaceId,
              inboxMessageAttachments.userId,
              inboxMessageAttachments.messageId,
              inboxMessageAttachments.position,
            ],
          })
          .returning({ attachmentId: inboxMessageAttachments.attachmentId }),
      )
      if (inserted.length !== 1) throw new Error('Mail QA attachment association already exists')
    },
  }
}

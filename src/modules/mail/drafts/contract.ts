import { z } from '@hono/zod-openapi'

export const draftReferenceSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().min(1),
})
export const draftContentSchema = z.strictObject({
  to: z.string().max(20_000),
  cc: z.string().max(20_000),
  bcc: z.string().max(20_000),
  recipientName: z.string().max(200),
  subject: z.string().max(998),
  html: z.string().max(1024 * 1024),
  text: z.string().max(1024 * 1024),
  attachments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        contentId: z
          .string()
          .min(1)
          .max(127)
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
      }),
    )
    .max(10),
  labelIds: z.array(z.uuid()).max(50),
})
export const saveDraftSchema = draftContentSchema
  .extend({
    version: z.number().int().min(0),
    mutationId: z.uuid(),
  })
  .superRefine((value, context) => {
    for (const items of [
      value.attachments.map((item) => item.id),
      value.labelIds,
      value.attachments.flatMap((item) => (item.contentId ? [item.contentId] : [])),
    ]) {
      if (new Set(items).size !== items.length)
        context.addIssue({ code: 'custom', message: 'References must be unique' })
    }
    if (JSON.stringify(value).includes('\\u0000'))
      context.addIssue({ code: 'custom', message: 'Null characters are not supported' })
  })
export const searchTextSchema = z.string().trim().max(200)
export const discardDraftsSchema = z
  .strictObject({
    items: z.array(draftReferenceSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
      context.addIssue({ code: 'custom', message: 'Drafts must be unique' })
  })
export type DiscardDraftsResult = { id: string; status: 'discarded' | 'conflict' }
export type DraftContent = z.infer<typeof draftContentSchema>
export type SaveDraftInput = z.infer<typeof saveDraftSchema>

export class DraftConflictError extends Error {
  constructor() {
    super('The draft changed. Reopen it before continuing.')
  }
}
export class DraftReferenceError extends Error {}

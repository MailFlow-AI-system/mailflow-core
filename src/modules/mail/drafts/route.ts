import { OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import {
  DraftConflictError,
  DraftReferenceError,
  discardDraftsSchema,
  saveDraftSchema,
  searchTextSchema,
} from './contract.js'
import type { DraftRepository } from './repository.js'

export function createDraftRoutes(
  repository: DraftRepository,
  isAllowedOrigin: (origin: string) => boolean,
) {
  const app = new OpenAPIHono()
  for (const path of ['/api/v1/mail/drafts', '/api/v1/mail/drafts/*'])
    app.use(path, bodyLimit({ maxSize: 3 * 1024 * 1024 }), async (c, next) => {
      if (
        ['PUT', 'DELETE', 'POST'].includes(c.req.method) &&
        !isAllowedOrigin(c.req.header('origin') ?? '')
      )
        return problemDetailsResponse(c, {
          status: 403,
          title: 'Forbidden',
          code: 'untrusted_origin',
          detail: 'A trusted Origin is required.',
        })
      c.header('Cache-Control', 'private, no-store')
      await next()
    })
  app.get('/api/v1/mail/drafts', async (c) => {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .safeParse(c.req.query('offset') ?? 0)
    const search = searchTextSchema.safeParse(c.req.query('q') ?? '')
    if (!offset.success || !search.success) return c.json({ code: 'invalid_draft_query' }, 400)
    const items = await repository.list(c.get('mailContext'), offset.data, search.data)
    return c.json({
      items: items.slice(0, 20),
      nextOffset: items.length > 20 ? offset.data + 20 : null,
    })
  })
  app.post('/api/v1/mail/drafts/discard', async (c) => {
    const input = discardDraftsSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ code: 'invalid_draft' }, 400)
    return c.json({ results: await repository.discardMany(c.get('mailContext'), input.data.items) })
  })
  app.get('/api/v1/mail/drafts/:id', async (c) => {
    const id = c.req.param('id')
    if (!z.uuid().safeParse(id).success) return c.notFound()
    const draft = await repository.find(c.get('mailContext'), id)
    return draft ? c.json(draft) : c.notFound()
  })
  for (const method of ['put', 'delete'] as const)
    app[method]('/api/v1/mail/drafts/:id', async (c) => {
      const id = c.req.param('id')
      if (!z.uuid().safeParse(id).success) return c.notFound()
      const json: unknown = await c.req.json().catch(() => null)
      try {
        if (method === 'put') {
          const input = saveDraftSchema.safeParse(json)
          if (!input.success) return c.json({ code: 'invalid_draft' }, 400)
          return c.json(await repository.save(c.get('mailContext'), id, input.data))
        }
        const input = z.strictObject({ version: z.number().int().min(0) }).safeParse(json)
        if (!input.success) return c.json({ code: 'invalid_draft' }, 400)
        await repository.discard(c.get('mailContext'), id, input.data.version)
        return c.json({ status: 'discarded' })
      } catch (error) {
        if (error instanceof DraftConflictError || error instanceof DraftReferenceError)
          return problemDetailsResponse(c, {
            status: error instanceof DraftConflictError ? 409 : 400,
            title: error instanceof DraftConflictError ? 'Conflict' : 'Bad request',
            code:
              error instanceof DraftConflictError
                ? 'draft_conflict'
                : 'draft_reference_unavailable',
            detail: error.message,
          })
        throw error
      }
    })
  return app
}

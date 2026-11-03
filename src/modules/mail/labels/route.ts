import { OpenAPIHono, z } from '@hono/zod-openapi'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { MailEnvironment, ResolveWorkspace } from '../inbox/listMessages/types.js'
import { authorizeWorkspaceMail } from '../inbox/workspaceAuthorization.js'
import { labelColors } from './colors.js'
import type { LabelCursor, LabelRepository, LabelTarget } from './types.js'

const base = '/api/v1/workspaces/:slug/mail'
const cursorSchema = z.strictObject({
  name: z
    .string()
    .max(100)
    .refine((value) => !value.includes('\0')),
  id: z.uuid(),
})

export function createLabelRoutes(
  repository: LabelRepository,
  resolveWorkspace: ResolveWorkspace,
  isAllowedOrigin: (origin: string) => boolean,
) {
  const app = new OpenAPIHono<MailEnvironment>()
  app.use(`${base}/*`, authorizeWorkspaceMail(resolveWorkspace))
  const error = (
    c: Parameters<typeof problemDetailsResponse>[0],
    status: 400 | 403 | 404 | 409,
    code: string,
    detail: string,
  ) =>
    problemDetailsResponse(c, {
      status,
      title:
        status === 400
          ? 'Bad Request'
          : status === 403
            ? 'Forbidden'
            : status === 404
              ? 'Not Found'
              : 'Conflict',
      code,
      detail,
    })
  app.get(`${base}/labels`, async (c) => {
    const query = (c.req.query('q') ?? '').trim()
    let cursor: LabelCursor | null = null
    try {
      const raw = c.req.query('cursor')
      if (raw !== undefined) {
        if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid cursor')
        const decoded = Buffer.from(raw, 'base64url')
        if (decoded.toString('base64url') !== raw) throw new Error('invalid cursor')
        cursor = cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
      }
      if (query.length > 100 || query.includes('\0')) throw new Error('invalid query')
    } catch {
      return error(c, 400, 'invalid_label_query', 'The label query or cursor is invalid.')
    }
    const result = await repository.searchLabels(c.get('workspaceId'), query, cursor)
    return c.json({
      ...result,
      nextCursor: result.nextCursor
        ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url')
        : null,
    })
  })
  app.get(`${base}/labels/palette`, async (c) =>
    c.json({
      colors: labelColors,
      suggestedColor: await repository.suggestColor(c.get('workspaceId')),
    }),
  )
  app.post(`${base}/labels`, async (c) => {
    if (!isAllowedOrigin(c.req.header('origin') ?? ''))
      return error(c, 403, 'untrusted_origin', 'A trusted Origin is required.')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return error(c, 400, 'invalid_label', 'A valid label name is required.')
    }
    const parsed = z
      .object({
        color: z.enum(labelColors).optional(),
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((name) => !name.includes('\0')),
      })
      .safeParse(body)
    if (!parsed.success)
      return error(c, 400, 'invalid_label', 'A valid label name and palette color are required.')
    const label = await repository.createLabel(
      c.get('workspaceId'),
      parsed.data.name,
      parsed.data.color,
    )
    if (!label) return error(c, 409, 'label_exists', 'A label with this name already exists.')
    return c.json(label, 201)
  })
  for (const target of ['messages', 'sent'] as const) {
    const path = `${base}/${target}/:messageId/labels`
    app.get(path, async (c) => {
      const id = c.req.param('messageId') ?? ''
      if (!z.uuid().safeParse(id).success) return c.notFound()
      const items = await repository.messageLabels(
        c.get('workspaceId'),
        c.get('authSession').user.id,
        target,
        id,
      )
      return items ? c.json({ items }) : c.notFound()
    })
    for (const method of ['put', 'delete'] as const)
      app[method](`${path}/:labelId`, async (c) => {
        if (!isAllowedOrigin(c.req.header('origin') ?? ''))
          return error(c, 403, 'untrusted_origin', 'A trusted Origin is required.')
        const id = c.req.param('messageId') ?? ''
        const labelId = c.req.param('labelId') ?? ''
        if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(labelId).success)
          return c.notFound()
        const items = await repository.changeMessageLabel(
          c.get('workspaceId'),
          c.get('authSession').user.id,
          target as LabelTarget,
          id,
          labelId,
          method === 'put',
        )
        return items ? c.json({ items }) : c.notFound()
      })
  }
  return app
}

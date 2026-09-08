import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ProblemDetailsInput = {
  type?: string
  title: string
  status: ContentfulStatusCode
  detail: string
  code: string
}

export function problemDetailsResponse(context: Context, problem: ProblemDetailsInput) {
  return context.json(
    {
      type: problem.type ?? 'about:blank',
      title: problem.title,
      status: problem.status,
      detail: problem.detail,
      instance: context.req.path,
      code: problem.code,
      requestId: context.get('requestId'),
    },
    problem.status,
    { 'Content-Type': 'application/problem+json' },
  )
}

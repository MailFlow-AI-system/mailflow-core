import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ProblemDetailsInput<Status extends ContentfulStatusCode = ContentfulStatusCode> = {
  type?: string
  title: string
  status: Status
  detail: string
  code: string
}

export function problemDetailsResponse<Status extends ContentfulStatusCode>(
  context: Context,
  problem: ProblemDetailsInput<Status>,
) {
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

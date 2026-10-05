import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ProblemDetailsInput } from './types/problemDetails.js'

export type { ProblemDetailsInput } from './types/problemDetails.js'

export function problemDetailsResponse<S extends ContentfulStatusCode>(
  context: Context,
  problem: ProblemDetailsInput<S>,
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

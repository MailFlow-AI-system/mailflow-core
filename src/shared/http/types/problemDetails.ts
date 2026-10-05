import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ProblemDetailsInput<S extends ContentfulStatusCode = ContentfulStatusCode> = {
  type?: string
  title: string
  status: S
  detail: string
  code: string
}

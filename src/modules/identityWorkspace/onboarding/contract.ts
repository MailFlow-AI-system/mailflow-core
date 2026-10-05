import { createRoute, z } from '@hono/zod-openapi'
import { idempotencyKeySchema, signupSchema } from './schemas.js'

const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
})
export const signupRoute = createRoute({
  method: 'post',
  path: '/api/v1/onboarding/signup',
  tags: ['Onboarding'],
  request: {
    headers: z.object({ 'idempotency-key': idempotencyKeySchema }),
    body: { required: true, content: { 'application/json': { schema: signupSchema } } },
  },
  responses: {
    202: {
      description: 'Account committed; verification delivery pending. No session is created.',
      content: {
        'application/json': { schema: z.object({ status: z.literal('verification-pending') }) },
      },
    },
    400: {
      description: 'Invalid signup request',
      content: { 'application/problem+json': { schema: problem } },
    },
    403: {
      description: 'Origin not allowed',
      content: { 'application/problem+json': { schema: problem } },
    },
    409: {
      description: 'Details unavailable or idempotency key reused with different input',
      content: { 'application/problem+json': { schema: problem } },
    },
    413: {
      description: 'Payload too large',
      content: { 'application/problem+json': { schema: problem } },
    },
    429: {
      description: 'Onboarding budget exceeded; Retry-After in seconds',
      content: { 'application/problem+json': { schema: problem } },
    },
    500: {
      description: 'Operational failure',
      content: { 'application/problem+json': { schema: problem } },
    },
  },
})

import { z } from '@hono/zod-openapi'
import { RESERVED_WORKSPACE_SLUGS } from './constants.js'

export const signupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
    password: z.string().min(8).max(128),
    workspaceName: z.string().trim().min(1).max(120),
    workspaceSlug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .refine((slug) => !RESERVED_WORKSPACE_SLUGS.has(slug), 'This subdomain is reserved'),
  })
  .strict()

export const idempotencyKeySchema = z.uuid()

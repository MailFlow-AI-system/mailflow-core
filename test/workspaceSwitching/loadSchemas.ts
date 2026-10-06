import { z } from 'zod'

export const loadFixtureSchema = z.object({
  host: z.string().regex(/^[a-z0-9-]+\.workspace\.test$/),
  email: z.email(),
  otherEmail: z.email(),
  password: z.string().min(1),
  controlKey: z.string().uuid(),
  currentId: z.string().min(1),
  unrelatedId: z.string().min(1),
  selections: z.number(),
  globalMailCalls: z.number(),
  preference: z.string().nullable(),
  hasActiveOrganization: z.boolean(),
})
export const loadSignInSchema = z.object({ user: z.object({ id: z.string().min(1) }) })
export const loadPageSchema = z.object({ items: z.array(z.object({ id: z.string() })) })

import { sql } from 'drizzle-orm'
import { check, index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { authUser } from './auth/user.js'
import { identityWorkspaceSchema as schema } from './identityWorkspace.js'
import { workspace } from './workspace.js'

export const onboardingSignup = schema.table(
  'onboarding_signup',
  {
    keyHash: text('key_hash').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('onboarding_signup_user_unique').on(table.userId),
    uniqueIndex('onboarding_signup_workspace_unique').on(table.organizationId),
    check(
      'onboarding_signup_hashes',
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$' and ${table.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
)

export const onboardingEmail = schema.table(
  'onboarding_email',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: text('payload'),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('onboarding_email_pending').on(table.state, table.availableAt),
    check('onboarding_email_kind', sql`${table.kind} in ('verification-otp', 'verified-welcome')`),
    check(
      'onboarding_email_state',
      sql`${table.state} in ('pending', 'leased', 'sent', 'expired')`,
    ),
    check('onboarding_email_attempts', sql`${table.attempts} between 0 and 5`),
  ],
)

import { sql } from 'drizzle-orm'
import { check, index, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { authUser } from './auth/user.js'
import { identityWorkspaceSchema as schema } from './identityWorkspace.js'

export const workspace = schema.table(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workspace_slug_unique').on(table.slug),
    check(
      'workspace_slug_dns_safe',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) <= 63`,
    ),
    check('workspace_name_present', sql`length(trim(${table.name})) between 1 and 120`),
  ],
)

export const workspaceMember = schema.table(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workspace_member_unique').on(table.organizationId, table.userId),
    uniqueIndex('workspace_one_owner').on(table.organizationId).where(sql`${table.role} = 'owner'`),
    index('workspace_member_user').on(table.userId),
    check('workspace_member_role', sql`${table.role} in ('owner', 'admin', 'member')`),
  ],
)

// Required by Organization even though invitations are not exposed by this feature.
export const workspaceInvitation = schema.table('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => authUser.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

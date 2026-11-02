import { sql } from 'drizzle-orm'
import { check, foreignKey, index, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core'
import { memberRoles } from '../../../authorization/roles.js'
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

// Custom roles are modeled but not managed yet: no code writes this table, and the runtime role has
// no write policy. A member points at one through `custom_role_id`.
export const workspaceRole = schema.table(
  'workspace_role',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    capabilities: text('capabilities').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // Lets `member` reference a role together with its organization, so a role can never be
    // attached to a member of another workspace.
    unique('workspace_role_organization_id_unique').on(table.organizationId, table.id),
    uniqueIndex('workspace_role_name_unique').on(table.organizationId, sql`lower(${table.name})`),
    check('workspace_role_name_present', sql`length(trim(${table.name})) between 1 and 80`),
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
    customRoleId: text('custom_role_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workspace_member_unique').on(table.organizationId, table.userId),
    uniqueIndex('workspace_one_owner').on(table.organizationId).where(sql`${table.role} = 'owner'`),
    index('workspace_member_user').on(table.userId),
    foreignKey({
      name: 'member_custom_role_same_organization_fk',
      columns: [table.organizationId, table.customRoleId],
      foreignColumns: [workspaceRole.organizationId, workspaceRole.id],
    }),
    check(
      'workspace_member_role',
      sql`${table.role} in (${sql.join(
        memberRoles.map((role) => sql.raw(`'${role}'`)),
        sql`, `,
      )})`,
    ),
    check(
      'workspace_member_custom_role',
      sql`(${table.role} = 'custom') = (${table.customRoleId} is not null)`,
    ),
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

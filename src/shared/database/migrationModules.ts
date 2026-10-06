export type MigrationModule = {
  readonly name: string
  readonly folder: string
  readonly schema: string
}

export const migrationTable = '__drizzle_migrations'

export const migrationModules = [
  {
    name: 'identity-workspace',
    folder: 'identityWorkspace',
    schema: 'identity_workspace_migrations',
  },
  { name: 'mail', folder: 'mail', schema: 'mail_migrations' },
] as const satisfies readonly MigrationModule[]

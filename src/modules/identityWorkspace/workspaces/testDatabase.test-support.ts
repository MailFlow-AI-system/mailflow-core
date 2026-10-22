// Matches compose.yaml and the CI database service; the variable only overrides it.
const localTestDatabaseUrl = 'postgresql://mailflow:mailflow@localhost:5432/mailflow'

export function workspaceTestDatabaseUrl(environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(environment.MAILFLOW_WORKSPACE_TEST_DATABASE_URL || localTestDatabaseUrl)
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Workspace tests require a disposable local PostgreSQL database')
  }
  return url.href
}

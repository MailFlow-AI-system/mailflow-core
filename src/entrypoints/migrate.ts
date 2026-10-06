import { migrationFailureMetadata } from '../shared/database/migrationFailure.js'
import { runMigrations } from '../shared/database/migrations.js'

let stage: 'setup' | 'migration' | 'cleanup' = 'setup'
let module: string | undefined

// Bound the whole command below Railway's 300-second pre-deploy timeout.
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ message: 'Migration execution timed out' }))
  process.exit(1)
}, 280_000)
deadline.unref()

try {
  await runMigrations(process.env, process.argv.slice(2), (message, context) => {
    module = context.module
    stage = message === 'Migration started' ? 'migration' : 'cleanup'
    console.info(JSON.stringify({ message, ...context }))
  })
} catch (error) {
  console.error(
    JSON.stringify({
      message:
        'Migration execution failed; verify DIRECT_URL, target, migration files, and database',
      ...migrationFailureMetadata(error),
      stage,
      ...(module ? { module } : {}),
    }),
  )
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
}

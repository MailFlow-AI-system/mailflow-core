import { runMigrations } from '../shared/database/migrations.js'

// Bound the whole command below Railway's 300-second pre-deploy timeout.
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ message: 'Migration execution timed out' }))
  process.exit(1)
}, 280_000)
deadline.unref()

try {
  await runMigrations(process.env, process.argv.slice(2), (message, context) => {
    console.info(JSON.stringify({ message, ...context }))
  })
} catch (error) {
  const failure = error as { name?: unknown; code?: unknown }
  console.error(
    JSON.stringify({
      message:
        'Migration execution failed; verify DIRECT_URL, target, migration files, and database',
      errorName: typeof failure?.name === 'string' ? failure.name : 'Error',
      ...(typeof failure?.code === 'string' ? { errorCode: failure.code } : {}),
    }),
  )
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
}

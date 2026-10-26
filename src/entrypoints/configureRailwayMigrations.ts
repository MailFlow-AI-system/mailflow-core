import { configureRailwayMigrations } from '../shared/deployment/railwayMigrations.js'

try {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--apply'))
    throw new Error('Use --apply, or no arguments for a read-only check')
  const results = await configureRailwayMigrations({
    token: process.env.RAILWAY_API_TOKEN ?? '',
    apply: args[0] === '--apply',
  })
  for (const result of results) console.info(JSON.stringify(result))
  if (results.some(({ configured }) => !configured)) process.exitCode = 1
} catch (error) {
  console.error(
    error instanceof Error &&
      /^(RAILWAY_API_TOKEN|Use --apply|Unexpected API destination|Railway verification)/.test(
        error.message,
      )
      ? error.message
      : 'Railway migration policy failed; check authentication, permissions, and destinations',
  )
  process.exitCode = 1
}

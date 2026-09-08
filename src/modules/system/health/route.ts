import { OpenAPIHono } from '@hono/zod-openapi'

import { liveHealthRoute, readyHealthRoute } from './contract.js'

type HealthDependencies = {
  checkDatabase: () => Promise<void>
}

export function createHealthModule({ checkDatabase }: HealthDependencies) {
  const app = new OpenAPIHono()

  app.openapi(liveHealthRoute, (context) => context.json({ status: 'ok' }, 200))
  app.openapi(readyHealthRoute, async (context) => {
    try {
      await checkDatabase()

      return context.json({ status: 'ready', checks: { database: 'up' } }, 200)
    } catch {
      return context.json({ status: 'not_ready', checks: { database: 'down' } }, 503)
    }
  })

  return app
}

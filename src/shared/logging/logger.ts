import pino from 'pino'

import type { AppConfig } from '#shared/config/env'

export function createLogger(config: AppConfig) {
  return pino({
    name: 'mailflow-core',
    level: config.logLevel,
    base: {
      service: 'mailflow-core',
      environment: config.appEnv,
      version: config.serviceVersion,
    },
  })
}

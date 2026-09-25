import { hostname } from 'node:os'

import { z } from 'zod'

const rawConfigSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_DOCS_ENABLED: z.enum(['true', 'false']).optional(),
  SERVICE_VERSION: z.string().min(1).default('development'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_SERVICE_INSTANCE_ID: z.string().min(1).optional(),
})

export type AppConfig = {
  appEnv: z.infer<typeof rawConfigSchema>['APP_ENV']
  databaseUrl: string
  host: string
  port: number
  logLevel: z.infer<typeof rawConfigSchema>['LOG_LEVEL']
  apiDocsEnabled: boolean
  serviceVersion: string
  otlpEndpoint: string | undefined
  otelTraceSampleRate: number
  serviceInstanceId: string
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const config = rawConfigSchema.parse(environment)

  return {
    appEnv: config.APP_ENV,
    databaseUrl: config.DATABASE_URL,
    host: config.HOST,
    port: config.PORT,
    logLevel: config.LOG_LEVEL,
    apiDocsEnabled:
      config.API_DOCS_ENABLED === undefined
        ? config.APP_ENV !== 'production'
        : config.API_DOCS_ENABLED === 'true',
    serviceVersion: config.SERVICE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelTraceSampleRate: config.OTEL_TRACE_SAMPLE_RATE,
    serviceInstanceId: config.OTEL_SERVICE_INSTANCE_ID ?? `${hostname()}-${process.pid}`,
  }
}

import { type Meter, metrics, type Tracer, trace } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'

import type { AppConfig } from '#shared/config/env'
import { registerRuntimeMetrics } from './workerMetrics.js'

const telemetryVersion = '1.0.0'
const defaultShutdownTimeoutMs = 5_000

export type Observability = {
  enabled: boolean
  meter: Meter
  serviceName: string
  tracer: Tracer
  shutdown: (timeoutMs?: number) => Promise<void>
}

export function createResourceAttributes(
  config: AppConfig,
  serviceName: string,
): Record<string, string> {
  return {
    'service.name': serviceName,
    'service.version': config.serviceVersion,
    'deployment.environment.name': config.appEnv,
    'service.instance.id': config.serviceInstanceId,
  }
}

export async function startObservability(
  config: AppConfig,
  serviceName: string,
): Promise<Observability> {
  if (config.otlpEndpoint === undefined) {
    return createNoopObservability(serviceName)
  }

  const endpoint = config.otlpEndpoint.replace(/\/$/, '')
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes(createResourceAttributes(config, serviceName)),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
        }),
        exportIntervalMillis: 10_000,
        exportTimeoutMillis: 5_000,
      }),
    ],
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.otelTraceSampleRate),
    }),
  })

  sdk.start()

  const registeredMeter = metrics.getMeter(serviceName, telemetryVersion)
  registerRuntimeMetrics(registeredMeter)

  return {
    enabled: true,
    meter: registeredMeter,
    serviceName,
    tracer: trace.getTracer(serviceName, telemetryVersion),
    shutdown: () => shutdownWithTimeout(() => sdk.shutdown(), defaultShutdownTimeoutMs),
  }
}

export function createNoopObservability(serviceName: string): Observability {
  return {
    enabled: false,
    meter: metrics.getMeter(serviceName, telemetryVersion),
    serviceName,
    tracer: trace.getTracer(serviceName, telemetryVersion),
    shutdown: async () => undefined,
  }
}

async function shutdownWithTimeout(
  shutdown: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined

  try {
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs)
        timeoutHandle.unref()
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }
}

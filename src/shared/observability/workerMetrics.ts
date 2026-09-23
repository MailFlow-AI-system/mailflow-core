import type { Meter } from '@opentelemetry/api'

export function createWorkerLifecycleMetrics(meter: Meter) {
  const lifecycle = meter.createCounter('mailflow.worker.lifecycle.count', {
    description: 'Worker lifecycle transitions.',
    unit: '{transition}',
  })
  const activity = meter.createCounter('mailflow.worker.activity.count', {
    description: 'Worker activity transitions.',
    unit: '{activity}',
  })

  return {
    started() {
      lifecycle.add(1, { state: 'started' })
      activity.add(1, { activity: 'startup' })
    },
    stopped() {
      lifecycle.add(1, { state: 'stopped' })
    },
  }
}

export function registerRuntimeMetrics(meter: Meter): void {
  const memoryUsage = meter.createObservableGauge('process.runtime.memory.usage', {
    description: 'Resident process memory in bytes.',
    unit: 'By',
  })
  memoryUsage.addCallback((result) => {
    result.observe(process.memoryUsage().rss)
  })

  const uptime = meter.createObservableGauge('process.runtime.uptime', {
    description: 'Process uptime in seconds.',
    unit: 's',
  })
  uptime.addCallback((result) => {
    result.observe(process.uptime())
  })
}

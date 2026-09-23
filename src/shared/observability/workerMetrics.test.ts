import { describe, expect, it, vi } from 'vitest'

import { createWorkerLifecycleMetrics, registerRuntimeMetrics } from './workerMetrics.js'

describe('worker and runtime metrics', () => {
  it('records startup and shutdown once each', () => {
    const lifecycleAdd = vi.fn()
    const meter = {
      createCounter: vi.fn(() => ({ add: lifecycleAdd })),
      createObservableGauge: vi.fn(() => ({ addCallback: vi.fn() })),
    }
    const lifecycle = createWorkerLifecycleMetrics(meter as never)

    lifecycle.started()
    lifecycle.stopped()

    expect(lifecycleAdd).toHaveBeenNthCalledWith(1, 1, { state: 'started' })
    expect(lifecycleAdd).toHaveBeenNthCalledWith(2, 1, { state: 'stopped' })
    expect(meter.createCounter).toHaveBeenCalledOnce()
    expect(meter.createCounter).toHaveBeenCalledWith('mailflow.worker.lifecycle.count', {
      description: 'Worker lifecycle transitions.',
      unit: '{transition}',
    })
  })

  it('observes resident memory and uptime in their declared units', () => {
    const callbacks = new Map<string, (result: { observe: (value: number) => void }) => void>()
    const meter = {
      createObservableGauge: vi.fn((name: string) => ({
        addCallback: (callback: (result: { observe: (value: number) => void }) => void) => {
          callbacks.set(name, callback)
        },
      })),
    }
    const memoryUsage = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 123_456,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    })
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(42)

    try {
      registerRuntimeMetrics(meter as never)

      const observedMemory = vi.fn()
      const observedUptime = vi.fn()
      callbacks.get('process.runtime.memory.usage')?.({ observe: observedMemory })
      callbacks.get('process.runtime.uptime')?.({ observe: observedUptime })

      expect(meter.createObservableGauge).toHaveBeenCalledWith('process.runtime.memory.usage', {
        description: 'Resident process memory in bytes.',
        unit: 'By',
      })
      expect(meter.createObservableGauge).toHaveBeenCalledWith('process.runtime.uptime', {
        description: 'Process uptime in seconds.',
        unit: 's',
      })
      expect(observedMemory).toHaveBeenCalledWith(123_456)
      expect(observedUptime).toHaveBeenCalledWith(42)
    } finally {
      memoryUsage.mockRestore()
      uptime.mockRestore()
    }
  })
})

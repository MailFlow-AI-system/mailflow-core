import { describe, expect, it, vi } from 'vitest'

import { createWorkerLifecycleMetrics, registerRuntimeMetrics } from './workerMetrics.js'

describe('worker and runtime metrics', () => {
  it('records startup and shutdown without inventing queue metrics', () => {
    const lifecycleAdd = vi.fn()
    const activityAdd = vi.fn()
    let counterIndex = 0
    const meter = {
      createCounter: vi.fn(() => ({
        add: counterIndex++ === 0 ? lifecycleAdd : activityAdd,
      })),
      createObservableGauge: vi.fn(() => ({ addCallback: vi.fn() })),
    }
    const lifecycle = createWorkerLifecycleMetrics(meter as never)

    lifecycle.started()
    lifecycle.stopped()

    expect(lifecycleAdd).toHaveBeenNthCalledWith(1, 1, { state: 'started' })
    expect(lifecycleAdd).toHaveBeenNthCalledWith(2, 1, { state: 'stopped' })
    expect(activityAdd).toHaveBeenCalledWith(1, { activity: 'startup' })
    expect(meter.createCounter).toHaveBeenCalledWith(
      'mailflow.worker.lifecycle.count',
      expect.any(Object),
    )
    expect(meter.createCounter).toHaveBeenCalledWith(
      'mailflow.worker.activity.count',
      expect.any(Object),
    )
    expect(meter.createCounter).not.toHaveBeenCalledWith(
      expect.stringMatching(/queue|retry|dlq/i),
      expect.anything(),
    )
  })

  it('registers process/runtime instruments from bounded callbacks', () => {
    const addCallback = vi.fn()
    const meter = {
      createObservableGauge: vi.fn(() => ({ addCallback })),
    }

    registerRuntimeMetrics(meter as never)

    expect(meter.createObservableGauge).toHaveBeenCalledWith(
      'process.runtime.memory.usage',
      expect.any(Object),
    )
    expect(meter.createObservableGauge).toHaveBeenCalledWith(
      'process.runtime.uptime',
      expect.any(Object),
    )
    expect(addCallback).toHaveBeenCalledTimes(2)
  })
})

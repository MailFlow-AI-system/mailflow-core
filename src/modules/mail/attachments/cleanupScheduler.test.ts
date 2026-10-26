import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAttachmentCleanupScheduler } from './cleanupScheduler.js'

const hour = 60 * 60 * 1000
const dependencies = () => ({
  cleanupBatch: vi.fn(async () => 0),
  cleanupPage: vi.fn(
    async (_cursor?: string): Promise<{ deleted: number; nextCursor?: string }> => ({ deleted: 0 }),
  ),
  reportSummary: vi.fn(),
  reportFailure: vi.fn(),
})

afterEach(() => vi.useRealTimers())

describe('attachment cleanup scheduler', () => {
  it('starts asynchronously, releases the interval reference, and reports only counts', async () => {
    vi.useFakeTimers()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const work = dependencies()
    const stop = startAttachmentCleanupScheduler(work)
    expect(work.cleanupBatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(work.cleanupBatch).toHaveBeenCalledTimes(1)
    expect(work.cleanupPage).toHaveBeenCalledWith(undefined)
    expect(work.reportSummary).toHaveBeenCalledWith({ metadataDeleted: 0, orphanObjectsDeleted: 0 })
    expect(interval.mock.results[0]?.value.hasRef()).toBe(false)
    await stop()
  })

  it('caps each run and continues object pagination on the next hourly tick', async () => {
    vi.useFakeTimers()
    const work = dependencies()
    work.cleanupBatch.mockResolvedValue(100)
    work.cleanupPage.mockImplementation(async (cursor) => ({
      deleted: 1,
      nextCursor: String(Number(cursor ?? 0) + 1),
    }))
    const stop = startAttachmentCleanupScheduler(work)
    await vi.advanceTimersByTimeAsync(0)
    expect(work.cleanupBatch).toHaveBeenCalledTimes(10)
    expect(work.cleanupPage).toHaveBeenCalledTimes(10)
    expect(work.reportSummary).toHaveBeenCalledWith({
      metadataDeleted: 1000,
      orphanObjectsDeleted: 10,
    })
    await vi.advanceTimersByTimeAsync(hour)
    expect(work.cleanupBatch).toHaveBeenCalledTimes(20)
    expect(work.cleanupPage.mock.calls[10]).toEqual(['10'])
    await stop()
  })

  it('prevents overlapping runs and waits for current work without starting another batch on shutdown', async () => {
    vi.useFakeTimers()
    const work = dependencies()
    let finish: (deleted: number) => void = () => {}
    work.cleanupBatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const stop = startAttachmentCleanupScheduler(work)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2 * hour)
    expect(work.cleanupBatch).toHaveBeenCalledTimes(1)
    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finish(100)
    await stopping
    expect(work.cleanupBatch).toHaveBeenCalledTimes(1)
    expect(work.cleanupPage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(hour)
    expect(work.cleanupBatch).toHaveBeenCalledTimes(1)
  })

  it('contains failures without exposing storage details and retries the same failed page', async () => {
    vi.useFakeTimers()
    const work = dependencies()
    work.cleanupBatch.mockRejectedValueOnce(new Error('secret object key'))
    work.cleanupPage
      .mockResolvedValueOnce({ deleted: 2, nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('secret object key'))
    const stop = startAttachmentCleanupScheduler(work)
    await vi.advanceTimersByTimeAsync(0)
    expect(work.reportFailure.mock.calls).toEqual([['metadata'], ['objects']])
    await vi.advanceTimersByTimeAsync(hour)
    expect(work.cleanupPage.mock.calls[2]).toEqual(['next'])
    expect(work.reportSummary).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('cancels the queued startup run if shutdown starts immediately', async () => {
    vi.useFakeTimers()
    const work = dependencies()
    const stop = startAttachmentCleanupScheduler(work)
    await stop()
    await vi.advanceTimersByTimeAsync(hour)
    expect(work.cleanupBatch).not.toHaveBeenCalled()
    expect(work.cleanupPage).not.toHaveBeenCalled()
  })
})

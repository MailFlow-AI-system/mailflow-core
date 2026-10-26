type CleanupSummary = { metadataDeleted: number; orphanObjectsDeleted: number }

export function startAttachmentCleanupScheduler({
  cleanupBatch,
  cleanupPage,
  reportSummary,
  reportFailure,
}: {
  cleanupBatch: () => Promise<number>
  cleanupPage: (cursor?: string) => Promise<{ deleted: number; nextCursor?: string | undefined }>
  reportSummary: (summary: CleanupSummary) => void
  reportFailure: (phase: 'metadata' | 'objects') => void
}) {
  let stopped = false
  let running: Promise<void> | undefined
  let cursor: string | undefined

  async function run() {
    const summary = { metadataDeleted: 0, orphanObjectsDeleted: 0 }
    try {
      for (let batch = 0; batch < 10 && !stopped; batch++) {
        const deleted = await cleanupBatch()
        summary.metadataDeleted += deleted
        if (deleted < 100) break
      }
    } catch {
      reportFailure('metadata')
    }
    try {
      for (let page = 0; page < 10 && !stopped; page++) {
        const result = await cleanupPage(cursor)
        summary.orphanObjectsDeleted += result.deleted
        cursor = result.nextCursor
        if (!cursor) break
      }
    } catch {
      reportFailure('objects')
    }
    reportSummary(summary)
  }

  function tick() {
    if (stopped || running) return
    running = run().finally(() => {
      running = undefined
    })
  }

  const interval = setInterval(tick, 60 * 60 * 1000)
  interval.unref()
  queueMicrotask(tick)

  return async function stop() {
    stopped = true
    clearInterval(interval)
    await running
  }
}

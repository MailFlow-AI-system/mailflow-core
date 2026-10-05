import { setTimeout as pause } from 'node:timers/promises'
import type { OnboardingWorkerDependencies } from './types.js'

export async function runOnboardingWorker({
  dispatch,
  signal,
  report,
}: OnboardingWorkerDependencies) {
  while (!signal.aborted) {
    try {
      report(await dispatch())
    } catch {
      report('failed')
    }
    if (!signal.aborted) await pause(1000, undefined, { signal }).catch(() => {})
  }
}

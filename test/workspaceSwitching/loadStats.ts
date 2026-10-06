import type { HttpLoadSample } from './loadTypes.js'

export function summarizeLoad(samples: HttpLoadSample[]) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
  return {
    requests: samples.length,
    accepted: samples.filter((sample) => sample.status === 200).length,
    limited: samples.filter((sample) => sample.status === 429).length,
    unexpected: samples.filter((sample) => ![200, 429].includes(sample.status)).length,
    p50Ms: durations[Math.ceil(durations.length * 0.5) - 1] ?? 0,
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1] ?? 0,
    maxMs: durations.at(-1) ?? 0,
  }
}

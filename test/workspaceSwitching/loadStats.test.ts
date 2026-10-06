import { expect, it } from 'vitest'
import { summarizeLoad } from './loadStats.js'

it('summarizes bounded samples without keeping response bodies or identity data', () => {
  expect(
    summarizeLoad([
      { status: 200, durationMs: 10 },
      { status: 429, durationMs: 30 },
      { status: 200, durationMs: 20 },
    ]),
  ).toEqual({
    requests: 3,
    accepted: 2,
    limited: 1,
    unexpected: 0,
    p50Ms: 20,
    p95Ms: 30,
    maxMs: 30,
  })
})

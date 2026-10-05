import { expect, it } from 'vitest'
import { uuidV7 } from './uuidV7.js'

it('generates UUIDv7 identifiers without changing existing Better Auth identities', () => {
  const before = Date.now()
  const id = uuidV7()
  const timestamp = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
  expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  expect(timestamp).toBeGreaterThanOrEqual(before)
  expect(timestamp).toBeLessThanOrEqual(Date.now())
  expect(new Set(Array.from({ length: 1000 }, uuidV7)).size).toBe(1000)
})

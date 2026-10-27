import { describe, expect, it } from 'vitest'
import { seedMailMessages } from './fixtures.js'
import { mailSeedId } from './seedMail.js'

describe('mail seed dataset', () => {
  it('uses deterministic UUID v5 ids scoped by workspace and fixture key', () => {
    const a = seedMailMessages.map((message) => mailSeedId('workspace-a', message.id))
    const b = seedMailMessages.map((message) => mailSeedId('workspace-b', message.id))
    expect(new Set([...a, ...b]).size).toBe(66)
    expect(a).toEqual(seedMailMessages.map((message) => mailSeedId('workspace-a', message.id)))
    expect(a[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(mailSeedId('a', 'bc')).not.toBe(mailSeedId('ab', 'c'))
  })

  it('contains 33 distinct realistic full messages with stable timestamps and ties', () => {
    expect(seedMailMessages).toHaveLength(33)
    expect(new Set(seedMailMessages.map((message) => message.id)).size).toBe(33)
    for (const message of seedMailMessages) {
      expect(message.id).toMatch(/^10000000-0000-4000-8000-\d{12}$/)
      expect(message.senderName.length).toBeGreaterThan(3)
      expect(message.subject.length).toBeGreaterThan(8)
      expect(message.body.split('\n\n').length).toBeGreaterThanOrEqual(3)
      expect(message.body.length).toBeGreaterThan(250)
      expect(message.receivedAt.toISOString()).toMatch(/^2026-09-/)
    }
    expect(new Set(seedMailMessages.map((message) => message.receivedAt.toISOString())).size).toBe(
      11,
    )
  })

  it('includes older full-body and literal wildcard search examples', () => {
    const oldest = seedMailMessages.at(-1)

    expect(oldest?.body.toLowerCase().indexOf('auroraledger')).toBeGreaterThan(320)
    expect(seedMailMessages.slice(0, 8).some((message) => /auroraledger/i.test(message.body))).toBe(
      false,
    )
    for (const character of ['%', '_', '\\']) {
      expect(seedMailMessages.some((message) => message.body.includes(character))).toBe(true)
    }
  })
})

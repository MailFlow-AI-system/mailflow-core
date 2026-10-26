import { describe, expect, it } from 'vitest'
import { validImageContent } from './imageValidation.js'

describe('inline image validation', () => {
  it('accepts real image signatures and rejects MIME mismatches', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    expect(validImageContent('image/png', png)).toBe(true)
    expect(validImageContent('image/jpeg', png)).toBe(false)
    expect(validImageContent('image/png', Buffer.from('text'))).toBe(false)
  })
})

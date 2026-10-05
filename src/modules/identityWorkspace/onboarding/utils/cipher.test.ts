import { describe, expect, it } from 'vitest'
import { createOnboardingCipher } from './cipher.js'

describe('protected onboarding email values', () => {
  const cipher = createOnboardingCipher('synthetic-onboarding-encryption-secret')
  it('uses authenticated, randomized encryption bound to the delivery identifier', () => {
    const payload = JSON.stringify({ otp: '123456', to: 'local@mailflow.invalid' })
    const protectedValue = cipher.seal(payload, 'delivery-A')
    expect(cipher.open(protectedValue, 'delivery-A')).toBe(payload)
    expect(cipher.seal(payload, 'delivery-A')).not.toBe(protectedValue)
    expect(protectedValue).not.toContain('123456')
    expect(() => cipher.open(protectedValue, 'delivery-B')).toThrow()
    expect(() =>
      createOnboardingCipher('another-secret').open(protectedValue, 'delivery-A'),
    ).toThrow()
    const [version, nonce, tag, body] = protectedValue.split('.')
    expect(() =>
      cipher.open(`${version}.${nonce}.${tag}.${body?.slice(1)}`, 'delivery-A'),
    ).toThrow()
    expect(() => cipher.open(`${protectedValue}.extra`, 'delivery-A')).toThrow()
  })
})

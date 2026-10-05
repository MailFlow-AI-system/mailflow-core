import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { OnboardingCipher } from '../types.js'

export function createOnboardingCipher(secret: string): OnboardingCipher {
  const key = Buffer.from(hkdfSync('sha256', secret, 'mailflow', 'onboarding-email-v1', 32))
  return {
    seal(value, scope) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(scope))
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [
        'v1',
        nonce.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.')
    },
    open(value, scope) {
      const [version, nonce, tag, encrypted, extra] = value.split('.')
      if (version !== 'v1' || !nonce || !tag || !encrypted || extra !== undefined) {
        throw new Error('Invalid protected email payload')
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'))
      decipher.setAAD(Buffer.from(scope))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}

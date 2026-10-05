import type { PoolClient } from 'pg'
import type { AccountEmailSender } from '../accountEmails/index.js'
import { VERIFICATION_LIFETIME_SECONDS } from './constants.js'
import type { OnboardingCipher } from './types.js'
import { uuidV7 } from './utils/uuidV7.js'

export function createOnboardingEnqueue(
  client: PoolClient,
  userId: string,
  cipher: OnboardingCipher,
): AccountEmailSender {
  return async (message) => {
    if (message.kind === 'password-reset')
      throw new Error('Password recovery is not an onboarding job')
    if (message.kind === 'verification-otp')
      await client.query(
        `update identity_workspace.onboarding_email set state = 'expired', payload = null
      where user_id = $1 and kind = 'verification-otp' and state = 'pending'`,
        [userId],
      )
    const id = uuidV7()
    const lifetime =
      message.kind === 'verification-otp' ? VERIFICATION_LIFETIME_SECONDS : 24 * 60 * 60
    await client.query(
      `insert into identity_workspace.onboarding_email (id, user_id, kind, payload, expires_at)
      values ($1, $2, $3, $4, now() + $5 * interval '1 second')`,
      [id, userId, message.kind, cipher.seal(JSON.stringify(message), id), lifetime],
    )
  }
}

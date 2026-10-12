import { createHash, createHmac } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuthConfig } from '../infrastructure/auth/authConfig.js'
import { createOnboardingEnqueue } from './enqueueEmail.js'
import { SignupConflict } from './errors.js'
import { idempotencyKeySchema, signupSchema } from './schemas.js'
import { createSignupActions } from './signupActions.js'
import { inOnboardingTransaction } from './transaction.js'
import type {
  OnboardingService,
  SignupActionsFactory,
  SignupReceipt,
  SignupResult,
} from './types.js'
import { createOnboardingCipher } from './utils/cipher.js'
import { isSignupConflictCause } from './utils/signupConflict.js'
import { uuidV7 } from './utils/uuidV7.js'

export function createOnboardingService(
  pool: Pool,
  config: AuthConfig,
  actionsFactory: SignupActionsFactory = createSignupActions,
): OnboardingService {
  const cipher = createOnboardingCipher(config.secret)
  return {
    async signup(value, idempotencyKey) {
      const input = signupSchema.parse(value)
      const key = idempotencyKeySchema.parse(idempotencyKey)
      const keyHash = createHash('sha256').update(key).digest('hex')
      const fingerprint = createHmac('sha256', config.secret)
        .update(JSON.stringify(input))
        .digest('hex')
      return inOnboardingTransaction<SignupResult>(pool, async (client) => {
        await client.query("select set_config('mailflow.onboarding_key', $1, true)", [keyHash])
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [keyHash])
        const receipt = await client.query<SignupReceipt>(
          'select fingerprint, user_id, organization_id from identity_workspace.onboarding_signup where key_hash = $1',
          [keyHash],
        )
        if (receipt.rows[0]) {
          if (receipt.rows[0].fingerprint !== fingerprint) throw new SignupConflict()
          return { status: 'verification-pending' }
        }
        const existing = await client.query(
          'select id from identity_workspace."user" where email = $1',
          [input.email],
        )
        if (existing.rowCount) throw new SignupConflict()
        const ids = { userId: uuidV7(), workspaceId: uuidV7() }
        await client.query(
          "select set_config('mailflow.user_id', $1, true), set_config('mailflow.onboarding_workspace', $2, true)",
          [ids.userId, ids.workspaceId],
        )
        await client.query(
          'insert into identity_workspace.onboarding_signup (key_hash, fingerprint, user_id, organization_id) values ($1, $2, $3, $4)',
          [keyHash, fingerprint, ids.userId, ids.workspaceId],
        )
        const actions = actionsFactory(
          client,
          config,
          createOnboardingEnqueue(client, ids.userId, cipher),
          ids,
          cipher,
        )
        await actions.register(input)
        await actions.provision(input)
        return { status: 'verification-pending' }
      }).catch((error: unknown) => {
        if (isSignupConflictCause(error)) throw new SignupConflict()
        throw error
      })
    },
  }
}

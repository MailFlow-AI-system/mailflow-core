import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { inOnboardingTransaction } from './transaction.js'
import type { DeliveryDependencies, DeliveryOutcome, EmailJob } from './types.js'

const messageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('verification-otp'),
    to: z.email(),
    otp: z.string().regex(/^\d{6}$/),
  }),
  z.object({
    kind: z.literal('verified-welcome'),
    to: z.email(),
    name: z.string(),
    userId: z.string(),
    loginUrl: z.url(),
  }),
])

export function createOnboardingDispatcher({ pool, cipher, send }: DeliveryDependencies) {
  return async (jobId?: string): Promise<DeliveryOutcome> => {
    const job = await inOnboardingTransaction(pool, async (client) => {
      await client.query("select set_config('mailflow.onboarding_delivery', 'enabled', true)")
      await client.query(`delete from identity_workspace.verification where id in (
        select id from identity_workspace.verification where identifier like 'email-verification-otp-%'
        and value like 'v1.%' and expires_at <= now() limit 100)`)
      await client.query(
        `update identity_workspace.onboarding_email set state = 'expired', payload = null, lease_token = null, lease_until = null
        where id in (select id from identity_workspace.onboarding_email
          where state in ('pending', 'leased') and (expires_at <= now() or attempts >= 5)
          and (lease_until is null or lease_until <= now()) and ($1::text is null or id = $1)
          limit 100 for update skip locked)`,
        [jobId ?? null],
      )
      const claimed = await client.query<EmailJob>(
        `update identity_workspace.onboarding_email set state = 'leased', attempts = attempts + 1,
        lease_token = $1, lease_until = now() + interval '60 seconds'
        where id = (select id from identity_workspace.onboarding_email
          where (state = 'pending' or (state = 'leased' and lease_until <= now()))
          and available_at <= now() and expires_at > now() and attempts < 5 and payload is not null
          and ($2::text is null or id = $2) order by available_at, id limit 1 for update skip locked)
        returning id, user_id, kind, payload, attempts, lease_token`,
        [randomUUID(), jobId ?? null],
      )
      return claimed.rows[0]
    })
    if (!job) return 'idle'
    let sent = false
    try {
      const message = messageSchema.parse(JSON.parse(cipher.open(job.payload, job.id)))
      if (
        message.kind !== job.kind ||
        (message.kind === 'verified-welcome' && message.userId !== job.user_id)
      )
        throw new Error('Invalid queued delivery')
      // No DB transaction is held during the external effect. Retrying uses the
      // exact same payload/key, including after an uncertain provider response.
      await send(message, { idempotencyKey: `onboarding-email/${job.id}` })
      sent = true
    } catch {
      /* The stored job, not signup, owns bounded delivery recovery. */
    }
    const changed = await inOnboardingTransaction(pool, async (client) => {
      await client.query("select set_config('mailflow.onboarding_delivery', 'enabled', true)")
      return client.query(
        `update identity_workspace.onboarding_email set
        state = case when $3 then 'sent' when attempts >= 5 or expires_at <= now() then 'expired' else 'pending' end,
        payload = case when $3 or attempts >= 5 or expires_at <= now() then null else payload end,
        available_at = now() + least(60, power(2, attempts)::int) * interval '1 second',
        lease_token = null, lease_until = null
        where id = $1 and lease_token = $2 and state = 'leased' returning state`,
        [job.id, job.lease_token, sent],
      )
    })
    const state = changed.rows[0]?.state
    return state === 'sent'
      ? 'sent'
      : state === 'pending'
        ? 'retry'
        : state === 'expired'
          ? 'expired'
          : 'lost'
  }
}

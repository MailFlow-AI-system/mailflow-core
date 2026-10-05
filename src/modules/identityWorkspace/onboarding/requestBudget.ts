import { createHmac } from 'node:crypto'
import type { Pool } from 'pg'
import type { OnboardingBudgetKind, OnboardingBudgetRow } from './types.js'
import { uuidV7 } from './utils/uuidV7.js'

const limits = {
  signup: { global: 30, email: 3 },
  'otp-send': { global: 60, email: 3 },
  'otp-verify': { global: 180, email: 5 },
}

export function createOnboardingBudget(
  pool: Pool,
  secret: string,
  kind: OnboardingBudgetKind = 'signup',
) {
  const consume = async (key: string, maximum: number) => {
    const result = await pool.query<OnboardingBudgetRow>(
      `insert into identity_workspace.rate_limit (id, key, count, last_request)
      values ($1, $2, 1, $3) on conflict (key) do update set
      count = case when identity_workspace.rate_limit.last_request <= $3 - 60000 then 1 else least(identity_workspace.rate_limit.count + 1, $4 + 1) end,
      last_request = case when identity_workspace.rate_limit.last_request <= $3 - 60000 then $3 else identity_workspace.rate_limit.last_request end
      returning count, last_request`,
      [uuidV7(), key, Date.now(), maximum],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Missing onboarding request budget')
    return row.count <= maximum
      ? 0
      : Math.max(1, Math.ceil((Number(row.last_request) + 60000 - Date.now()) / 1000))
  }
  return async (email: string) => {
    const globalWait = await consume(`workspace-onboarding:${kind}:global`, limits[kind].global)
    if (globalWait) return globalWait
    return consume(
      `workspace-onboarding:${kind}:email:${createHmac('sha256', secret).update(email).digest('hex')}`,
      limits[kind].email,
    )
  }
}

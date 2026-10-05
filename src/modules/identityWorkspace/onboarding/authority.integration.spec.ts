import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createWorkspaceTestFixture } from '../workspaces/fixtures.test-support.js'
import { assertOnboardingDatabaseRole } from './databaseRole.js'
import { createOnboardingBudget } from './requestBudget.js'
import { inOnboardingTransaction } from './transaction.js'

let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
beforeAll(async () => {
  fixture = await createWorkspaceTestFixture()
}, 30000)
afterAll(async () => {
  if (fixture) await fixture.close()
})

it('accounts for concurrent OTP budget requests atomically without storing the email', async () => {
  const email = `budget-${randomUUID()}@mailflow.invalid`
  const key = `workspace-onboarding:otp-verify:email:${createHmac('sha256', fixture.authConfig.secret).update(email).digest('hex')}`
  const consume = createOnboardingBudget(fixture.pool, fixture.authConfig.secret, 'otp-verify')
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(email)))
    expect(results.filter((wait) => wait === 0)).toHaveLength(5)
    expect(results.filter((wait) => wait > 0 && wait <= 60)).toHaveLength(5)
    const stored = await fixture.admin.query(
      'select key, count from identity_workspace.rate_limit where key = $1',
      [key],
    )
    expect(stored.rows[0]).toMatchObject({ key, count: 6 })
    expect(stored.rows[0].key).not.toContain(email)
  } finally {
    await fixture.admin.query('delete from identity_workspace.rate_limit where key = $1', [key])
  }
})

it('denies forged provisioning and confines the worker capability to delivery data', async () => {
  await assertOnboardingDatabaseRole(fixture.pool)
  await expect(assertOnboardingDatabaseRole(fixture.admin)).rejects.toThrow('non-owner')
  await expect(
    inOnboardingTransaction(fixture.pool, async (client) => {
      const workspaceId = randomUUID()
      await client.query(
        "select set_config('mailflow.onboarding_key', $1, true), set_config('mailflow.user_id', $2, true), set_config('mailflow.onboarding_workspace', $3, true)",
        ['a'.repeat(64), fixture.userId, workspaceId],
      )
      await client.query(
        'insert into identity_workspace.onboarding_signup (key_hash, fingerprint, user_id, organization_id) values ($1,$2,$3,$4)',
        ['a'.repeat(64), 'b'.repeat(64), fixture.userId, workspaceId],
      )
    }),
  ).rejects.toMatchObject({ code: '42501' })
  await inOnboardingTransaction(fixture.pool, async (client) => {
    await client.query("select set_config('mailflow.onboarding_delivery', 'enabled', true)")
    expect((await client.query('select * from identity_workspace.organization')).rows).toEqual([])
    expect((await client.query('select * from identity_workspace.member')).rows).toEqual([])
    expect(
      (
        await client.query(
          "update identity_workspace.member set role = 'owner' where organization_id = $1",
          [fixture.northwind],
        )
      ).rowCount,
    ).toBe(0)
  })
  expect(
    (await fixture.pool.query('select * from identity_workspace.onboarding_signup')).rows,
  ).toEqual([])
  expect(
    (await fixture.pool.query('select * from identity_workspace.onboarding_email')).rows,
  ).toEqual([])
})

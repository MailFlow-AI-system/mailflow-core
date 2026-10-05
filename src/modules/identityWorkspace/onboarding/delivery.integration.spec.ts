import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createWorkspaceTestFixture } from '../workspaces/fixtures.test-support.js'
import { createOnboardingDispatcher } from './dispatcher.js'
import { createOnboardingService } from './service.js'
import { createOnboardingCipher } from './utils/cipher.js'

let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
const email = `onboarding-delivery-${randomUUID()}@mailflow.invalid`
const emails = [email]
beforeAll(async () => {
  fixture = await createWorkspaceTestFixture()
}, 30000)
afterAll(async () => {
  if (!fixture) return
  try {
    await fixture.admin.query(
      'delete from identity_workspace.organization where id in (select organization_id from identity_workspace.member where user_id in (select id from identity_workspace."user" where email = any($1::text[])))',
      [emails],
    )
    await fixture.admin.query(
      'delete from identity_workspace."user" where email = any($1::text[])',
      [emails],
    )
    await fixture.admin.query(
      'delete from identity_workspace.verification where identifier = any($1::text[])',
      [emails.map((value) => `email-verification-otp-${value}`)],
    )
  } finally {
    await fixture.close()
  }
})

async function createDeliveryJob() {
  const address = `onboarding-delivery-${randomUUID()}@mailflow.invalid`
  emails.push(address)
  await createOnboardingService(fixture.pool, fixture.authConfig).signup(
    {
      name: 'Delivery',
      email: address,
      password: 'test-delivery-password',
      workspaceName: 'Delivery Test',
      workspaceSlug: `delivery-${randomUUID().slice(0, 8)}`,
    },
    randomUUID(),
  )
  const jobs = await fixture.admin.query(
    'select e.id from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1',
    [address],
  )
  return jobs.rows[0].id as string
}

it('leases a queued email only once when workers claim concurrently', async () => {
  const id = await createDeliveryJob()
  let releaseDelivery!: () => void
  let startedDelivery!: () => void
  const released = new Promise<void>((resolve) => {
    releaseDelivery = resolve
  })
  const started = new Promise<void>((resolve) => {
    startedDelivery = resolve
  })
  const send = vi.fn(async () => {
    startedDelivery()
    await released
  })
  const dispatch = createOnboardingDispatcher({
    pool: fixture.pool,
    cipher: createOnboardingCipher(fixture.authConfig.secret),
    send,
  })
  const first = dispatch(id)
  await started
  try {
    expect(await dispatch(id)).toBe('idle')
    expect(send).toHaveBeenCalledOnce()
  } finally {
    releaseDelivery()
    expect(await first).toBe('sent')
  }
})

it('erases an expired OTP payload without contacting the provider', async () => {
  const id = await createDeliveryJob()
  await fixture.admin.query(
    "update identity_workspace.onboarding_email set expires_at = now() - interval '1 second' where id = $1",
    [id],
  )
  const send = vi.fn()
  const dispatch = createOnboardingDispatcher({
    pool: fixture.pool,
    cipher: createOnboardingCipher(fixture.authConfig.secret),
    send,
  })
  expect(await dispatch(id)).toBe('idle')
  expect(send).not.toHaveBeenCalled()
  const result = await fixture.admin.query(
    'select state, payload, attempts from identity_workspace.onboarding_email where id = $1',
    [id],
  )
  expect(result.rows[0]).toMatchObject({ state: 'expired', payload: null, attempts: 0 })
})

it('retries provider failure with a stable key and clears the payload after delivery', async () => {
  await createOnboardingService(fixture.pool, fixture.authConfig).signup(
    {
      name: 'Delivery',
      email,
      password: 'test-delivery-password',
      workspaceName: 'Delivery Test',
      workspaceSlug: `delivery-${randomUUID().slice(0, 8)}`,
    },
    randomUUID(),
  )
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('Synthetic provider failure'))
    .mockResolvedValue(undefined)
  const dispatch = createOnboardingDispatcher({
    pool: fixture.pool,
    cipher: createOnboardingCipher(fixture.authConfig.secret),
    send,
  })
  // A worker may not send jobs belonging to another test run.
  const jobs = await fixture.admin.query(
    'select e.id from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1',
    [email],
  )
  expect(await dispatch(jobs.rows[0].id)).toBe('retry')
  expect(
    (
      await fixture.admin.query(
        'select state, payload, attempts from identity_workspace.onboarding_email where id = $1',
        [jobs.rows[0].id],
      )
    ).rows[0],
  ).toMatchObject({ state: 'pending', attempts: 1 })
  await fixture.admin.query(
    'update identity_workspace.onboarding_email set available_at = now() where id = $1',
    [jobs.rows[0].id],
  )
  expect(await dispatch(jobs.rows[0].id)).toBe('sent')
  expect(send.mock.calls[0]?.[1]).toEqual({ idempotencyKey: `onboarding-email/${jobs.rows[0].id}` })
  expect(send.mock.calls[1]?.[1]).toEqual(send.mock.calls[0]?.[1])
  expect(
    (
      await fixture.admin.query(
        'select state, payload, attempts from identity_workspace.onboarding_email where id = $1',
        [jobs.rows[0].id],
      )
    ).rows[0],
  ).toMatchObject({ state: 'sent', payload: null, attempts: 2 })
})

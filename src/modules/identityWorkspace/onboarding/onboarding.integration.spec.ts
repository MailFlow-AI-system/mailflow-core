import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceTestFixture } from '../workspaces/fixtures.test-support.js'
import { createOnboardingEnqueue } from './enqueueEmail.js'
import { createOnboardingOtpHandler } from './otpHandler.js'
import { createOnboardingService } from './service.js'
import { createSignupActions } from './signupActions.js'
import { createOnboardingCipher } from './utils/cipher.js'
import { testClientIp } from './utils/testClientIp.test-support.js'

describe('transactional workspace onboarding', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  const email = `onboarding-${randomUUID()}@mailflow.invalid`
  const key = randomUUID()
  const emails = [email]
  function inputFor(slug = `team-${randomUUID().slice(0, 8)}`) {
    const nextEmail = `onboarding-${randomUUID()}@mailflow.invalid`
    emails.push(nextEmail)
    return {
      name: 'Maya',
      email: nextEmail,
      password: 'local-only-password-123',
      workspaceName: 'Maya Workspace',
      workspaceSlug: slug,
    }
  }
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30000)
  afterAll(async () => {
    if (!fixture) return
    await fixture.admin.query(
      `delete from identity_workspace.organization where id in
      (select organization_id from identity_workspace.member where user_id in
      (select id from identity_workspace."user" where email = any($1::text[])))`,
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
    await fixture.close()
  })
  it('rolls back identity, receipt and protected verification when provisioning fails', async () => {
    const input = inputFor()
    const failing = createOnboardingService(fixture.pool, fixture.authConfig, (...args) => ({
      ...createSignupActions(...args),
      provision: async () => {
        throw new Error('Synthetic provisioning failure')
      },
    }))
    await expect(failing.signup(input, randomUUID())).rejects.toThrow(
      'Synthetic provisioning failure',
    )
    expect(
      (
        await fixture.admin.query('select id from identity_workspace."user" where email = $1', [
          input.email,
        ])
      ).rows,
    ).toEqual([])
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace.organization where slug = $1',
          [input.workspaceSlug],
        )
      ).rows,
    ).toEqual([])
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace.verification where identifier = $1',
          [`email-verification-otp-${input.email}`],
        )
      ).rows,
    ).toEqual([])
    expect(
      (await fixture.pool.query('select * from identity_workspace.onboarding_signup')).rows,
    ).toEqual([])
    expect(
      (await fixture.pool.query('select * from identity_workspace.organization')).rows,
    ).toEqual([])
  })
  it('commits one unverified identity, workspace, owner and encrypted delivery without a session', async () => {
    const signup = createOnboardingService(fixture.pool, fixture.authConfig)
    const result = await signup.signup(
      {
        name: 'Maya',
        email,
        password: 'local-only-password-123',
        workspaceName: 'Maya Workspace',
        workspaceSlug: `maya-${randomUUID().slice(0, 8)}`,
      },
      key,
    )
    expect(result).toEqual({ status: 'verification-pending' })
    const account = await fixture.admin.query(
      `select u.id, u.email_verified, m.role, o.name
      from identity_workspace."user" u join identity_workspace.member m on m.user_id = u.id
      join identity_workspace.organization o on o.id = m.organization_id where u.email = $1`,
      [email],
    )
    expect(account.rows).toMatchObject([
      { email_verified: false, role: 'owner', name: 'Maya Workspace' },
    ])
    expect(
      (
        await fixture.admin.query('select * from identity_workspace.session where user_id = $1', [
          account.rows[0].id,
        ])
      ).rows,
    ).toEqual([])
    const deliveries = await fixture.admin.query(
      'select payload from identity_workspace.onboarding_email where user_id = $1',
      [account.rows[0].id],
    )
    expect(deliveries.rows).toHaveLength(1)
    expect(deliveries.rows[0].payload).toMatch(/^v1\./)
    expect(deliveries.rows[0].payload).not.toContain(email)
  })
  it('rolls back signup when Better Auth swallows a verification enqueue failure', async () => {
    const input = inputFor()
    const signup = createOnboardingService(
      fixture.pool,
      fixture.authConfig,
      (client, config, _enqueue, ids, cipher) =>
        createSignupActions(
          client,
          config,
          async () => {
            throw new Error('Synthetic enqueue failure')
          },
          ids,
          cipher,
        ),
    )
    await expect(signup.signup(input, randomUUID())).rejects.toThrow('enqueue failed')
    expect(
      (
        await fixture.admin.query('select id from identity_workspace."user" where email = $1', [
          input.email,
        ])
      ).rows,
    ).toEqual([])
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace.organization where slug = $1',
          [input.workspaceSlug],
        )
      ).rows,
    ).toEqual([])
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace.verification where identifier = $1',
          [`email-verification-otp-${input.email}`],
        )
      ).rows,
    ).toEqual([])
  })
  it('serializes retries with the same key without a second identity or OTP delivery', async () => {
    const input = inputFor()
    const retryKey = randomUUID()
    const service = createOnboardingService(fixture.pool, fixture.authConfig)
    expect(
      await Promise.all([service.signup(input, retryKey), service.signup(input, retryKey)]),
    ).toEqual([{ status: 'verification-pending' }, { status: 'verification-pending' }])
    const result = await fixture.admin.query(
      `select u.id, (select count(*) from identity_workspace.onboarding_email e where e.user_id = u.id)::int as deliveries
      from identity_workspace."user" u where email = $1`,
      [input.email],
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].deliveries).toBe(1)
    await expect(
      service.signup({ ...input, workspaceName: 'Different request' }, retryKey),
    ).rejects.toThrow('signup details')
    expect(
      (await fixture.pool.query('select * from identity_workspace.organization')).rows,
    ).toEqual([])
  })
  it('allows only one competing signup to claim a slug and rolls back the loser', async () => {
    const slug = `contested-${randomUUID().slice(0, 8)}`
    const inputs = [inputFor(slug), inputFor(slug)]
    const service = createOnboardingService(fixture.pool, fixture.authConfig)
    const outcomes = await Promise.allSettled(
      inputs.map((input) => service.signup(input, randomUUID())),
    )
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace."user" where email = any($1::text[])',
          [inputs.map((input) => input.email)],
        )
      ).rows,
    ).toHaveLength(1)
    expect(
      (
        await fixture.admin.query(
          'select id from identity_workspace.organization where slug = $1',
          [slug],
        )
      ).rows,
    ).toHaveLength(1)
  })
  it('verifies the encrypted OTP and returns an authorized workspace login without a session', async () => {
    const input = inputFor()
    await createOnboardingService(fixture.pool, fixture.authConfig).signup(input, randomUUID())
    const delivery = await fixture.admin.query(
      'select e.id, e.payload from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1',
      [input.email],
    )
    const cipher = createOnboardingCipher(fixture.authConfig.secret)
    const otp = JSON.parse(cipher.open(delivery.rows[0].payload, delivery.rows[0].id)).otp
    const verify = createOnboardingOtpHandler(
      fixture.pool,
      fixture.authConfig,
      'http://workspace.test:3001',
    )
    const response = await verify(
      new Request(`${fixture.authConfig.baseURL}/api/auth/email-otp/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: fixture.authConfig.siteURL,
          'x-real-ip': testClientIp(),
        },
        body: JSON.stringify({ email: input.email, otp }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toMatchObject({
      status: true,
      token: null,
      user: { emailVerified: true },
      loginUrl: `http://${input.workspaceSlug}.workspace.test:3001/login`,
    })
    const user = await fixture.admin.query(
      'select id, email_verified from identity_workspace."user" where email = $1',
      [input.email],
    )
    expect(user.rows[0].email_verified).toBe(true)
    expect(
      (
        await fixture.admin.query('select id from identity_workspace.session where user_id = $1', [
          user.rows[0].id,
        ])
      ).rows,
    ).toEqual([])
    expect(
      (
        await fixture.admin.query(
          "select id from identity_workspace.onboarding_email where user_id = $1 and kind = 'verified-welcome'",
          [user.rows[0].id],
        )
      ).rows,
    ).toHaveLength(1)
  })
  it('does not lose invalid OTP attempts when requests arrive concurrently', async () => {
    const input = inputFor()
    await createOnboardingService(fixture.pool, fixture.authConfig).signup(input, randomUUID())
    const stored = await fixture.admin.query(
      'select value from identity_workspace.verification where identifier = $1',
      [`email-verification-otp-${input.email}`],
    )
    const cipher = createOnboardingCipher(fixture.authConfig.secret)
    const otp = cipher.open(
      stored.rows[0].value.slice(0, stored.rows[0].value.lastIndexOf(':')),
      'auth-email-otp',
    )
    const incorrect = otp === '000000' ? '111111' : '000000'
    const handler = createOnboardingOtpHandler(
      fixture.pool,
      fixture.authConfig,
      'http://workspace.test:3001',
    )
    const results = await Promise.all(
      [0, 1].map(() =>
        handler(
          new Request(`${fixture.authConfig.baseURL}/api/auth/email-otp/verify-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: fixture.authConfig.siteURL,
              'x-real-ip': testClientIp(),
            },
            body: JSON.stringify({ email: input.email, otp: incorrect }),
          }),
        ),
      ),
    )
    expect(results.map((response) => response.status)).toEqual([400, 400])
    const attempts = await fixture.admin.query(
      'select value from identity_workspace.verification where identifier = $1',
      [`email-verification-otp-${input.email}`],
    )
    expect(attempts.rows[0].value).toMatch(/:2$/)
  })
  it('commits invalid OTP attempts, rotates on resend and refuses expired codes', async () => {
    const input = inputFor()
    await createOnboardingService(fixture.pool, fixture.authConfig).signup(input, randomUUID())
    const handler = createOnboardingOtpHandler(
      fixture.pool,
      fixture.authConfig,
      'http://workspace.test:3001',
    )
    const cipher = createOnboardingCipher(fixture.authConfig.secret)
    const queued = await fixture.admin.query(
      'select e.id, e.payload from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1',
      [input.email],
    )
    const otp = JSON.parse(cipher.open(queued.rows[0].payload, queued.rows[0].id)).otp
    const clientIp = testClientIp()
    const post = (path: string, body: unknown) =>
      handler(
        new Request(`${fixture.authConfig.baseURL}/api/auth${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: fixture.authConfig.siteURL,
            'x-real-ip': clientIp,
          },
          body: JSON.stringify(body),
        }),
      )
    const incorrect = otp === '000000' ? '111111' : '000000'
    for (let i = 0; i < 3; i++) {
      expect(
        (await post('/email-otp/verify-email', { email: input.email, otp: incorrect })).ok,
      ).toBe(false)
      const attempts = await fixture.admin.query(
        'select value from identity_workspace.verification where identifier = $1',
        [`email-verification-otp-${input.email}`],
      )
      expect(attempts.rows[0].value).toMatch(new RegExp(`:${i + 1}$`))
    }
    expect((await post('/email-otp/verify-email', { email: input.email, otp })).ok).toBe(false)
    expect(
      (
        await fixture.admin.query(
          'select email_verified from identity_workspace."user" where email = $1',
          [input.email],
        )
      ).rows[0].email_verified,
    ).toBe(false)
    expect(
      (
        await post('/email-otp/send-verification-otp', {
          email: input.email,
          type: 'email-verification',
        })
      ).ok,
    ).toBe(true)
    const stored = await fixture.admin.query(
      'select value from identity_workspace.verification where identifier = $1',
      [`email-verification-otp-${input.email}`],
    )
    expect(stored.rows[0].value).toMatch(/^v1\./)
    await fixture.admin.query(
      "update identity_workspace.verification set expires_at = now() - interval '1 second' where identifier = $1",
      [`email-verification-otp-${input.email}`],
    )
    const newOtp = cipher.open(
      stored.rows[0].value.slice(0, stored.rows[0].value.lastIndexOf(':')),
      'auth-email-otp',
    )
    expect((await post('/email-otp/verify-email', { email: input.email, otp: newOtp })).ok).toBe(
      false,
    )
  })
  it('rolls back verification when welcome enqueue fails and accepts a safe retry', async () => {
    const input = inputFor()
    await createOnboardingService(fixture.pool, fixture.authConfig).signup(input, randomUUID())
    const delivery = await fixture.admin.query(
      'select e.id, e.payload from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1',
      [input.email],
    )
    const otp = JSON.parse(
      createOnboardingCipher(fixture.authConfig.secret).open(
        delivery.rows[0].payload,
        delivery.rows[0].id,
      ),
    ).otp
    const failingHandler = createOnboardingOtpHandler(
      fixture.pool,
      fixture.authConfig,
      'http://workspace.test:3001',
      (...args) =>
        async (message) => {
          if (message.kind === 'verified-welcome') throw new Error('Synthetic queue failure')
          await createOnboardingEnqueue(...args)(message)
        },
    )
    const clientIp = testClientIp()
    const request = () =>
      new Request(`${fixture.authConfig.baseURL}/api/auth/email-otp/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: fixture.authConfig.siteURL,
          'x-real-ip': clientIp,
        },
        body: JSON.stringify({ email: input.email, otp }),
      })
    await expect(failingHandler(request())).rejects.toThrow('enqueue failed')
    expect(
      (
        await fixture.admin.query(
          'select email_verified from identity_workspace."user" where email = $1',
          [input.email],
        )
      ).rows[0].email_verified,
    ).toBe(false)
    expect(
      (
        await createOnboardingOtpHandler(
          fixture.pool,
          fixture.authConfig,
          'http://workspace.test:3001',
        )(request())
      ).status,
    ).toBe(200)
  })
})

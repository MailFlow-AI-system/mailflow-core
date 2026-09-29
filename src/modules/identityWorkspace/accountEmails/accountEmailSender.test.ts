import { describe, expect, it, vi } from 'vitest'

import {
  type AccountEmailDelivery,
  type AccountEmailDeliveryOptions,
  type AccountEmailMessage,
  createAccountEmailSender,
} from './accountEmailSender.js'

const developmentConfig = {
  resend: {
    apiKey: 're_test_account_email_placeholder',
    from: 'noreply@mailflow-ai.online',
  },
}

function createTransport() {
  const deliveries: Array<{
    message: AccountEmailDelivery
    options: AccountEmailDeliveryOptions | undefined
  }> = []
  const transport = vi.fn(
    async (message: AccountEmailDelivery, options?: AccountEmailDeliveryOptions) => {
      deliveries.push({ message, options })
    },
  )

  return { deliveries, transport }
}

describe('account email sender', () => {
  it('renders the verification OTP and delivers it to its requested recipient in development', async () => {
    const { deliveries, transport } = createTransport()
    const send = createAccountEmailSender(developmentConfig, transport)

    await send({ kind: 'verification-otp', to: 'new-user@example.com', otp: '083219' })

    expect(transport).toHaveBeenCalledOnce()
    expect(deliveries[0]?.message).toMatchObject({
      from: 'MailFlow <noreply@mailflow-ai.online>',
      to: 'new-user@example.com',
    })
    expect(deliveries[0]?.message.subject.length).toBeGreaterThan(0)
    expect(deliveries[0]?.message.html.match(/<html\b[^>]*lang="([^"]+)"/)?.[1]).toBe('en')
    expect(deliveries[0]?.message.html).toContain('083219')
    expect(deliveries[0]?.message.text).toContain('083219')
  })

  it('renders welcome and password reset templates and keeps production recipients', async () => {
    const { deliveries, transport } = createTransport()
    const send = createAccountEmailSender(
      {
        resend: {
          apiKey: 're_test_account_email_placeholder',
          from: 'noreply@mailflow-ai.online',
        },
      },
      transport,
    )

    await send({
      kind: 'verified-welcome',
      to: 'person@mailflow.invalid',
      name: 'MailFlow QA',
      userId: 'user-123',
      loginUrl: 'https://app.mailflow.example/login',
    })
    await send({
      kind: 'password-reset',
      to: 'person@mailflow.invalid',
      name: 'MailFlow QA',
      url: 'https://api.mailflow.example/api/auth/reset-password/token',
    })

    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.message.from).toBe('MailFlow <noreply@mailflow-ai.online>')
    expect(deliveries[0]?.message.to).toBe('person@mailflow.invalid')
    expect(deliveries[0]?.message.html).toContain('MailFlow QA')
    expect(deliveries[0]?.message.text).toContain('https://app.mailflow.example/login')
    expect(deliveries[0]?.options).toEqual({ idempotencyKey: 'account-welcome/user-123' })
    expect(deliveries[1]?.message.html).toContain(
      'https://api.mailflow.example/api/auth/reset-password/token',
    )
    expect(deliveries[1]?.message.from).toBe('MailFlow <noreply@mailflow-ai.online>')
    expect(deliveries[1]?.message.text).toContain(
      'https://api.mailflow.example/api/auth/reset-password/token',
    )
  })

  it('uses one stable idempotency key for repeated welcome send attempts', async () => {
    const { deliveries } = createTransport()
    const send = createAccountEmailSender(
      {
        resend: {
          apiKey: 're_test_account_email_placeholder',
          from: 'noreply@mailflow-ai.online',
        },
      },
      async (message, options) => {
        deliveries.push({ message, options })
      },
    )
    const message: AccountEmailMessage = {
      kind: 'verified-welcome',
      to: 'person@mailflow.invalid',
      name: 'MailFlow QA',
      userId: 'user-123',
      loginUrl: 'https://app.mailflow.example/login',
    }

    await send(message)
    await send(message)

    expect(deliveries.map((delivery) => delivery.options)).toEqual([
      { idempotencyKey: 'account-welcome/user-123' },
      { idempotencyKey: 'account-welcome/user-123' },
    ])
  })

  it('propagates delivery errors to callers that need to retry', async () => {
    const transport = vi.fn(async (_message: AccountEmailDelivery) => {
      throw new Error('provider unavailable')
    })
    const send = createAccountEmailSender(developmentConfig, transport)
    const message: AccountEmailMessage = {
      kind: 'verification-otp',
      to: 'new-user@example.com',
      otp: '083219',
    }

    await expect(send(message)).rejects.toThrow('provider unavailable')
  })
})

import { expect, it, vi } from 'vitest'
import type { AccountEmailMessage } from '../../accountEmails/index.js'
import { loadAuthConfig } from './authConfig.js'
import { createAuthOptions } from './createAuth.js'

const config = loadAuthConfig({
  APP_ENV: 'production',
  BETTER_AUTH_SECRET: 'workspace-links-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://api.example.com',
  SITE_URL: 'https://example.com',
  WORKSPACE_WEB_BASE_ORIGIN: 'https://example.com',
  WORKSPACE_SWITCHING_ENABLED: 'true',
  WORKSPACE_READ_ENABLED: 'true',
  RESEND_API_KEY: 'no-external-delivery',
  RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
})
const user = { id: 'user-1', email: 'maya@example.com', name: 'Maya' }

function setup(slug: string | null) {
  const sent: AccountEmailMessage[] = []
  const accountWorkspace = vi.fn(async () => slug)
  const options = createAuthOptions(
    config,
    async (message) => {
      sent.push(message)
    },
    () => {},
    { accountWorkspace },
  )
  return { sent, accountWorkspace, options }
}

it('links password recovery to the requesting workspace host the user belongs to', async () => {
  const { sent, accountWorkspace, options } = setup('acme')
  await options.emailAndPassword.sendResetPassword(
    { user, url: 'https://api.example.com/api/auth/reset-password/token-1', token: 'token-1' },
    new Request('https://api.example.com/api/auth/request-password-reset', {
      method: 'POST',
      headers: { Origin: 'https://acme.example.com' },
    }),
  )
  expect(accountWorkspace).toHaveBeenCalledWith('user-1', 'acme')
  expect(sent).toEqual([
    {
      kind: 'password-reset',
      to: user.email,
      name: user.name,
      url: 'https://acme.example.com/reset-password?token=token-1',
    },
  ])
})

it('ignores untrusted request hosts and falls back to the landing without a workspace', async () => {
  const { sent, accountWorkspace, options } = setup(null)
  await options.emailAndPassword.sendResetPassword(
    { user, url: 'https://api.example.com/api/auth/reset-password/token-2', token: 'token-2' },
    new Request('https://api.example.com/api/auth/request-password-reset', {
      method: 'POST',
      headers: { Origin: 'https://www.example.com' },
    }),
  )
  expect(accountWorkspace).toHaveBeenCalledWith('user-1', undefined)
  expect(sent[0]).toMatchObject({ url: 'https://example.com/' })
})

it('sends the welcome login link to the user workspace', async () => {
  const { sent, options } = setup('northwind')
  await options.emailVerification.afterEmailVerification(user)
  expect(sent[0]).toMatchObject({
    kind: 'verified-welcome',
    loginUrl: 'https://northwind.example.com/login',
  })
})

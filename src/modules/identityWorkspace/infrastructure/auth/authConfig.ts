import { z } from 'zod'
import { appEnvironmentSchema } from '#shared/config/appEnvironment'
import type { AuthConfig } from '../types/authConfig.js'
import { loadWorkspaceDeployment } from './workspaceDeployment.js'

export type { AuthConfig } from '../types/authConfig.js'

const origin = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value)
  return (
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !url.hostname.includes('*')
  )
}, 'Must be an exact HTTP origin without a path, credentials, or wildcard')

const authEnvironment = z
  .object({
    APP_ENV: appEnvironmentSchema.default('development'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: origin,
    SITE_URL: origin,
    // Retired once workspace hosting is enabled: workspaces have no shared entry host.
    WEB_APP_URL: origin.optional(),
    RESEND_API_KEY: z.string().min(1),
    RESEND_FROM_EMAIL: z
      .email()
      .refine(
        (sender) => !sender.toLowerCase().endsWith('@resend.dev'),
        'Authentication email sender must use a custom Resend domain, not resend.dev',
      ),
  })
  .refine(
    ({ APP_ENV, BETTER_AUTH_URL, SITE_URL, WEB_APP_URL }) =>
      APP_ENV === 'development' ||
      [BETTER_AUTH_URL, SITE_URL, WEB_APP_URL].every(
        (value) => value === undefined || value.startsWith('https://'),
      ),
    'Authentication URLs must use HTTPS in staging and production',
  )

export function loadAuthConfig(environment: Record<string, string | undefined>): AuthConfig {
  const parsed = authEnvironment.parse(environment)
  const siteURL = new URL(parsed.SITE_URL).origin
  const baseURL = new URL(parsed.BETTER_AUTH_URL).origin
  const appEnv = parsed.APP_ENV
  const workspaceDeployment = loadWorkspaceDeployment(environment, { appEnv, baseURL, siteURL })
  const webAppURL =
    workspaceDeployment || !parsed.WEB_APP_URL ? undefined : new URL(parsed.WEB_APP_URL).origin
  if (!workspaceDeployment && !webAppURL)
    throw new Error('WEB_APP_URL is required unless workspace hosting is enabled')

  return {
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL,
    siteURL,
    ...(webAppURL ? { webAppURL } : {}),
    allowedOrigins: [...new Set([siteURL, ...(webAppURL ? [webAppURL] : [])])],
    appEnv,
    ...(workspaceDeployment ? { workspaceDeployment } : {}),
    resend: {
      apiKey: parsed.RESEND_API_KEY,
      from: parsed.RESEND_FROM_EMAIL,
    },
  }
}

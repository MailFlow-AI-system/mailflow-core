import { z } from 'zod'

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
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: origin,
    SITE_URL: origin,
    WEB_APP_URL: origin,
  })
  .refine(
    ({ APP_ENV, BETTER_AUTH_URL, SITE_URL, WEB_APP_URL }) =>
      APP_ENV === 'development' ||
      APP_ENV === 'test' ||
      [BETTER_AUTH_URL, SITE_URL, WEB_APP_URL].every((value) => value.startsWith('https://')),
    'Authentication URLs must use HTTPS in staging and production',
  )

export function loadAuthConfig(environment: Record<string, string | undefined>) {
  const parsed = authEnvironment.parse(environment)
  const siteURL = new URL(parsed.SITE_URL).origin
  const webAppURL = new URL(parsed.WEB_APP_URL).origin

  return {
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL: new URL(parsed.BETTER_AUTH_URL).origin,
    siteURL,
    webAppURL,
    allowedOrigins: [...new Set([siteURL, webAppURL])],
  }
}

export type AuthConfig = ReturnType<typeof loadAuthConfig>

export type AuthSession = {
  session: { id: string }
  user: { id: string }
}

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>
  api: {
    getSession: (input: { headers: Headers }) => Promise<AuthSession | null>
  }
}

export type AuthRouteDependencies = {
  auth: AuthService
  allowedOrigins: string[]
  isAllowedOrigin?: AuthOriginPolicy
  onboarding?: { handleOtp: (request: Request) => Promise<Response>; closeLegacySignup?: boolean }
  /** Shared secret proving a forwarded client IP came from the MailFlow Web Worker. */
  proxySecret?: string
}

import type { AuthOriginPolicy } from './authConfig.js'

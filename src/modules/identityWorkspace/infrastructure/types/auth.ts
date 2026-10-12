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
}

import type { AuthOriginPolicy } from './authConfig.js'

import type { AuthSession } from './auth.js'

declare module 'hono' {
  interface ContextVariableMap {
    authSession: AuthSession
  }
}

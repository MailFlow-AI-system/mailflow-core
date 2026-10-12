import { APIError } from 'better-auth/api'

export function isSignupConflictCause(value: unknown, depth = 0): boolean {
  if (depth > 5 || typeof value !== 'object' || value === null) return false
  if (
    value instanceof APIError &&
    ['ORGANIZATION_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(
      value.body?.code ?? '',
    )
  )
    return true
  if (
    'code' in value &&
    value.code === '23505' &&
    'constraint' in value &&
    (value.constraint === 'workspace_slug_unique' || value.constraint === 'user_email_unique')
  )
    return true
  return 'cause' in value && value.cause !== value && isSignupConflictCause(value.cause, depth + 1)
}

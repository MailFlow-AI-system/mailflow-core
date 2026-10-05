export function isUniqueViolation(value: unknown, depth = 0): boolean {
  if (depth > 5 || typeof value !== 'object' || value === null) return false
  if ('code' in value && value.code === '23505') return true
  return 'cause' in value && value.cause !== value && isUniqueViolation(value.cause, depth + 1)
}

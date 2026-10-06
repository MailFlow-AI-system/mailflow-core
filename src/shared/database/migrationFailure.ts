export function migrationFailureMetadata(error: unknown) {
  const outer = error !== null && typeof error === 'object' ? error : undefined
  const name = outer && 'name' in outer ? outer.name : undefined
  const errorName =
    typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error'
  const visited = new Set<object>()
  let current = outer
  let errorCode: string | undefined

  while (current && !visited.has(current)) {
    visited.add(current)
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string') {
      if (/^[0-9A-Z]{5}$/.test(code)) return { errorName, errorCode: code }
      if (/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) errorCode ??= code
    }
    const cause: unknown = 'cause' in current ? current.cause : undefined
    current = cause !== null && typeof cause === 'object' ? cause : undefined
  }

  return { errorName, ...(errorCode ? { errorCode } : {}) }
}

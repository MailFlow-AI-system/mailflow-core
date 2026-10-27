export type MailContext = { workspaceId: string; userId: string }

declare module 'hono' {
  interface ContextVariableMap {
    mailContext: MailContext
  }
}

export function assertMailContext(
  context: MailContext | undefined,
): asserts context is MailContext {
  if (!context?.workspaceId || !context.userId)
    throw new Error('A workspace and authenticated identity are required')
}

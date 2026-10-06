import type { Meter } from '@opentelemetry/api'
import type { WorkspaceOperation, WorkspaceResult } from './types/workspaceTelemetry.js'

export function createWorkspaceOperationTelemetry(meter: Meter) {
  const count = meter.createCounter('mailflow.workspace.operation.count', {
    description: 'Workspace operations completed.',
    unit: '{operation}',
  })
  const duration = meter.createHistogram('mailflow.workspace.operation.duration', {
    description: 'Workspace operation duration.',
    unit: 's',
  })
  return (method: string, route: string, status: number, failed: boolean, seconds: number) => {
    const operation = workspaceOperation(method, route)
    if (!operation) return undefined
    const attributes = {
      'mailflow.workspace.operation': operation,
      'mailflow.workspace.result': workspaceResult(status, failed),
    }
    count.add(1, attributes)
    duration.record(seconds, attributes)
    return attributes
  }
}

function workspaceOperation(method: string, route: string): WorkspaceOperation | undefined {
  switch (`${method} ${route}`) {
    case 'GET /api/v1/workspaces':
      return 'list'
    case 'GET /api/v1/workspaces/:slug/context':
      return 'context'
    case 'GET /api/v1/workspace-entry':
      return 'entry'
    case 'POST /api/v1/workspace-selection':
      return 'selection'
    default:
      return undefined
  }
}

function workspaceResult(status: number, failed: boolean): WorkspaceResult {
  if (failed) return 'failure'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'unavailable'
  if (status >= 500 || status < 200 || (status >= 300 && status < 400)) return 'failure'
  if (status >= 400) return 'denied'
  return 'success'
}

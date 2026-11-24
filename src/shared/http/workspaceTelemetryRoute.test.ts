import { expect, it } from 'vitest'
import { workspaceTelemetryRoute } from './workspaceTelemetryRoute.js'

it('uses only finite route templates, never selectors or arbitrary workspace paths', () => {
  expect(workspaceTelemetryRoute('GET', '/api/v1/workspaces')).toBe('/api/v1/workspaces')
  expect(workspaceTelemetryRoute('GET', '/api/v1/workspaces/private-tenant/context')).toBe(
    '/api/v1/workspaces/:slug/context',
  )
  expect(workspaceTelemetryRoute('POST', '/api/auth/workspace-handoff/issue')).toBe(
    '/api/auth/workspace-handoff/issue',
  )
  expect(workspaceTelemetryRoute('POST', '/api/auth/workspace-handoff/exchange')).toBe(
    '/api/auth/workspace-handoff/exchange',
  )
  expect(workspaceTelemetryRoute('GET', '/api/v1/workspace-entry')).toBeUndefined()
  expect(workspaceTelemetryRoute('POST', '/api/v1/workspace-selection')).toBeUndefined()
  expect(
    workspaceTelemetryRoute('GET', '/api/v1/workspaces/private-tenant/members'),
  ).toBeUndefined()
  expect(
    workspaceTelemetryRoute('GET', '/api/v1/workspaces/private-tenant/nested/context'),
  ).toBeUndefined()
  expect(workspaceTelemetryRoute('POST', '/api/v1/workspaces')).toBeUndefined()
  expect(workspaceTelemetryRoute('GET', '/other')).toBeUndefined()
})

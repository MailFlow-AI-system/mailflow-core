export type WorkspaceTelemetryRecord = {
  requestId: string
  traceId: string
  spanId: string
  status: number
  route: string
  'mailflow.workspace.operation': string
  'mailflow.workspace.result': string
}

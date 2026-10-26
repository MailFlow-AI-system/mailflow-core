import { describe, expect, it, vi } from 'vitest'
import { configureRailwayMigrations, railwayMigrationTargets } from './railwayMigrations.js'

const policy = {
  preDeployCommand: ['node dist/entrypoints/migrate.js'],
  preDeployTimeoutSeconds: 300,
  healthcheckPath: '/health/ready',
  healthcheckTimeout: 300,
}
function setup(configured = false) {
  const state = new Map(
    railwayMigrationTargets.map((target) => [
      target.serviceId,
      {
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        source: { repo: 'MailFlow-AI-system/mailflow-core' },
        startCommand: 'node --enable-source-maps dist/entrypoints/api.js',
        preDeployCommand: configured ? policy.preDeployCommand : null,
        preDeployTimeoutSeconds: 300,
        healthcheckPath: '/health/ready',
        healthcheckTimeout: configured ? 300 : null,
      },
    ]),
  )
  const mutations: { serviceId: string; environmentId: string; input: typeof policy }[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, request) => {
    const { query, variables } = JSON.parse(request?.body as string)
    if (query.includes('mutation')) {
      mutations.push(variables)
      Object.assign(state.get(variables.serviceId) ?? {}, variables.input)
      return Response.json({ data: { serviceInstanceUpdate: true } })
    }
    return Response.json({ data: { serviceInstance: state.get(variables.serviceId) } })
  })
  return { state, mutations, fetcher }
}
describe('Railway migration deployment policy', () => {
  it('plans development, staging and main without changing remote configuration', async () => {
    const { fetcher, mutations } = setup()
    const result = await configureRailwayMigrations({ token: 'test-token' }, fetcher)
    expect(result.map(({ branch }) => branch)).toEqual(['development', 'staging', 'main'])
    expect(result.every(({ configured }) => !configured)).toBe(true)
    expect(mutations).toEqual([])
  })
  it('configures and verifies only the three API destinations', async () => {
    const { fetcher, mutations } = setup()
    const result = await configureRailwayMigrations({ token: 'test-token', apply: true }, fetcher)
    expect(result.every(({ configured }) => configured)).toBe(true)
    expect(mutations).toEqual(
      railwayMigrationTargets.map(({ serviceId, environmentId }) => ({
        serviceId,
        environmentId,
        input: policy,
      })),
    )
    expect(new Set(mutations.map(({ serviceId }) => serviceId)).size).toBe(3)
  })
  it('does not update destinations that already match', async () => {
    const { fetcher, mutations } = setup(true)
    expect(
      (await configureRailwayMigrations({ token: 'test-token', apply: true }, fetcher)).every(
        ({ configured }) => configured,
      ),
    ).toBe(true)
    expect(mutations).toEqual([])
  })
  it('validates every destination before making any update', async () => {
    const { fetcher, mutations, state } = setup()
    const last = railwayMigrationTargets.at(-1)
    if (!last) throw new Error('Missing production destination')
    const record = state.get(last.serviceId)
    if (record) record.startCommand = 'node dist/entrypoints/worker.js'
    await expect(
      configureRailwayMigrations({ token: 'test-token', apply: true }, fetcher),
    ).rejects.toThrow('API destination')
    expect(mutations).toEqual([])
  })
  it('fails closed on GraphQL errors even with HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ errors: [{ message: 'private upstream detail' }] }),
    )
    await expect(
      configureRailwayMigrations({ token: 'test-token', apply: true }, fetcher),
    ).rejects.toThrow('Railway request failed')
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !JSON.parse(init?.body as string).query.includes('mutation'),
      ),
    ).toBe(true)
  })
  it('rejects missing credentials before contacting Railway', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(configureRailwayMigrations({ token: '' }, fetcher)).rejects.toThrow(
      'RAILWAY_API_TOKEN',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})

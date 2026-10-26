import { z } from 'zod'

export const railwayMigrationTargets = [
  {
    branch: 'development',
    environment: 'development',
    environmentId: '6d6e82df-c6e7-4534-ab7a-70712a0434ee',
    serviceId: 'dcb46e9a-5877-4073-b6a0-6e0e91441a89',
  },
  {
    branch: 'staging',
    environment: 'staging',
    environmentId: 'ebd47429-118a-4710-8849-446c456b88de',
    serviceId: '228eec1d-26f9-4a75-a899-33604df87d8e',
  },
  {
    branch: 'main',
    environment: 'production',
    environmentId: '7b394f90-e841-4d50-8010-1b96f4168ea7',
    serviceId: 'bd30bbc5-0934-4dc7-9fcd-c167c7c71815',
  },
] as const

const migrationPolicy = {
  preDeployCommand: ['node dist/entrypoints/migrate.js'],
  preDeployTimeoutSeconds: 300,
  healthcheckPath: '/health/ready',
  healthcheckTimeout: 300,
}
const instanceSchema = z.object({
  serviceId: z.string(),
  environmentId: z.string(),
  source: z.object({ repo: z.string().nullable() }).nullable(),
  startCommand: z.string().nullable(),
  preDeployCommand: z.array(z.string()).nullable(),
  preDeployTimeoutSeconds: z.number().nullable(),
  healthcheckPath: z.string().nullable(),
  healthcheckTimeout: z.number().nullable(),
})
const readInstance = `query MigrationDestination($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    serviceId environmentId source { repo } startCommand preDeployCommand
    preDeployTimeoutSeconds healthcheckPath healthcheckTimeout
  }
}`
const updateInstance = `mutation ConfigureMigrations($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`
function matchesPolicy(instance: z.infer<typeof instanceSchema>) {
  return (
    instance.preDeployCommand?.length === 1 &&
    instance.preDeployCommand[0] === migrationPolicy.preDeployCommand[0] &&
    instance.preDeployTimeoutSeconds === migrationPolicy.preDeployTimeoutSeconds &&
    instance.healthcheckPath === migrationPolicy.healthcheckPath &&
    instance.healthcheckTimeout === migrationPolicy.healthcheckTimeout
  )
}

export async function configureRailwayMigrations(
  { token, apply = false }: { token: string; apply?: boolean },
  fetcher: typeof fetch = fetch,
) {
  if (!token.trim()) throw new Error('RAILWAY_API_TOKEN is required')
  const request = async (query: string, variables: Record<string, unknown>) => {
    const response = await fetcher('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('Railway request failed')
    const body = z
      .object({
        data: z.record(z.string(), z.unknown()).nullish(),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(await response.json())
    if (body.errors?.length || !body.data) throw new Error('Railway request failed')
    return body.data
  }
  const inspect = async (target: (typeof railwayMigrationTargets)[number]) => {
    const instance = instanceSchema.parse(
      (
        await request(readInstance, {
          serviceId: target.serviceId,
          environmentId: target.environmentId,
        })
      ).serviceInstance,
    )
    if (
      instance.serviceId !== target.serviceId ||
      instance.environmentId !== target.environmentId ||
      instance.source?.repo !== 'MailFlow-AI-system/mailflow-core' ||
      instance.startCommand !== 'node --enable-source-maps dist/entrypoints/api.js'
    )
      throw new Error(`Unexpected API destination for ${target.environment}`)
    return instance
  }
  // Inspect every destination first so a wrong worker or repository cannot be partially configured.
  const instances = await Promise.all(railwayMigrationTargets.map(inspect))
  const results = []
  for (const [index, target] of railwayMigrationTargets.entries()) {
    let instance = instances[index]
    if (!instance) throw new Error('Railway destination unavailable')
    if (apply && !matchesPolicy(instance)) {
      const result = await request(updateInstance, {
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        input: migrationPolicy,
      })
      if (result.serviceInstanceUpdate !== true) throw new Error('Railway update failed')
      instance = await inspect(target)
      if (!matchesPolicy(instance))
        throw new Error(`Railway verification failed for ${target.environment}`)
    }
    results.push({
      branch: target.branch,
      environment: target.environment,
      configured: matchesPolicy(instance),
    })
  }
  return results
}

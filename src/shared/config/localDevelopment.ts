export function localDevelopmentEnvironment(
  environment: NodeJS.ProcessEnv,
  localRunner: boolean,
): NodeJS.ProcessEnv {
  if (!localRunner || environment.MAILFLOW_LOCAL_PROFILE === 'false') return environment
  if (
    (environment.APP_ENV && environment.APP_ENV !== 'development') ||
    environment.RAILWAY_ENVIRONMENT_ID ||
    environment.CI ||
    environment.WORKERS_CI
  )
    throw new Error('The local runner cannot be used for a published environment')
  return {
    ...environment,
    APP_ENV: 'development',
    BETTER_AUTH_URL: `http://localhost:${environment.PORT ?? '8080'}`,
    SITE_URL: 'http://localhost:4321',
    WEB_APP_URL: 'http://localhost:3000',
    WORKSPACE_WEB_BASE_ORIGIN: 'http://localhost:3000',
    WORKSPACE_READ_ENABLED: 'true',
    WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
    WORKSPACE_SWITCHING_ENABLED: 'false',
  }
}

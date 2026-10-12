import type { AppEnvironment } from '#shared/config/appEnvironment'

export type WorkspaceDeploymentConfig = {
  baseHost: string
  webOrigin: string
}

export type AuthOriginPolicy = (origin: string) => boolean

export type AuthConfig = {
  secret: string
  baseURL: string
  siteURL: string
  webAppURL: string
  allowedOrigins: string[]
  appEnv: AppEnvironment
  resend: { apiKey: string; from: string }
  workspaceDeployment?: WorkspaceDeploymentConfig
}

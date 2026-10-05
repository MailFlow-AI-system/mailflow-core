import { describe, expect, it } from 'vitest'
import { workspaceLocalSwitchingEnabled } from './runtimeConfig.js'

describe('workspace switching rollout', () => {
  it('stays dark by default and requires local development and reads', () => {
    expect(workspaceLocalSwitchingEnabled({})).toBe(false)
    expect(
      workspaceLocalSwitchingEnabled({
        APP_ENV: 'development',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(() =>
      workspaceLocalSwitchingEnabled({
        APP_ENV: 'staging',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
      }),
    ).toThrow('development')
    expect(() =>
      workspaceLocalSwitchingEnabled({
        APP_ENV: 'development',
        WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
      }),
    ).toThrow('reads')
  })
})

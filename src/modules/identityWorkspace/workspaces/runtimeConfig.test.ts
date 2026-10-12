import { describe, expect, it } from 'vitest'
import { workspaceLocalSwitchingEnabled, workspaceSwitchingMode } from './runtimeConfig.js'

describe('workspace switching rollout', () => {
  it('enables remote switching explicitly without weakening the local gate', () => {
    expect(workspaceSwitchingMode({})).toBe('disabled')
    expect(
      workspaceSwitchingMode({
        APP_ENV: 'production',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
      }),
    ).toBe('remote')
    expect(() => workspaceSwitchingMode({ WORKSPACE_SWITCHING_ENABLED: 'true' })).toThrow('reads')
    expect(() =>
      workspaceSwitchingMode({
        APP_ENV: 'development',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
        WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
      }),
    ).toThrow('exclusive')
  })
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

import { describe, expect, it } from 'vitest'
import { workspaceSwitchingEnabled } from './runtimeConfig.js'

describe('workspace switching rollout', () => {
  it('stays dark by default and requires authorized workspace reads', () => {
    expect(workspaceSwitchingEnabled({})).toBe(false)
    expect(
      workspaceSwitchingEnabled({
        APP_ENV: 'production',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(
      workspaceSwitchingEnabled({
        APP_ENV: 'development',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(() => workspaceSwitchingEnabled({ WORKSPACE_SWITCHING_ENABLED: 'true' })).toThrow(
      'reads',
    )
  })
})

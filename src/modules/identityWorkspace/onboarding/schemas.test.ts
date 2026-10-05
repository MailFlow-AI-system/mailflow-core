import { expect, it } from 'vitest'
import { signupSchema } from './schemas.js'

it('normalizes signup fields and rejects unsafe, reserved and extra selectors', () => {
  const value = {
    name: ' Maya ',
    email: ' maya@MAILFLOW.invalid ',
    password: 'synthetic-password',
    workspaceName: ' Team ',
    workspaceSlug: ' MY-Team ',
  }
  expect(signupSchema.parse(value)).toMatchObject({
    name: 'Maya',
    email: 'maya@mailflow.invalid',
    workspaceName: 'Team',
    workspaceSlug: 'my-team',
  })
  for (const workspaceSlug of [
    'api',
    'AUTH',
    '-team',
    'team-',
    'team--name',
    'team.other',
    'a'.repeat(64),
  ]) {
    expect(signupSchema.safeParse({ ...value, workspaceSlug }).success).toBe(false)
  }
  expect(signupSchema.safeParse({ ...value, userId: 'client-selected-identity' }).success).toBe(
    false,
  )
})

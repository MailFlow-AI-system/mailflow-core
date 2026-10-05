import type { AccountEmailMessage } from '../../src/modules/identityWorkspace/accountEmails/index.js'
export type BrowserSignupScenario = { project: string; email: string; slug: string; name: string }
export type CapturedOnboardingEmail = Extract<
  AccountEmailMessage,
  { kind: 'verification-otp' | 'verified-welcome' }
>

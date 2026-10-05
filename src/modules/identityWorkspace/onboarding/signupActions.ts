import { drizzle } from 'drizzle-orm/node-postgres'
import { createAuth } from '../infrastructure/auth/createAuth.js'
import { SignupConflict } from './errors.js'
import type { SignupActionsFactory } from './types.js'
import { createProtectedOtpStorage } from './utils/otpStorage.js'
import { uuidV7 } from './utils/uuidV7.js'

export const createSignupActions: SignupActionsFactory = (client, config, enqueue, ids, cipher) => {
  let verificationQueued = false
  const auth = createAuth(
    drizzle(client),
    config,
    async (message) => {
      try {
        await enqueue(message)
        if (message.kind === 'verification-otp') verificationQueued = true
      } catch {
        // Better Auth logs and swallows background callback failures. The caller
        // must explicitly reject signup rather than commit an account without a job.
        throw new Error('Onboarding verification enqueue failed')
      }
    },
    undefined,
    {
      generateId: ({ model }) =>
        model === 'user' ? ids.userId : model === 'organization' ? ids.workspaceId : uuidV7(),
      otpStorage: createProtectedOtpStorage(cipher),
    },
  )
  return {
    async register(input) {
      const result = await auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
      })
      if (result.user.id !== ids.userId) throw new SignupConflict()
      if (!verificationQueued) throw new Error('Onboarding verification enqueue failed')
    },
    async provision(input) {
      await auth.api.createOrganization({
        body: {
          name: input.workspaceName,
          slug: input.workspaceSlug,
          userId: ids.userId,
          keepCurrentActiveOrganization: true,
        },
      })
    },
  }
}

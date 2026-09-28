import { relations } from 'drizzle-orm'

import { authAccount } from './account.js'
import { authSession } from './session.js'
import { authUser } from './user.js'

export const authUserRelations = relations(authUser, ({ many }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
}))

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, {
    fields: [authSession.userId],
    references: [authUser.id],
  }),
}))

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, {
    fields: [authAccount.userId],
    references: [authUser.id],
  }),
}))

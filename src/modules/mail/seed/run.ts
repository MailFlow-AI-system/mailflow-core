import { createMailWorkspaceAuthority, createWorkspaceReader } from '#modules/identityWorkspace'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { createObjectStorage } from '../attachments/objectStorage.js'
import { createAttachmentService } from '../attachments/service.js'
import { createAttachmentRepository } from '../infrastructure/database/attachmentRepository.js'
import { seedMailMessages } from './fixtures.js'
import { createMailSeedAttachmentOperations, seedMailAttachments } from './seedAttachments.js'
import { seedMail } from './seedMail.js'
import { parseMailSeedArgs, resolveMailSeedWorkspaceId } from './seedTarget.js'

const target = parseMailSeedArgs(process.argv.slice(2), {
  appEnv: process.env.APP_ENV,
  nodeEnv: process.env.NODE_ENV,
  railwayEnvironmentId: process.env.RAILWAY_ENVIRONMENT_ID,
})

const config = loadConfig(process.env)
const logger = createLogger(config, 'mailflow-core-mail-seed')
const database = createDatabase(config.databaseUrl, logger)

try {
  const workspaceId = await resolveMailSeedWorkspaceId(
    createMailWorkspaceAuthority(database.pool),
    target,
    createWorkspaceReader(database.pool),
  )
  const repository = createAttachmentRepository(database.database)
  const storage = createObjectStorage(process.env)
  const attachmentService = createAttachmentService({ repository, storage })
  const attachmentOperations = createMailSeedAttachmentOperations({
    pool: database.pool,
    service: attachmentService,
  })
  const messagesInserted = await seedMail(database.pool, workspaceId)
  const attachmentsSeeded = await seedMailAttachments(
    attachmentOperations,
    workspaceId,
    target.workspaceOwnerId,
  )

  logger.info(
    {
      workspaceId,
      workspaceTargetId: target.workspaceId,
      workspaceName: target.workspaceName,
      workspaceSlug: target.workspaceSlug,
      messagesInserted,
      messagesExisting: seedMailMessages.length - messagesInserted,
      attachmentsInserted: attachmentsSeeded.inserted,
      attachmentsExisting: attachmentsSeeded.existing,
    },
    'Mail QA fixtures seeded',
  )
} finally {
  await database.pool.end()
  await shutdownLogger(logger)
}

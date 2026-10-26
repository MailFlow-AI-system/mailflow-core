import {
  cleanupAttachments,
  cleanupOrphanObjects,
  createAttachmentRepository,
  createObjectStorage,
} from '#modules/mail'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'

const config = loadConfig(process.env)
const logger = createLogger(config, 'mailflow-core-cleanup')
const database = createDatabase(config.databaseUrl, logger)
try {
  const repository = createAttachmentRepository(database.database)
  const storage = createObjectStorage(process.env)
  const deleted = await cleanupAttachments(repository, storage)
  const cursor = process.argv[2]
  const orphans = await cleanupOrphanObjects(repository, storage, cursor)
  process.stdout.write(
    `${JSON.stringify({ deleted, orphanObjectsDeleted: orphans.deleted, nextCursor: orphans.nextCursor ?? null })}\n`,
  )
} finally {
  await database.pool.end()
  await shutdownLogger(logger)
}

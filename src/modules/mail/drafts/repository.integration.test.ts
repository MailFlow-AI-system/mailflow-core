import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAttachmentRepository } from '../infrastructure/database/attachmentRepository.js'
import type { DraftContent } from './contract.js'
import { createDraftRepository } from './repository.js'

const databaseUrl =
  process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL ??
  'postgresql://mailflow:mailflow@localhost:5432/mailflow'
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Tests require local PostgreSQL')

describe('persisted drafts', () => {
  const name = `drafts_${randomUUID().replaceAll('-', '')}`
  const role = `draft_app_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  let owner: Pool
  let pool: Pool
  let repository: ReturnType<typeof createDraftRepository>
  const context = { userId: 'owner', workspaceId: 'workspace' }
  const content = {
    to: 'unfinished@',
    cc: '',
    bcc: '',
    recipientName: '',
    subject: '',
    html: '<p><strong>Unfinished</strong></p>',
    text: 'Unfinished',
    attachments: [],
    labelIds: [],
  }
  const save = (id: string, version = 0, subject = '') =>
    repository.save(context, id, {
      ...content,
      subject,
      version,
      mutationId: randomUUID(),
    })
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    owner = new Pool({ connectionString: url.href })
    await migrate(drizzle(owner), {
      migrationsFolder: './database/migrations/mail',
      migrationsSchema: 'mail_migrations',
      migrationsTable: '__drizzle_migrations',
    })
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local_only' NOSUPERUSER NOBYPASSRLS`)
    await owner.query(`GRANT USAGE ON SCHEMA mail TO "${role}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mail TO "${role}"`)
    url.username = role
    url.password = 'local_only'
    pool = new Pool({ connectionString: url.href })
    repository = createDraftRepository(pool)
  })
  afterAll(async () => {
    await pool?.end()
    await owner?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    await admin.end()
  })

  it('recovers incomplete fields and rich content through a new repository instance', async () => {
    const id = randomUUID()
    expect(await save(id)).toMatchObject({ id, version: 1 })
    const reopened = await createDraftRepository(pool).find(context, id)
    expect(reopened).toMatchObject({ ...content, id, version: 1 })
    expect(await save(id, 1, 'Edited')).toMatchObject({ version: 2, subject: 'Edited' })
    expect((await repository.list(context, 0)).filter((item) => item.id === id)).toHaveLength(1)
    expect(await repository.find({ ...context, userId: 'other' }, id)).toBeNull()
    expect(await repository.find({ ...context, workspaceId: 'other' }, id)).toBeNull()
  })

  it('waits for an in-flight edit before recovering content and attachment references', async () => {
    const id = randomUUID()
    await save(id)
    const writer = await owner.connect()
    let settled = false
    await writer.query('BEGIN')
    try {
      await writer.query(
        `update mail.draft set content=jsonb_set(content,'{subject}','"Committed edit"') where id=$1`,
        [id],
      )
      const recovery = repository.find(context, id).then((result) => {
        settled = true
        return result
      })
      let blocked = false
      for (let attempt = 0; attempt < 100 && !settled; attempt++) {
        const observed = await owner.query<{ blocked: boolean }>(
          `select exists(select 1 from pg_stat_activity
          where datname=$1 and wait_event_type='Lock' and query like '%from mail.draft where%') as blocked`,
          [name],
        )
        if (observed.rows[0]?.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await writer.query('COMMIT')
      const result = await recovery
      expect(blocked).toBe(true)
      expect(result).toMatchObject({ subject: 'Committed edit' })
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
    }
  })

  it('retries a save idempotently and rejects stale or concurrent versions', async () => {
    const id = randomUUID()
    const input = { ...content, version: 0, mutationId: randomUUID() }
    expect(await repository.save(context, id, input)).toMatchObject({ version: 1 })
    expect(await repository.save(context, id, input)).toMatchObject({ version: 1 })
    const attempts = await Promise.allSettled([save(id, 1, 'First'), save(id, 1, 'Second')])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    await expect(save(id, 1, 'Stale')).rejects.toThrow('changed')
  })

  it('keeps deletion tombstones so a delayed initial autosave cannot recreate a draft', async () => {
    const id = randomUUID()
    await repository.discard(context, id, 0)
    await expect(save(id)).rejects.toThrow('changed')
    const savedId = randomUUID()
    await save(savedId)
    await expect(repository.discard(context, savedId, 0)).rejects.toThrow('changed')
    await repository.discard(context, savedId, 1)
    await repository.discard(context, savedId, 1)
    expect(await repository.find(context, savedId)).toBeNull()
    await expect(save(savedId, 1)).rejects.toThrow('changed')
  })

  it('retains clean attachments after expiry and releases them only on discard', async () => {
    const id = randomUUID(),
      attachmentId = randomUUID()
    await owner.query(
      `insert into mail.attachment
      (workspace_id,user_id,id,filename,content_type,size,sha256,status,temporary_key,final_key)
      values ($1,$2,$3,'notes.txt','text/plain',4,$4,'clean',$5,$6)`,
      [
        context.workspaceId,
        context.userId,
        attachmentId,
        'a'.repeat(64),
        `tmp/${id}`,
        `final/${id}`,
      ],
    )
    await repository.save(context, id, {
      ...content,
      version: 0,
      mutationId: randomUUID(),
      attachments: [{ id: attachmentId }],
    })
    await owner.query(`update mail.attachment set expires_at=now()-interval '2 days' where id=$1`, [
      attachmentId,
    ])
    const files = createAttachmentRepository(drizzle(owner))
    expect(await files.isAssociated(context, attachmentId)).toBe(true)
    expect(await files.claimExpired(100, randomUUID())).toEqual([])
    expect((await repository.find(context, id))?.attachments).toMatchObject([
      { id: attachmentId, filename: 'notes.txt' },
    ])
    await repository.discard(context, id, 1)
    expect(await files.isAssociated(context, attachmentId)).toBe(false)
    expect(await files.claimExpired(100, randomUUID())).toHaveLength(1)
  })

  it('searches recipients, subject, body and label names literally within the owner scope', async () => {
    const workspaceId = `search-${randomUUID()}`
    const scope = { userId: 'owner', workspaceId }
    const labelId = randomUUID()
    await owner.query(
      `insert into mail.label (workspace_id,id,name,color) values ($1,$2,$3,'#336699')`,
      [workspaceId, labelId, 'Quarterly Budget'],
    )
    const put = (input: Partial<DraftContent>, user = scope) =>
      repository.save(user, randomUUID(), {
        ...content,
        to: '',
        subject: '',
        text: '',
        ...input,
        version: 0,
        mutationId: randomUUID(),
      })
    const byRecipient = await put({
      to: 'ada.lovelace@example.test',
      recipientName: 'Countess Byron',
    })
    const byCc = await put({ cc: 'grace@navy.test' })
    const bySubject = await put({ subject: 'Invoice 100%_final' })
    const byBody = await put({ text: 'Please review the ATTACHED contract' })
    const byLabel = await put({ labelIds: [labelId] })
    const foreign = await put(
      { subject: 'Invoice from someone else' },
      { ...scope, userId: 'other' },
    )
    const ids = async (search: string) =>
      (await repository.list(scope, 0, search)).map((item) => item.id).sort()
    expect(await ids('')).toHaveLength(5)
    // The list carries the recipient name so clients can show it instead of the address.
    expect(
      (await repository.list(scope, 0)).find((item) => item.id === byRecipient.id),
    ).toMatchObject({ to: 'ada.lovelace@example.test', recipientName: 'Countess Byron' })
    expect(await ids('byron')).toEqual([byRecipient.id])
    expect(await ids('LOVELACE')).toEqual([byRecipient.id])
    expect(await ids('navy.test')).toEqual([byCc.id])
    expect(await ids('invoice')).toEqual([bySubject.id])
    expect(await ids('100%_final')).toEqual([bySubject.id])
    expect(await ids('%')).toEqual([bySubject.id])
    expect(await ids('attached contract')).toEqual([byBody.id])
    expect(await ids('quarterly budget')).toEqual([byLabel.id])
    expect(await ids('no such text')).toEqual([])
    expect(await ids('someone else')).toEqual([])
    expect(foreign.id).toBeDefined()
  })

  it('orders drafts by update time, displayed recipient and subject with an id tie-break across pages', async () => {
    const sorter = { userId: 'sorter', workspaceId: 'workspace' }
    const recipients = [
      { recipientName: 'Beta', to: 'zulu@example.test' },
      { recipientName: ' ', to: 'alpha@example.test' },
      { recipientName: 'alpha@example.test', to: '' },
      { recipientName: '', to: '' },
    ]
    const subjects = ['Eta', 'zeta', 'ETA', '', 'Zeta']
    const drafts = Array.from({ length: 23 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(((index * 5) % 23) + 1).padStart(12, '0')}`,
      ...(recipients[index % recipients.length] as (typeof recipients)[number]),
      subject: subjects[index % subjects.length] ?? '',
      updatedAt: new Date(1_700_000_000_000 + Math.floor(index / 3) * 1000),
    }))
    for (const { id, updatedAt, ...fields } of drafts)
      await owner.query(
        `insert into mail.draft (workspace_id,user_id,id,content,updated_at) values ($1,$2,$3,$4,$5)`,
        [
          sorter.workspaceId,
          sorter.userId,
          id,
          JSON.stringify({ ...content, ...fields }),
          updatedAt,
        ],
      )
    // One legacy row without a subject key must sort like an empty subject.
    const legacy = drafts[3]
    await owner.query(
      `update mail.draft set content=content-'subject' where workspace_id=$1 and user_id=$2 and id=$3`,
      [sorter.workspaceId, sorter.userId, legacy?.id],
    )
    const recipient = (draft: (typeof drafts)[number]) =>
      (draft.recipientName.trim() || draft.to).toLowerCase()
    const keyOf = {
      newest: (draft: (typeof drafts)[number]) => draft.updatedAt.getTime(),
      oldest: (draft: (typeof drafts)[number]) => draft.updatedAt.getTime(),
      'sender-asc': recipient,
      'sender-desc': recipient,
      'subject-asc': (draft: (typeof drafts)[number]) => draft.subject.toLowerCase(),
      'subject-desc': (draft: (typeof drafts)[number]) => draft.subject.toLowerCase(),
    } as const
    const compare = (left: string | number, right: string | number) =>
      left < right ? -1 : left > right ? 1 : 0
    for (const sort of Object.keys(keyOf) as (keyof typeof keyOf)[]) {
      const sign = sort === 'newest' || sort.endsWith('-desc') ? -1 : 1
      const expected = [...drafts]
        .sort(
          (left, right) =>
            sign * (compare(keyOf[sort](left), keyOf[sort](right)) || compare(left.id, right.id)),
        )
        .map(({ id }) => id)
      const first = await repository.list(sorter, 0, '', sort)
      const second = await repository.list(sorter, 20, '', sort)
      expect(first).toHaveLength(21)
      expect([...first.slice(0, 20), ...second].map(({ id }) => id)).toEqual(expected)
    }
  })
  it('discards several drafts, reporting a stale version without stopping the rest', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const third = randomUUID()
    for (const id of [first, second, third]) await save(id)
    await save(second, 1, 'Edited elsewhere')
    const results = await repository.discardMany(context, [
      { id: first, version: 1 },
      { id: second, version: 1 },
      { id: third, version: 1 },
      { id: randomUUID(), version: 1 },
    ])
    expect(results.map(({ status }) => status)).toEqual([
      'discarded',
      'conflict',
      'discarded',
      'conflict',
    ])
    expect(await repository.find(context, first)).toBeNull()
    expect(await repository.find(context, second)).toMatchObject({ subject: 'Edited elsewhere' })
    expect(await repository.find(context, third)).toBeNull()
    expect(
      await repository.discardMany({ ...context, userId: 'other' }, [{ id: second, version: 2 }]),
    ).toEqual([{ id: second, status: 'conflict' }])
  })

  it('rejects attachment and label references from a different owner or workspace', async () => {
    await expect(
      repository.save(context, randomUUID(), {
        ...content,
        version: 0,
        mutationId: randomUUID(),
        attachments: [{ id: randomUUID() }],
      }),
    ).rejects.toThrow('Attachment')
    await expect(
      repository.save(context, randomUUID(), {
        ...content,
        version: 0,
        mutationId: randomUUID(),
        labelIds: [randomUUID()],
      }),
    ).rejects.toThrow('Label')
  })

  it('only completes confirmed sends and preserves edits saved by another tab', async () => {
    const id = randomUUID(),
      sentId = randomUUID()
    await save(id)
    await expect(repository.complete(context, id, 1, sentId)).rejects.toThrow('confirmed')
    await owner.query(
      `insert into mail.outgoing_email
      (workspace_id,user_id,id,payload_hash,"to",cc,bcc,subject,html,text,provider_id,delivery_state)
      values ($1,$2,$3,'hash','[]','[]','[]','','','','provider','sent')`,
      [context.workspaceId, context.userId, sentId],
    )
    await save(id, 1, 'Newer edit')
    await repository.complete(context, id, 1, sentId)
    expect(await repository.find(context, id)).toMatchObject({ subject: 'Newer edit', version: 2 })
    await repository.complete(context, id, 2, sentId)
    expect(await repository.find(context, id)).toBeNull()
    await repository.complete(context, id, 2, sentId)
    await expect(save(id, 2)).rejects.toThrow('changed')
  })
})

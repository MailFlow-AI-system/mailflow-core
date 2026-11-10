import type { MailContext } from '../context/types.js'
import { assertMailContext } from '../context/types.js'
import type { MailClient, MailPool } from '../inbox/listMessages/types.js'
import { inWorkspaceTransaction } from '../infrastructure/database/workspaceTransaction.js'
import {
  type DiscardDraftsResult,
  DraftConflictError,
  type DraftContent,
  DraftReferenceError,
  type SaveDraftInput,
} from './contract.js'

type DraftRow = {
  id: string
  content: DraftContent
  version: number
  mutationId: string | null
  state: string
  updatedAt: Date
}
const empty: DraftContent = {
  to: '',
  cc: '',
  bcc: '',
  recipientName: '',
  subject: '',
  html: '',
  text: '',
  attachments: [],
  labelIds: [],
}
export function createDraftRepository(pool: MailPool) {
  const transaction = <T>(context: MailContext, operation: (client: MailClient) => Promise<T>) => {
    assertMailContext(context)
    return inWorkspaceTransaction(pool, context.workspaceId, async (client) => {
      await client.query("select set_config('mailflow.user_id', $1, true)", [context.userId])
      return operation(client)
    })
  }
  async function read(client: MailClient, context: MailContext, id: string, lock = false) {
    const result = await client.query<DraftRow>(
      `select id,content,version,mutation_id as "mutationId",state,updated_at as "updatedAt"
      from mail.draft where workspace_id=$1 and user_id=$2 and id=$3 ${lock ? 'for update' : ''}`,
      [context.workspaceId, context.userId, id],
    )
    return result.rows[0]
  }
  async function view(client: MailClient, context: MailContext, row: DraftRow) {
    const files = await client.query(
      `select a.id,a.filename,a.content_type as "contentType",a.size::int,a.sha256,d.content_id as "contentId"
      from mail.draft_attachment d join mail.attachment a
      on (a.workspace_id,a.user_id,a.id)=(d.workspace_id,d.user_id,d.attachment_id)
      where d.workspace_id=$1 and d.user_id=$2 and d.draft_id=$3 order by d.position`,
      [context.workspaceId, context.userId, row.id],
    )
    const labels = await client.query(
      `select id,name,color from mail.label where workspace_id=$1 and id=any($2::uuid[]) order by name,id`,
      [context.workspaceId, row.content.labelIds],
    )
    return {
      ...row.content,
      id: row.id,
      version: row.version,
      updatedAt: row.updatedAt,
      attachments: files.rows,
      labels: labels.rows,
    }
  }
  async function finish(client: MailClient, context: MailContext, id: string, state: string) {
    await client.query(
      `update mail.draft set state=$4,content=$5,version=version+1,updated_at=now()
      where workspace_id=$1 and user_id=$2 and id=$3`,
      [context.workspaceId, context.userId, id, state, JSON.stringify(empty)],
    )
    await client.query(
      'delete from mail.draft_attachment where workspace_id=$1 and user_id=$2 and draft_id=$3',
      [context.workspaceId, context.userId, id],
    )
  }
  const discard = (context: MailContext, id: string, version: number) =>
    transaction(context, async (client) => {
      // A tombstone also rejects an initial autosave that has not reached the database yet.
      if (version === 0)
        await client.query(
          `insert into mail.draft (workspace_id,user_id,id,content,state)
        values ($1,$2,$3,$4,'discarded') on conflict do nothing`,
          [context.workspaceId, context.userId, id, JSON.stringify(empty)],
        )
      const row = await read(client, context, id, true)
      if (row?.state === 'discarded') return
      if (row?.state !== 'active' || row.version !== version) throw new DraftConflictError()
      await finish(client, context, id, 'discarded')
    })
  return {
    save: (context: MailContext, id: string, input: SaveDraftInput) =>
      transaction(context, async (client) => {
        const { version, mutationId, ...content } = input
        if (version === 0)
          await client.query(
            `insert into mail.draft (workspace_id,user_id,id,content)
        values ($1,$2,$3,$4) on conflict do nothing`,
            [context.workspaceId, context.userId, id, JSON.stringify(empty)],
          )
        const row = await read(client, context, id, true)
        if (row?.state !== 'active') throw new DraftConflictError()
        if (row.mutationId === mutationId) return view(client, context, row)
        if (row.version !== version) throw new DraftConflictError()
        const ids = content.attachments.map((item) => item.id)
        if (ids.length) {
          const files = await client.query<{ id: string; size: string }>(
            `select id,size from mail.attachment a
          where workspace_id=$1 and user_id=$2 and id=any($3::uuid[]) and status='clean'
          and (expires_at>now() or exists (select 1 from mail.draft_attachment d
            where (d.workspace_id,d.user_id,d.attachment_id)=(a.workspace_id,a.user_id,a.id)))
          order by id for update`,
            [context.workspaceId, context.userId, ids],
          )
          if (
            files.rows.length !== ids.length ||
            files.rows.reduce((sum, file) => sum + Number(file.size), 0) > 20_000_000
          )
            throw new DraftReferenceError('Attachment unavailable')
        }
        const labels = await client.query(
          `select id from mail.label where workspace_id=$1 and id=any($2::uuid[])`,
          [context.workspaceId, content.labelIds],
        )
        if (labels.rows.length !== content.labelIds.length)
          throw new DraftReferenceError('Label unavailable')
        await client.query(
          'delete from mail.draft_attachment where workspace_id=$1 and user_id=$2 and draft_id=$3',
          [context.workspaceId, context.userId, id],
        )
        for (const [position, file] of content.attachments.entries())
          await client.query(
            `insert into mail.draft_attachment (workspace_id,user_id,draft_id,attachment_id,position,content_id)
          values ($1,$2,$3,$4,$5,$6)`,
            [context.workspaceId, context.userId, id, file.id, position, file.contentId ?? null],
          )
        await client.query(
          `update mail.draft set content=$4,version=version+1,mutation_id=$5,updated_at=now()
        where workspace_id=$1 and user_id=$2 and id=$3`,
          [context.workspaceId, context.userId, id, JSON.stringify(content), mutationId],
        )
        return view(client, context, {
          ...row,
          content,
          version: version + 1,
          mutationId,
          updatedAt: new Date(),
        })
      }),
    find: (context: MailContext, id: string) =>
      transaction(context, async (client) => {
        // Keep content and attachment references consistent with concurrent saves.
        const row = await read(client, context, id, true)
        return row?.state === 'active' ? view(client, context, row) : null
      }),
    list: (context: MailContext, offset: number, search = '') =>
      transaction(context, async (client) => {
        // Literal, case-insensitive substring match; LIKE wildcards in the text are escaped.
        const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
        const rows = await client.query(
          `select d.id,d.version,d.content->>'to' as "to",d.content->>'subject' as subject,
        left(d.content->>'text',240) as text,d.updated_at as "updatedAt",jsonb_array_length(d.content->'attachments') as "attachmentCount"
        from mail.draft d where d.workspace_id=$1 and d.user_id=$2 and d.state='active'
        and ($4 = '' or d.content->>'to' ilike $5 or d.content->>'cc' ilike $5
          or d.content->>'bcc' ilike $5 or d.content->>'recipientName' ilike $5
          or d.content->>'subject' ilike $5 or d.content->>'text' ilike $5
          or exists (select 1 from mail.label l
            where l.workspace_id=d.workspace_id and l.name ilike $5
            and l.id::text in (select jsonb_array_elements_text(d.content->'labelIds'))))
        order by d.updated_at desc,d.id desc limit 21 offset $3`,
          [context.workspaceId, context.userId, offset, search, pattern],
        )
        return rows.rows
      }),
    discardMany: async (
      context: MailContext,
      items: { id: string; version: number }[],
    ): Promise<DiscardDraftsResult[]> => {
      const results: DiscardDraftsResult[] = []
      // Each draft has its own transaction so one stale version cannot roll back the others.
      for (const { id, version } of items) {
        try {
          await discard(context, id, version)
          results.push({ id, status: 'discarded' })
        } catch (error) {
          if (!(error instanceof DraftConflictError)) throw error
          results.push({ id, status: 'conflict' })
        }
      }
      return results
    },
    discard,
    complete: (context: MailContext, id: string, version: number, sentId: string) =>
      transaction(context, async (client) => {
        const sent = await client.query(
          `select id from mail.outgoing_email where workspace_id=$1 and user_id=$2
        and id=$3 and provider_id is not null`,
          [context.workspaceId, context.userId, sentId],
        )
        if (!sent.rows.length) throw new Error('The send has not been confirmed')
        const row = await read(client, context, id, true)
        // Preserve a newer edit made by another tab while this version was being sent.
        if (row?.state === 'active' && row.version === version)
          await finish(client, context, id, 'sent')
      }),
  }
}
export type DraftRepository = ReturnType<typeof createDraftRepository>

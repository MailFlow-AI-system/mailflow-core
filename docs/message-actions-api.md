# Message actions API

All endpoints live under `/api/v1/workspaces/{slug}/mail` and require an authenticated workspace member. Writes (`PATCH`, `POST`, `DELETE`) require a trusted `Origin`. Responses are private (`Cache-Control: private, no-store`). The optional `X-Workspace-Identity` request header detects a changed session identity. Errors use Problem Details (`application/problem+json`) with a stable `code`.

## State model

The Inbox is shared by the workspace.

- **Workspace state** (visible to every member): archive, trash and spam. Each records when and by whom (`archivedAt`/`archivedBy`, `trashedAt`/`trashedBy`, `spamAt`/`spamBy`). The actor is a user id; no display name is joined because Mail does not read identity tables. Clearing a state clears its pair.
- **Per-user state** (only the current user): read and starred.
- Flags are independent. The visible location follows the precedence **trash > spam > archive > inbox**, so restoring from Trash returns a message to Spam or Archive if those flags are still set.
- Every change is idempotent. Setting a flag that is already set keeps the original timestamp and actor; reading an already read message keeps the first read time.

### Folders

| `folder` | Messages |
| --- | --- |
| `inbox` (default) | not archived, not in trash, not spam |
| `archive` | archived, not in trash, not spam |
| `trash` | in trash |
| `spam` | spam, not in trash |
| `starred` | starred by the current user, not in trash, not spam (archived starred messages are included) |

### Message state fields

List items, the message detail and the `PATCH` response include:

```json
{
  "isRead": false,
  "isStarred": true,
  "folder": "archive",
  "archivedAt": "2026-10-01T14:00:00.000Z",
  "archivedBy": "user_123",
  "trashedAt": null,
  "trashedBy": null,
  "spamAt": null,
  "spamBy": null
}
```

`folder` is the message location (`inbox`, `archive`, `trash` or `spam`) after precedence. Unset timestamps and actors are `null`, never omitted.

## Endpoints

### List messages

`GET /messages?folder={folder}&q={term}&cursor={cursor}` returns `{ "items": [Message], "nextCursor": "..." | null }`, eight items per page, ordered by `receivedAt` then `id`, both descending. `q` keeps its existing semantics (case-insensitive literal match on sender, recipients, subject, body and label names) and is applied inside the folder before pagination. Pass `nextCursor` unchanged with the same `folder` and `q`.

- `400 invalid_message_query`: unknown `folder` (values are case-sensitive).
- `400 invalid_message_cursor`: malformed cursor.

### Message detail

`GET /messages/{id}` returns the existing detail plus the state fields. Opening a message marks it read for the current user only (`isRead: true` in the response). A missing or foreign message returns `404`.

### Unread counts

`GET /unread-counts` returns the number of unread messages for the current user in each folder:

```json
{ "inbox": 6, "starred": 1, "archive": 2, "trash": 1, "spam": 2 }
```

### Change one message

`PATCH /messages/{id}` with a non-empty subset of `{ "read": boolean, "starred": boolean, "archived": boolean, "trashed": boolean, "spam": boolean }` returns `{ "id": "UUID", ...state }`. Fields that are absent are not changed.

- `400 invalid_message_action`: empty body, unknown field or non-boolean value.
- `403 insufficient_capability`: `archived`, `trashed` or `spam` without `mail.compose`.
- `403 untrusted_origin`.
- `404 message_not_found`: invalid id, or the message does not exist in this workspace.

### Bulk actions

`POST /messages/actions` with:

```json
{ "ids": ["UUID"], "action": "archive" }
```

`action` is one of `read`, `unread`, `star`, `unstar`, `archive`, `unarchive`, `trash`, `restore`, `spam`, `not_spam`, `delete_permanently`. `ids` holds 1 to 100 UUIDs; duplicates are removed (case-insensitively) and results keep the first-seen order. The batch runs in one transaction and returns `200`:

```json
{
  "results": [
    { "id": "UUID", "status": "ok" },
    { "id": "UUID", "status": "not_found" },
    { "id": "UUID", "status": "invalid_state" }
  ]
}
```

- `ok`: applied, or already in the requested state.
- `not_found`: the id does not exist in this workspace.
- `invalid_state`: only for `delete_permanently` when the message is not in Trash.

Errors: `400 invalid_message_action` (invalid body, more than 100 ids), `403 insufficient_capability` (workspace actions without `mail.compose`), `403 untrusted_origin`.

### Delete permanently

`DELETE /messages/{id}` deletes a message that is in Trash for the whole workspace, together with its label links and every member's read and star state. It returns `204`.

- `409 message_not_in_trash`: the message exists but is not in Trash.
- `404 message_not_found`: invalid id or unavailable message.
- `403 insufficient_capability` / `403 untrusted_origin`.

## Capabilities

| Operation | Capability |
| --- | --- |
| List, detail (including the automatic read), unread counts | `mail.read` |
| `read`, `unread`, `star`, `unstar` (bulk or `PATCH`) | `mail.read` |
| `archive`, `unarchive`, `trash`, `restore`, `spam`, `not_spam` (bulk or `PATCH`) | `mail.compose` |
| `delete_permanently`, `DELETE /messages/{id}` | `mail.compose` |

Read and star only change the caller's own view, so read-only roles (Viewer, Analyst) can use them. Moving messages changes what every member sees, which matches the existing write capability. `PATCH` and bulk routes are listed with `mail.read` in the capability policy; their handlers additionally require `mail.compose` as soon as a request changes workspace state.

## Deployment

Apply Mail migration `0013_add_message_actions` before starting the new version. It adds nullable state columns and partial folder indexes to `mail.message` and creates `mail.message_user_state` with forced RLS on workspace and user. The migration grants the new table to `mailflow_runtime` when that role exists; otherwise repeat the [runtime role grants](../infrastructure/database/runtimeRole.sql).

The QA seed (`bun run db:seed:mail ...`) also applies read, star, archive, trash and spam fixtures for the workspace owner. Each QA message is configured once: the owner's state row marks it, so reruns keep later changes, and a folder is only set on a message without folder state.

## Listening

- Archive, trash and spam are timestamp/actor pairs instead of a single folder enum, so restoring one state keeps the others and the audit trail needs no history table. Precedence is applied when reading.
- Read and star live in a separate per-user table instead of arrays on the message, which keeps RLS per member and avoids rewriting shared rows.
- The capability table is path-based, so mixed `PATCH` bodies and bulk actions are checked in the handlers; splitting them into per-capability routes was rejected because it would duplicate the bulk contract.
- Actor display names are not returned; joining `identity_workspace.user` from Mail would cross the module boundary and widen the runtime role. Clients can compare the actor with the session user id to show "you".

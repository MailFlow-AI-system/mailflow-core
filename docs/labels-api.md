# Labels API (phase 1)

All endpoints require an authenticated workspace member. Writes require a trusted `Origin`. Responses are private and must not be shared between workspaces or signed-in identities. The optional `X-Workspace-Identity` request header detects a changed session identity.

A label has `{ "id": "UUID", "name": "Invoice", "color": "#2563eb" }`. Names are trimmed, limited to 100 characters and unique case-insensitively per workspace. The server persists a color from a fixed palette. When the caller omits a color, the least-used palette color is allocated under a workspace lock.

- `GET /api/v1/workspaces/{slug}/mail/labels?q={term}&cursor={cursor}` returns `{ "items": [Label], "nextCursor": "..." | null, "exactMatch": Label | null }`. The default and only page size is five. Search is case-insensitive and treats `%`, `_`, and backslash literally. `exactMatch` searches the whole workspace, independently of pagination. Empty queries have a null exact match. Use the returned opaque cursor with the same query; a null cursor marks the last page.
- `GET /api/v1/workspaces/{slug}/mail/labels/palette` returns `{ colors, suggestedColor }` for the workspace. The recommendation is the least-used palette color at the time of the request.
- `POST /api/v1/workspaces/{slug}/mail/labels` with `{ "name": "Invoice", "color": "#9333ea" }` returns the persisted label with status 201. The optional `color` must be in the palette. A concurrent or existing case-insensitive duplicate returns 409 with problem code `label_exists`; refresh the search after a conflict.
- `GET /api/v1/workspaces/{slug}/mail/{messages|sent}/{messageId}/labels` returns `{ "items": [Label] }`.
- `PUT` and `DELETE /api/v1/workspaces/{slug}/mail/{messages|sent}/{messageId}/labels/{labelId}` add and remove a label idempotently and return the current `{ "items": [Label] }`. Invalid or inaccessible messages and labels return 404. Sent messages are available only to their owner in the active workspace and must have a provider ID, matching the existing Sent reader. Inbox messages use workspace visibility.

The client should fetch labels for the opened message and replace its local selection with the mutation response. Inbox and Sent list/detail payloads include a `labels` array containing the same label objects. Inbox search also matches the names of associated labels. Composer support is deferred; an editing entry point and Categories remain product decisions.

## Deployment

Apply mail migrations before starting the new application version. Migration 0011 grants the three new tables to `mailflow_runtime` if that role exists. For a role provisioned after migration, or a deployment using another runtime role, grant access using the existing [runtime role procedure](../infrastructure/database/runtimeRole.sql) or the corresponding least-privilege procedure. The application role must not bypass row-level security.

## Listening

Inbox and Sent use separate association tables because Sent ownership includes the user, while Inbox visibility is workspace-wide. This preserves the existing access model and lets foreign keys enforce each target's identity. An association keyed only by message UUID was rejected because it cannot enforce both identities. Palette colors may repeat; custom colors and editing are deferred.

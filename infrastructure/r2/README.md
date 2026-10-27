# R2 attachment infrastructure

Cloudflare account: `4b2ab2e9aea9bd23a79bc01a05b7c540` (`mailflow26@gmail.com`).

| Application environment | Infisical environment | Private Standard bucket |
| --- | --- | --- |
| development | dev | mailflow-attachments-development |
| staging | staging | mailflow-attachments-staging |
| production | prod | mailflow-attachments-production |

Buckets use the `enam` location hint, which is best effort rather than a data-residency guarantee.
Public `r2.dev` access and custom public domains must remain disabled.

The JSON files use the Cloudflare REST API format. Apply each CORS policy to its
bucket at `PUT /accounts/{accountId}/r2/buckets/{bucket}/cors`, the shared lifecycle
policy at `/lifecycle`, and `managedDomain.json` at `/domains/managed`. Read each
configuration back afterward. Authentication belongs in the operator session;
credentials must never be written into these files.

The browser uploads through signed PUT requests. Development permits `*` CORS
for arbitrary local ports; staging and production retain exact Web origins.
This does not publish the buckets or remove the signed-URL requirement. Web's
standard development port is 3000 with `strictPort`, so a busy port reports an
error rather than silently selecting another port.

Object keys belong to a workspace and Mail purpose:

```text
uploads/{workspaceId}/mail/attachments/{attachmentId}
workspaces/{workspaceId}/mail/attachments/{attachmentId}/{versionId}
```

The workspace segment is encoded; names and original filenames stay in metadata.
Unique final versions preserve immutable completion and retry safety. Core checks
both workspace membership and owner access before signing or reading a file.

Only `uploads/` and legacy `pending/` objects expire after one day. Never apply a
blanket expiration to `workspaces/` or legacy `objects/`: those keys may back sent
messages. Core's cleanup handles unassociated metadata and old orphan final
objects, recognizes only Mail key shapes, and preserves referenced legacy files.
Existing objects are not moved or assigned to guessed workspaces by this change.

Draft discard expires only unassociated files and releases reservations or provider
rejections proven safe to cancel. The hourly cleanup also releases safe abandoned
attempts after 24 hours. Accepted, active and uncertain attempts retain their files;
a timeout never authorizes deletion. Coordinate writer versions during rollout.

Store `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` under `/mailflow-core` in each matching Infisical environment.
Issue a different Object Read & Write token restricted to that environment's bucket.
Runtime tokens have no automatic expiration and require deliberate rotation. They
were created through the authenticated R2 dashboard without creating an additional
administrative provisioning token. Keep the credentials out of frontend variables,
repository files, and command output.

## Listening

Environment buckets and bucket-scoped runtime credentials prevent an application
from selecting another environment's files. Private buckets plus workspace membership and owner checks in
Core preserve access control; a CORS allowlist is not object authorization. Uploads
use temporary keys and verified server-only immutable copies so replaying a PUT
cannot change bytes that were verified or attached to a sent message.

Legacy list query isolation is owned by a separate task. Current context checks
protect sending and attachment access; they do not broaden workspace members'
visibility or imply that the existing list reads are already tenant-isolated.

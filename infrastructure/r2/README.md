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

The browser can upload through signed PUT requests from the listed origins. File
reads pass through authenticated Core download routes. Local origins enumerate
ports explicitly because R2 does not support port wildcards; add a deliberate
origin when using another development port.

Only `pending/` objects expire after one day. Never apply a blanket expiration to
`objects/`: those objects may back immutable sent-message attachments. Core's
attachment cleanup command handles unassociated metadata and orphan final objects.

Store `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` under `/mailflow-core` in each matching Infisical environment.
Issue a different Object Read & Write token restricted to that environment's bucket.
Runtime tokens have no automatic expiration and require deliberate rotation. They
were created through the authenticated R2 dashboard without creating an additional
administrative provisioning token. Keep the credentials out of frontend variables,
repository files, and command output.

## Listening

Environment buckets and bucket-scoped runtime credentials prevent an application
from selecting another environment's files. Private buckets plus owner checks in
Core preserve access control; a CORS allowlist is not object authorization. Uploads
use temporary keys and verified server-only immutable copies so replaying a PUT
cannot change bytes that were verified or attached to a sent message.

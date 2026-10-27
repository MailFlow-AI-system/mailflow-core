# DEV localhost rollout

Local Core uses the restricted `mailflow_runtime` login from Infisical `dev`, path
`/mailflow-core`, in `DATABASE_URL`. The DEV API service uses the same restricted
runtime login. `DIRECT_URL` retains the migration administrator and is never used
as the application's runtime connection.

The shared DEV database was reconciled through Railway's existing pre-deploy:
`node dist/entrypoints/migrate.js`. The deployment used the CI-verified PR commit
without merging or changing the connected `development` branch. A subsequent
commit-specific deployment verified the migration history again with the restricted
runtime configuration. The Identity and Mail ledger verification gates passed.

For the local application, run `bun run dev` in Core and Web. The Core local runner
checks role/schema prerequisites before enabling local workspace capabilities.
The generic `http://localhost:3000` entry resolves the authenticated account's live
membership/preference; explicit tenant hosts keep their own workspace context.
Published workspace feature flags remain separate from these local defaults.

Historical Inbox rows with no verified workspace remain preserved and hidden by RLS.
An empty scoped Inbox is valid; never assign historical ownership from a guessed
workspace or disable RLS to recover the old global listing.

## Listening

A one-off deployment of the existing PR commit was selected so the normal build,
pre-deploy and readiness checks could run without a merge. Running migration SQL
manually or changing ledger entries was rejected. Runtime credentials were changed
only after reconciliation and privilege verification, keeping migration credentials
separate. Historical Inbox ownership still requires explicit verification before
any future mapping; image rollback does not undo the schema migration.

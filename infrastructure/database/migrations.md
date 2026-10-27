# Migration deployment

The API pre-deploy runs `node dist/entrypoints/migrate.js` in every environment.
Use `DIRECT_URL` for the same database as runtime, without transaction pooling.

The runner holds one advisory lock, validates every selected module's applied
hashes and timestamps before application SQL, then applies missing migrations
transactionally per module. It verifies the complete history before reporting
success. Unknown, changed, duplicate, missing-prefix or reordered entries fail
the command. Never edit applied SQL or repair a ledger by inventing entries.

## Reconciled Mail histories

- Send migrations `0000` through `0005` keep their original SQL and timestamps.
- PR #24's already-applied `0001_workspace_inbox` is accepted only with its exact
  historical hash and timestamp. Its destructive SQL is archived under
  `database/migrations/mail/legacy/` and never scheduled for new execution.
- `0006_preserve_workspace_inbox` adds workspace isolation without deleting
  messages. Existing unassigned Inbox rows retain their content and a nullable
  workspace. A `NOT VALID` constraint rejects new unscoped writes; forced RLS
  hides unassigned rows from workspace reads. Map historical ownership only
  after it has been verified; the migration never guesses a workspace.
- A PR #24-only database receives the missing Send migrations even though their
  timestamps precede the historical Inbox entry. Existing ledger rows remain
  unchanged; only SQL actually executed by this runner receives a new entry.
- `0007_add_delivery_lifecycle` conservatively marks historical and old-writer
  reservations as uncertain. Current writers explicitly create ready attempts.

Image rollback does not roll back SQL. Validate changes on disposable databases
and deploy compatible writers together. Drain older Send writer processes before
enabling the new discard flow; an old in-flight writer cannot participate in the
new attempt/cancellation protocol. The runner cannot recover data removed
by a migration that was executed before this reconciliation.

## Listening

The reconciliation preserves both legitimate histories instead of resetting the
ledger or replaying the destructive Inbox migration. Legacy messages remain
unassigned and inaccessible until ownership is explicitly established. Historical Sent rows without a workspace also remain stored, but scoped reads
exclude them until ownership is verified. Unknown histories block deployment for
investigation rather than being silently skipped.

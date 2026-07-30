# Account deletion, and the position on backups

`docs/PLAN.md` Gate L requires `DELETE /v1/me` and `GET /v1/me/export` "verified end to end
including cascade to the identity provider, Redis, and logs" plus a **documented backup-retention position for
deleted data**. The first three are machine-checked by
`apps/bff/test/integration/platform.test.ts`. This document is the fourth.

## What the route requires

Deletion is the only irreversible operation in the API, so it carries three gates no other route
does:

1. **A session, never a personal API token.** Tokens are read-only and are refused with 403. A
   leaked read credential must not be able to destroy what it can read.
2. **Recent authentication** (`THREAT-MODEL.md` M16). The access token must have been issued within
   `DELETE_FRESH_AUTH_MAX_AGE_S` (default 15 minutes), so a long-lived token found in a shell history
   or a log cannot delete an account months later.
3. **The account email, typed back** in the request body. Deliberate friction on an irreversible
   action, and a confirmation that requires knowing the address rather than just holding a token.

CSRF is structurally impossible here: authentication is a bearer token and never a cookie, so a
cross-site form post carries no credential at all. M16 asks for a fresh-auth proof "that is not a
cookie", and the scheme satisfies that by construction.

## What the cascade does

| Destination       | Behaviour                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres          | One `DELETE FROM users`. Every user-owned table declares `ON DELETE CASCADE`, so this is transactional by construction rather than an application sweep that can partially fail. `packages/db/scripts/verify-migrations.mjs` asserts it against a real database on every CI run.              |
| Identity provider | A `DELETE` against the identity provider. Best effort and recorded: on failure the local rows are still gone and the deletion log records that the upstream call did not succeed, so the retry is a query rather than an investigation.                                                       |
| Redis             | Cache entries and quota counters keyed by the subject, removed with `SCAN`, never `KEYS`. A blocking scan on the quota instance would time out every rate-limit check in flight, and deletion is exactly the operation most likely to run against a large keyspace at an inconvenient moment. |
| Logs              | Log records carry the subject id and the request id, never an email or a credential. Retention is bounded by the log-retention policy; there is no per-record deletion because there is no personal data in a record to delete beyond an opaque identifier.                                   |
| Backups           | **Not rewritten.** See below.                                                                                                                                                                                                                                                                 |

Ordering matters and is chosen so that a failure at any point leaves a recoverable state:

1. The `deletion_log` request row is written **first**. If everything after it fails, there is a
   durable record that erasure was requested and the sweep can retry. A log written last would be
   lost by the failure it exists to record.
2. The Postgres rows go in one transaction.
3. Upstream and Redis, both best effort, both recorded in the completed log row.

## The backup position

> **Status, 2026-07-29: this now describes a system that exists, has been drilled, and is
> scheduled.** The earlier version of this block described pgBackRest against a self-managed
> Postgres node. That node no longer exists: the database moved to a managed provider, and
> pgBackRest was never deployed. A later version of this block correctly recorded that **nothing
> invoked the dump on a schedule**. That is now fixed; see the correction under the table for what
> was done and for the one part of the retention claim that is still unverified.
>
> **Later the same day the estate moved out of the European Union, and two things below moved with
> it.** The provider point-in-time-recovery window is now **7 days** rather than 6 hours, because the
> replacement database project is on a paid plan; the figure in the table has been corrected and was
> read back from the provider API rather than from configuration. The dump and ledger layers were
> re-created against United States object storage, so **the specific drilled artefacts described
> below were in storage that has since been deleted**, and the drill is evidence about the mechanism
> rather than about the objects currently there. The mechanism is unchanged. The **35 days** remains
> configured-but-unconfirmed for the reason given below, which the move did not fix.

Backups are three layers, because no single one covers what the others do not:

| Layer                                    | Covers                                                                     | Window                              |
| ---------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| Provider point-in-time recovery          | a wrong delete or bad migration, noticed quickly                           | **7 days**                          |
| A pinned restore branch                  | planned destructive operations, any age                                    | kept until deliberately released    |
| Encrypted logical dump in object storage | loss of the database project itself, or a fault older than the PITR window | **35 days** scheduled, 90 preflight |

**Two corrections to the table, because a retention window is not a backup.**

**1. There is now a scheduler, and until 2026-07-29 there was not.** The 35 day figure is a
retention policy applied to scheduled dumps, and on the staging deployment nothing was producing
them: the tooling existed and was exercised by the restore drill, but no timer invoked it, so the
only objects in the bucket were drill artifacts. Found by enumerating the node's timers rather than
by reading this repository, which is the point - every artifact needed to schedule it was committed,
so reading the code would have concluded the control was present. `pullfm-backup-dump.timer` is now
installed and enabled on the staging node, fires daily at 03:23 UTC, alerts through the same
`pullfm-job-alert@` path as the application jobs, and has produced a verified object under
`dumps/scheduled/`. **Daily is derived from the retention number rather than chosen next to it:**
retention is a window and what can be restored to is the window divided by the interval, so daily
gives about 35 recovery points inside 35 days where weekly would give five.

**2. The 35 days is a bucket lifecycle rule that we can no longer read, and therefore no longer
verify.** The backup credential was narrowed to a bucket-scoped object token (the fix for a separate
finding, where an account-wide grant turned out to read every bucket in the estate). R2 treats
lifecycle configuration as a bucket-admin operation, so that token is refused
`GetBucketLifecycleConfiguration`. The conformance check now says so plainly instead of reporting
the rules as missing, and it is run from an operator credential rather than from the node. Until it
is next run that way, **treat the 35 days as configured-but-unconfirmed**, not as verified.

The first two layers are unaffected and are provider-managed.

**A scheduled dump does not contain everything in the database, and says so.** The rows of the
imported MusicBrainz catalogue are excluded and their schema is kept, because that table is an
import of a published upstream dataset that a committed command rebuilds, and at 31.5 million rows
it was 99.99% of the database by size. Every manifest lists what was excluded, so an artifact can
never be quietly less than it appears. Nothing a user gave us is excluded.

A deleted user's rows therefore continue to exist inside encrypted artifacts until the last one
containing them ages out, and that is now a stated number rather than an open question.

**We do not attempt to erase from backups.** The reason is the one the ICO, the EDPB, and every
serious analysis of Article 17 give: selectively rewriting a backup destroys its integrity, which
defeats the purpose of having one, and the attempt would itself be a larger risk to every other
user's data than the residual retention is to the deleted one.

The position we take instead, which is the one regulators accept:

1. **Backups are put beyond use.** Logical dumps are encrypted before upload under a dedicated
   passphrase held outside the database, access-controlled to a
   scoped object-storage credential, and never queried to serve live traffic. That key inherits the KEK's escrow
   obligation: losing it makes every dump unreadable.
2. **Retention is bounded and stated.** Deleted data disappears from the backup set when the last
   backup containing it expires. For the provider layer that is the documented PITR window, **7
   days**, so a deletion is not beyond recovery until seven days have passed; for the dump layer it
   is the lifecycle window in the table.
3. **A restore replays the deletions, from a list held outside this database.** The authoritative
   replay list is an append-only erasure ledger in object storage, one immutable object per erasure.
   Any restored user id present in the ledger is re-deleted before the restored system serves
   traffic, which is what makes erasure durable across a restore.

   The ledger object is written **inline with the deletion cascade, before anything is destroyed**.
   If that write fails the request returns 503 and deletes nothing, so a caller can tell "we did not
   delete you, retry" from "we deleted you and something else went wrong". The erasure is therefore
   durable at the moment of the request rather than at the next run of a job.

   **The ledger has its own bucket, and that is a boundary rather than tidiness.** Object-storage
   credentials here scope to a bucket and never to a key prefix, so a credential that let the API
   write ledger entries inside the backup bucket would also let a compromised API destroy every
   backup. The API holds a credential that reaches the ledger bucket and nothing else.

   Append-only is enforced by a **retention lock on that bucket**, not by the credential: the
   platform has no write-only permission, so the write credential can also read and delete, and the
   lock is what refuses both. Verified by attempting them: a delete and an overwriting write are
   both rejected. The honest limit of that guarantee is recorded in the internal risk register -
   the lock is administered by the same account that administers everything else, so it defends the
   ledger against a compromised application and not against a compromised account.

   **`deletion_log` is NOT the replay list, and cannot be.** This document previously said it was.
   A restore drill on 2026-07-29 disproved it directly: erasing an account after a restore point and
   then restoring to before it left the account present and `deletion_log` holding zero rows. The
   list lived inside the thing being rolled back, so the rollback took the evidence with it. A replay
   list has to survive the restore to be a replay list.

   `deletion_log` keeps its real job: it is the in-database record that an erasure happened, it
   deliberately has no foreign key to `users` so its rows outlive the deletion they record, it holds
   no personal data beyond the id that was erased, and the replay rebuilds it from the ledger.

   The ten-minute exporter that used to be the only writer still runs, now as a reconciler: it
   backfills records that predate the inline write and is the only thing that would notice the two
   records diverging. It is idempotent, so running it against a ledger the API already wrote costs
   one existence check per row and changes nothing.

4. **Third-party credentials in a backup are ciphertext.** Backup encryption keys are not
   per-user, so there is no per-user crypto-shredding claim to make here. The claim that IS true:
   a restored backup of a deleted account yields AES-256-GCM ciphertext under a KEK that never
   entered the database trust domain, so it yields no usable credential.

The response to `DELETE /v1/me` states a short form of this to the user in
`backupRetentionNotice`, so the position is disclosed at the moment of deletion rather than only in
a policy document nobody reads.

## Deletion triggered upstream

The identity-provider webhook route handles the upstream deletion event, without which an identity deleted at the provider
would orphan our data forever. That is a GDPR problem as much as a correctness one.

The webhook is the reason signature verification on that route is rated Critical
(`THREAT-MODEL.md` T20): it is unauthenticated by definition, published in the public API surface,
and it cascades. Verification is HMAC-SHA256 over the **raw** body, compared in constant time, inside
a five minute replay window, and the route fails closed with 503 if no signing secret is configured.
Production refuses to start at all without one.

When the cascade is triggered by a verified webhook, the upstream deletion call is skipped: the
identity is already gone, the call would 404, and treating that as a failure would fill the deletion
log with retries that can never succeed.

## Verified by

| Assertion                                                                               | Where                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cascade empties every user-owned table, both Redis instances, and the upstream identity | `test/integration/platform.test.ts`                     |
| `deletion_log` records the outcome and survives the deletion                            | same                                                    |
| Deletion requires fresh auth and the account email                                      | same                                                    |
| A personal API token cannot reach the route                                             | `test/integration/tokens.test.ts`                       |
| An unsigned or forged webhook deletes nothing                                           | `test/integration/platform.test.ts`                     |
| Signature verification is over raw bytes, constant time, replay-windowed                | `src/routes/v1/webhooks.test.ts`                        |
| The schema cascade holds against a real database                                        | `packages/db/scripts/verify-migrations.mjs` (Gate 1 CI) |

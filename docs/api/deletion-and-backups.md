# Account deletion, and the position on backups

`docs/PLAN.md` Gate L requires `DELETE /v1/me` and `GET /v1/me/export` "verified end to end
including cascade to WorkOS, Redis, and logs" plus a **documented backup-retention position for
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

| Destination | Behaviour                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres    | One `DELETE FROM users`. Every user-owned table declares `ON DELETE CASCADE`, so this is transactional by construction rather than an application sweep that can partially fail. `packages/db/scripts/verify-migrations.mjs` asserts it against a real database on every CI run.              |
| WorkOS      | A `DELETE` against the identity provider. Best effort and recorded: on failure the local rows are still gone and `deletion_log.workos_deleted` is `false`, so the retry is a query rather than an investigation.                                                                              |
| Redis       | Cache entries and quota counters keyed by the subject, removed with `SCAN`, never `KEYS`. A blocking scan on the quota instance would time out every rate-limit check in flight, and deletion is exactly the operation most likely to run against a large keyspace at an inconvenient moment. |
| Logs        | Log records carry the subject id and the request id, never an email or a credential. Retention is bounded by the log-retention policy; there is no per-record deletion because there is no personal data in a record to delete beyond an opaque identifier.                                   |
| Backups     | **Not rewritten.** See below.                                                                                                                                                                                                                                                                 |

Ordering matters and is chosen so that a failure at any point leaves a recoverable state:

1. The `deletion_log` request row is written **first**. If everything after it fails, there is a
   durable record that erasure was requested and the sweep can retry. A log written last would be
   lost by the failure it exists to record.
2. The Postgres rows go in one transaction.
3. Upstream and Redis, both best effort, both recorded in the completed log row.

## The backup position

pgBackRest retains WAL and full backups in Cloudflare R2 for the point-in-time-recovery window. A
deleted user's rows therefore continue to exist inside encrypted backup artifacts until the last
backup containing them ages out.

**We do not attempt to erase from backups.** The reason is the one the ICO, the EDPB, and every
serious analysis of Article 17 give: selectively rewriting a backup destroys its integrity, which
defeats the purpose of having one, and the attempt would itself be a larger risk to every other
user's data than the residual retention is to the deleted one.

The position we take instead, which is the one regulators accept:

1. **Backups are put beyond use.** Encrypted at rest with the pgBackRest repository cipher,
   access-controlled to a single scoped R2 credential, and never queried to serve live traffic.
2. **Retention is bounded and stated.** Deleted data disappears from the backup set when the last
   backup containing it expires, within the documented PITR window.
3. **A restore replays the deletions.** The `deletion_log` rows in this database are the
   authoritative replay list: any restored user id present in `deletion_log` is re-deleted before the
   restored system serves traffic. That makes the erasure durable across a restore, which is the
   property the regulation actually cares about. `deletion_log` deliberately has no foreign key to
   `users`, so those rows survive the deletion they record, and they hold no personal data beyond the
   id that was erased.
4. **Third-party credentials in a backup are ciphertext.** Backup encryption keys are not
   per-user, so there is no per-user crypto-shredding claim to make here. The claim that IS true:
   a restored backup of a deleted account yields AES-256-GCM ciphertext under a KEK that never
   entered the database trust domain, so it yields no usable credential.

The response to `DELETE /v1/me` states a short form of this to the user in
`backupRetentionNotice`, so the position is disclosed at the moment of deletion rather than only in
a policy document nobody reads.

## Deletion triggered upstream

`POST /v1/webhooks/workos` handles `user.deleted`, without which an identity deleted at the provider
would orphan our data forever. That is a GDPR problem as much as a correctness one.

The webhook is the reason signature verification on that route is rated Critical
(`THREAT-MODEL.md` T20): it is unauthenticated by definition, published in the public API surface,
and it cascades. Verification is HMAC-SHA256 over the **raw** body, compared in constant time, inside
a five minute replay window, and the route fails closed with 503 if no signing secret is configured.
Production refuses to start at all without one.

When the cascade is triggered by a verified webhook, the WorkOS deletion call is skipped: the
identity is already gone, the call would 404, and treating that as a failure would fill the deletion
log with retries that can never succeed.

## Verified by

| Assertion                                                                | Where                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Cascade empties every user-owned table, both Redis instances, and WorkOS | `test/integration/platform.test.ts`                     |
| `deletion_log` records the outcome and survives the deletion             | same                                                    |
| Deletion requires fresh auth and the account email                       | same                                                    |
| A personal API token cannot reach the route                              | `test/integration/tokens.test.ts`                       |
| An unsigned or forged webhook deletes nothing                            | `test/integration/platform.test.ts`                     |
| Signature verification is over raw bytes, constant time, replay-windowed | `src/routes/v1/webhooks.test.ts`                        |
| The schema cascade holds against a real database                         | `packages/db/scripts/verify-migrations.mjs` (Gate 1 CI) |

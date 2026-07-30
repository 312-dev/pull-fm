# Runbook: disaster recovery (Gates 4 and 6)

> **Gate 4 criterion:** restore completes **under 30 minutes wall clock, timed**;
> row count and checksum match the source; RPO verified rather than assumed; the
> drill re-runs monthly and alerts on failure.
>
> **Status: the database half PASSES and is measured. The application-node half
> still FAILS.** Both were run, not estimated. Section 5 is the drill and its
> numbers; section 2 is the node failure, which is unchanged and is not a
> database problem.
>
> **pgBackRest is gone and is not coming back.** The database moved to Neon on
> 2026-07-29, so `wal_level`, `archive_command` and a pgBackRest stanza describe
> nothing that exists. Every procedure below is written against Neon and against
> `infra/backup/`, and was executed on 2026-07-29.

---

## 1. Recovery objectives, measured

There are three recovery layers and they cover different failures. Quoting a
single RTO or RPO for "the database" is what produced the last set of numbers
nobody could defend, so the table is per layer.

| Layer                     | Covers                                                               | Measured RTO                | RPO                                       | Ceiling                                                       |
| ------------------------- | -------------------------------------------------------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| **Neon PITR**             | wrong `DELETE`, bad migration, anything noticed fast                 | **5.9 s**                   | **0, to the second, verified**            | **6 hours.** `history_retention_seconds = 21600` on this plan |
| **Pinned restore branch** | a planned destructive operation; a known-good marker to fall back to | **6.1 s**                   | the instant it was pinned                 | one of **ten** branch slots, and see the lineage note in 5.4  |
| **Logical dump in R2**    | Neon account or project loss; anything older than 6 hours            | **22.3 s** for a 44 KB dump | **24 hours** (the nightly job's interval) | grows with the database; the only copy outside the vendor     |

**RTO is measured from the decision to restore to the first successful query
from a client**, not to the control plane saying "ready". Those are different
moments and only the second one is the one users experience.

**Against the Gate 4 budget of 30 minutes, the database is not the risk.** The
slowest of the three paths finished in 22 seconds. What is unmeasured, and what
actually decides whether the service is back, is the application node in section 2.

**What none of these cover.** A restore does not replay deletions on its own.
Section 5.3 is the drill that proved that, and it is a legal obligation rather
than an optimisation. Budget the replay into any real RTO: it is one command and
took **11.3 s** in the drill, but skipping it un-deletes people who asked to be
gone.

---

## 2. The other half: an environment that cannot rebuild itself

Measured 2026-07-29, by doing it:

| Step                                       | Result                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `./infra/staging-env.sh down`              | 19 resources destroyed, run rate EUR 0.00/mo, R2 bucket survived |
| `./infra/staging-env.sh up`                | **45 seconds**, 19 resources created, LB reclaimed the same IPv4 |
| `curl https://api-staging.pull.fm/healthz` | **HTTP 525 for five straight minutes**                           |
| Hetzner LB target health                   | **unhealthy on both 80 and 443**                                 |

**Why.** Terraform's job ends at a booted node. nginx, the origin certificate,
the BFF container, the deploy timer and Redis are all applied by a human over
SSH. cloud-init deliberately installs none of it, because that would put
`/etc/pullfm/bff.env` (the KEK, the WorkOS key, `DATABASE_URL`) into `user_data`,
which is persisted in Terraform state and readable from the Hetzner API for the
life of the server. **That decision is correct.** What is missing is the
automated, secret-free path that should have replaced it.

**The fix is config management, not more Terraform.** The node must converge on
its own from a signed, secret-free artifact, pulling secrets at first boot the
same way `pullfm-deploy` already pulls images. Setting `tailscale_auth_key` would
restore a way in, but **a way in for a human is not a rebuild**.

**This is now the only thing between Gate 4 and green.** The database half of a
restore drill is done, timed and repeatable. The node half has still never been
timed, which means the honest end-to-end RTO is unknown even though every
component of it that this runbook owns is measured in seconds.

---

## 3. Scenario index

Find the row that matches, then read that section. Ordered by how bad it is, not
how likely.

| #   | Scenario                                     | Recoverable?                                                         | Section                                                           |
| --- | -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **KEK lost** (both escrow copies)            | **NO.** Every stored third-party credential is permanent ciphertext. | [4](#4-key-loss-the-only-truly-unrecoverable-one)                 |
| 2   | **Backup cipher key lost**                   | **NO** for the R2 dumps. Neon's own history is unaffected.           | [4](#4-key-loss-the-only-truly-unrecoverable-one)                 |
| 3   | **KEK disclosed**                            | Yes, by rotation                                                     | [4](#4-key-loss-the-only-truly-unrecoverable-one)                 |
| 4   | Wrong `DELETE`, bad migration, noticed < 6 h | Yes, PITR, seconds                                                   | [5.1](#51-pitr-the-first-thing-to-reach-for)                      |
| 5   | The same, noticed **> 6 h** later            | Yes, from the nightly dump, losing up to a day                       | [5.5](#55-restoring-from-a-dump)                                  |
| 6   | About to do something destructive            | Pin a restore point first. Non-negotiable.                           | [5.4](#54-pinning-a-restore-point-before-a-destructive-operation) |
| 7   | A deleted account came back after a restore  | Yes, and it **will** happen. Replay from the ledger.                 | [5.3](#53-the-deletion-replay-finding)                            |
| 8   | Neon project or organisation lost            | Yes, from the R2 dump, into any Postgres 18                          | [5.5](#55-restoring-from-a-dump)                                  |
| 9   | Application node lost                        | Yes, rebuild - but see section 2                                     | [6](#6-rebuilding-the-application-node)                           |
| 10  | Whole Hetzner project lost                   | Yes, in principle                                                    | [7](#7-whole-environment-loss)                                    |
| 11  | **Cloudflare account suspended**             | Partially. DNS, TLS, R2 dumps and the edge all go at once.           | [8](#8-cloudflare-account-loss-pullfm-risk-001)                   |
| 12  | R2 bucket lost                               | Only if Neon is alive                                                | [5.1](#51-pitr-the-first-thing-to-reach-for)                      |
| 13  | WorkOS unavailable                           | Existing sessions survive; nobody new can sign in                    | [9](#9-vendor-unavailability)                                     |
| 14  | Upstream provider revokes us                 | **Product-ending, not operational**                                  | [9](#9-vendor-unavailability)                                     |
| 15  | **Operator unavailable**                     | Bus factor 1                                                         | [10](#10-bus-factor-1)                                            |

---

## 4. Key loss: the only truly unrecoverable one

There are now **two** keys in this class, and the second one is new.

### The KEK

A 256-bit application key that wraps every per-user data key. It lives in
1Password and in one offline copy, both held by one person (`PULLFM-RISK-003`).

**If both copies are lost**, every stored ListenBrainz token and Last.fm session
key becomes permanent ciphertext. No backup helps: the backups contain the same
ciphertext. The only recovery is to have every user reconnect every service, and
the honest framing is that this is not a recovery, it is a data loss with a
re-onboarding.

**If the KEK is disclosed** (as opposed to lost), the answer is rotation, and
this is why `kek_id` exists in the schema from day one. Rotation re-wraps data
keys and never touches token plaintext, so it is an online operation, and the
`user_connections (kek_id)` index drives the backfill.

`[OPEN]` **The rotation drill has never been rehearsed.** `PULLFM-RISK-003`'s
review notes say that if it has not been, the risk should be rated **critical**,
because rotation is the only incident response available for a suspected KEK
disclosure. Rehearse it against staging before it is needed, and record the
elapsed time here.

### The backup cipher key (`pull-fm/infra/BACKUP_DUMP_KEY`)

New on 2026-07-29, and it inherits the KEK's escrow obligation rather than
getting a weaker one.

pgBackRest used to encrypt the repository with its own cipher. pgBackRest is
gone, and R2's own encryption is under Cloudflare's key, which means an R2 access
key leak would have exposed every dump in plaintext. So `pullfm-backup.sh`
encrypts client-side: AES-256-CBC under a PBKDF2-derived key, then HMAC-SHA256
over the ciphertext with an independent key. Both halves are on one 1Password
item.

**Losing that item makes every dump in R2 unreadable noise.** The dumps are the
only copy of this database outside Neon, so losing the key collapses the layered
strategy in section 1 to whatever Neon still holds.

**Prevention, which is the entire control, for both keys:**

- Two independent escrows, one of them offline and held separately from the
  laptop.
- A printed 1Password Emergency Kit and a nominated account recovery contact.
- **Verify both copies are readable at every risk review.** An untested escrow is
  not an escrow, and this is the single most valuable ten minutes in this
  document.

The same escrow requirement extends to the **release signing key** (Gate R):
losing it strands every existing install on a key nobody can renew.

---

## 5. Restoring the database

Everything in this section was executed against the `staging` branch on
2026-07-29. `infra/backup/restore-drill.sh` is the executable form of it; the
numbers below are its output, not a plan.

### 5.0 Before anything: which layer

```
Did the damage happen in the last 6 hours?
  yes -> 5.1  PITR. Seconds. Nothing else is needed.
  no  -> Is there a pinned restore branch from before it?
           yes -> 5.2  branch restore. Seconds.
           no  -> 5.5  the nightly dump. Loses up to a day.

Is Neon itself the problem (project gone, org gone, account suspended)?
  -> 5.5, into any Postgres 18. That is the only path that does not need Neon.

THEN, ALWAYS, WITHOUT EXCEPTION -> 5.3, replay the deletions.
```

### 5.1 PITR: the first thing to reach for

```bash
source infra/lib/backup-common.sh   # only for the helpers; the tools load their own creds
infra/backup/pullfm-restore.sh pitr staging --at '2026-07-29T08:46:21.124Z' \
  --preserve pre-restore-20260729
```

**Measured: 5.9 s**, of which 2.9 s was the control-plane call and the rest was
the client reconnecting.

**The target must be a server timestamp**, RFC 3339 with milliseconds.
`pullfm_pg_now` produces exactly that shape from the database's own clock.
Postgres's default rendering of `now()` has a space in it and Neon rejects it,
and truncating to whole seconds moves the target backwards by up to a second,
which silently excludes transactions that had already committed.

**`main` is refused as a target.** Set `PULLFM_ALLOW_PROTECTED=1` by hand if
production really is the thing being restored; a script will not do it for you.

**RPO, measured rather than quoted.** The drill writes a row, records the server
instant, waits one second, writes a second row, then restores to the recorded
instant:

| Row                            | Present after the restore | Wanted |
| ------------------------------ | ------------------------- | ------ |
| written **before** the instant | yes                       | yes    |
| written **after** the instant  | no                        | no     |

So the target is honoured exactly: the last committed transaction before the
target survives and nothing after it does. **RPO for this path is zero.** The
constraint on PITR is not precision, it is the six-hour window.

### 5.2 Restoring from a pinned branch

```bash
infra/backup/pullfm-restore.sh restore-point list
infra/backup/pullfm-restore.sh from-branch staging \
  --source rp-preflight-20260729T084537Z \
  --preserve pre-restore-20260729
```

**Measured: 6.1 s** from the decision to the first successful query, of which
2.8 s was the control-plane restore. **Zero reconnect retries were needed: the
connection string survived the restore unchanged**, so nothing has to be rotated
or re-rendered onto the node afterwards.

**Correctness, checked by checksum and not by row count.** The drill seeds three
users with wishlist rows and connection rows, fingerprints them, destroys
everything, restores, and re-fingerprints:

```
marker fingerprint BEFORE = 3e4c0173f515c895ae8792f0aa9b0104
marker fingerprint AFTER  = 3e4c0173f515c895ae8792f0aa9b0104
users 3 -> 3, wishlist 4 -> 4, connections 2 -> 2
```

### 5.3 The deletion-replay finding

> **This is the most important paragraph in this runbook, and it says that a
> claim this project publishes to users was false.**

`legal/privacy-policy.md` section 7 and `docs/api/deletion-and-backups.md` both
commit that **"a restore replays the deletions"**, naming `deletion_log` as the
authoritative replay list.

The drill tested it the only way that means anything. It erased a user _after_
the restore point, then restored to before the erasure:

```
FINDING: RESTORE RESURRECTED AN ERASED USER AND LOST THE RECORD OF THE ERASURE.
  users still contains 33333333-... (the account that asked to be deleted)
  deletion_log contains 0 rows and none of them is that account
```

**`deletion_log` is a table inside the database being restored.** Rolling the
database back past an erasure rolls back the erasure and its own evidence at the
same instant. There is no ordering, no flag and no constraint that fixes this: a
replay list that lives inside the thing being rolled back cannot survive the
rollback. The claim was not merely unverified, it was **not satisfiable as
written**.

**The fix, implemented and drilled: an erasure ledger outside the database.**

`pullfm-backup.sh ledger-export` writes one small R2 object per erasure, keyed by
the user id, under `ledger/deletions/`. One object per record makes it
append-only by construction rather than by permission, which matters because R2
has no object versioning to fall back on. A Postgres restore cannot touch it.
The object holds an opaque uuid and two timestamps, which is the same data
`deletion_log` already retains permanently and which the privacy policy already
discloses, so this adds a location and not a category of data.

Then, on every restore, before serving traffic:

```bash
infra/backup/pullfm-backup.sh replay-deletions --dsn "$DSN"
```

**Measured: 11.3 s.** In the drill it removed the resurrected account and
rebuilt its `deletion_log` row from the ledger, and left the two accounts that
had _not_ asked to be deleted untouched. It is idempotent, it runs in one
transaction, and it refuses to report success while any ledger id is still
present in `users`.

**The residual gap, stated rather than buried.** The exporter is a timer, so the
window between the last export and the restore is unprotected: an account erased
inside that window still comes back with no record. **That interval is the
erasure-durability RPO and it is currently 10 minutes.** The real fix is for the
deletion cascade in `apps/bff` to write the ledger object in the same handler
that writes the `deletion_log` row, which makes durability synchronous with the
request and reduces the timer to a reconciler. That change is in the application
and is not in this one.

**Consequences for the published documents, which must not be skipped:**

- `legal/privacy-policy.md` section 7 commitment 3 is true **only** with the
  ledger and **only** outside the 10-minute window. It needs the interval stated
  or the claim narrowed.
- `docs/api/deletion-and-backups.md` says `deletion_log` "is the authoritative
  replay list". It is not, and cannot be. The ledger is.

### 5.4 Pinning a restore point before a destructive operation

```bash
infra/backup/pullfm-restore.sh restore-point create staging --label pre-migration
infra/backup/pullfm-backup.sh dump --kind preflight --reason "0007 migration"
```

**Measured: 3.0 s** for the branch, **24.8 s** for the dump (18.9 s `pg_dump`,
1.9 s encrypt, 2.1 s upload, plus a full read-back and verify).

Do both. The branch is instant and covers the ordinary case; the dump is the one
that still exists if the mistake is discovered next week or if the Neon project
is what got destroyed.

**A branch restore RE-PARENTS the target, and this is the operational trap.**
After `from-branch staging --source rp-x`, `staging` is a _child_ of `rp-x`, and
Neon refuses to delete a branch that has children:

```
HTTP 422  cannot delete branch that has children: <neon-staging-branch-id>
HTTP 422  Branch has children, preserve_under_name is required
```

So every branch restore permanently consumes slots out of a quota of **ten**
until the target is put back under its original parent. To reclaim them, delete
the leaves first, then re-parent the target, then delete the chain leaf-first:

```bash
infra/backup/pullfm-restore.sh from-branch staging --source main   # re-parent
infra/backup/pullfm-restore.sh restore-point prune --keep 0
```

Re-parenting is itself a reset and discards the restored data, so it is a
**cleanup step for a drill and not something to run after a real recovery**.
After a real recovery, either accept the slots or retire the old lineage
deliberately.

### 5.5 Restoring from a dump

The path that works with Neon gone. It restores into a **new database**, always,
so nothing is destroyed by the attempt.

```bash
infra/backup/pullfm-backup.sh list dumps/
infra/backup/pullfm-backup.sh verify dumps/scheduled/2026-07-29T032300Z-abc1234.pgc.enc
infra/backup/pullfm-restore.sh from-dump dumps/scheduled/2026-07-29T032300Z-abc1234.pgc.enc \
  --into "$ADMIN_DSN" --database restore_20260729
```

**Measured: 22.3 s** total for a 43,831-byte dump: 6.0 s to fetch, MAC-verify and
decrypt, 16.3 s for `pg_restore`, **zero pg_restore errors**, and the marker
fingerprint identical to the source. `pg_restore` time is the part that scales
with the database; at the 0.5 GB plan ceiling this stays inside the Gate 4 budget
with room to spare.

**Why a new database and not `drop schema public cascade`.** `pg_dump` orders
`CREATE EXTENSION` before `CREATE SCHEMA public`, because in a normal target
`public` already exists from initdb. Dropping the schema first therefore fails on
every extension:

```
pg_restore: error: ERROR: schema "public" does not exist
Command was: CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
```

A freshly created database has a fresh `public` and the whole archive applies
cleanly.

**A defect this drill found and fixed.** The dump was originally taken with
`pg_dump --schema=public`, which omits extensions entirely, because extensions
are database-level objects. `users.email` is `citext`. That dump restored
perfectly into a Neon branch, which inherits its parent's extensions, and could
not restore at all into a fresh database, which is the only place a dump is ever
actually needed. Dumps are now full-database, and the drill asserts that
`citext`, `pg_trgm`, `pgcrypto` and `unaccent` are present in the restored
database rather than trusting that they are.

### 5.6 Then verify, and then replay

**Correctness.** Checksums, not row counts. A restore that starts is not a
restore that worked.

**Erasure.** `replay-deletions`, every time, from section 5.3. Skipping it
un-deletes people who asked to be gone, and the drill proves that is the default
behaviour rather than an edge case.

---

## 6. Backups: what is taken, where it goes, and how long it lives

### The three layers, and what each does not cover

| Layer                   | Mechanism                                          | Does **not** cover                                           |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Neon instant restore    | copy-on-write history, 6 h                         | anything older than 6 h; loss of the Neon project or account |
| Pinned restore branches | a child branch pins its parent's pages at that LSN | loss of the Neon project or account; a quota of ten branches |
| Logical dumps to R2     | nightly `pg_dump -Fc`, encrypted, in an EU bucket  | the last 24 hours of writes; loss of the Cloudflare account  |

The middle layer is the one that is easy to miss and is worth stating plainly:
**a branch keeps its data because the branch exists, not because the parent's
history window still covers it.** That is what converts a six-hour window into an
arbitrary-length one for the specific instants somebody chose to keep, and it is
the reason a preflight branch is mandatory before a destructive operation rather
than merely advised.

### R2 retention: the decision, replacing the open question

The bucket previously carried **no expiry rule at all**, on the recorded grounds
that "a dump taken to survive a destructive operation must outlive it". That is
true and it does not imply _forever_; it implies a bound longer than the
operation. Meanwhile `legal/privacy-policy.md` section 7 commits to users that
backup retention is bounded, and an unbounded bucket made that sentence false.

**The resolution is that dumps are not one class of object.** Three prefixes,
three bounds, enforced by an **R2 lifecycle rule** rather than by a script, so
they hold even if nothing ever runs again:

| Prefix              | Retention   | What it is                                                                          |
| ------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `dumps/scheduled/`  | **35 days** | the nightly dump. A month plus enough slack to notice a gap.                        |
| `dumps/preflight/`  | **90 days** | taken immediately before a destructive change. Outlives the operation by a quarter. |
| `drills/`           | **14 days** | drill dumps and drill reports. Evidence, not backups.                               |
| `dumps/hold/`       | **none**    | an explicit, reasoned, reviewable exception. Requires `--reason`.                   |
| `ledger/deletions/` | **none**    | erasure records. See below.                                                         |

```bash
infra/backup/pullfm-backup.sh retention-apply    # write the rules
infra/backup/pullfm-backup.sh retention-check    # assert they still match the policy
```

`retention-check` fails if the live rules have drifted from the numbers in
`pullfm-backup.sh`, and lists every object under `dumps/hold/` with its age. It
runs weekly on a timer and is a **check, not an apply**: a job that silently
re-imposed an expiry rule would also silently delete objects somebody removed the
rule to protect.

**Why `hold/` is unbounded and why that is not a hole.** There will be cases
(a live incident, a dispute) where a specific dump must survive the stated
bounds. Deleting it on schedule would be the wrong outcome, and quietly making
the whole bucket unbounded to allow for it is how the original problem happened.
`hold/` requires a written reason attached to the object, and anything in it
older than 180 days is reported by `retention-check` as an exception that has
outlived its justification. That makes it an exception with an owner rather than
an absence of policy.

**Why `ledger/deletions/` is unbounded, and why it must be.** The ledger has to
outlive the longest-lived dump, or a restore from an old dump has no replay list
and section 5.3 fails all over again. It holds a uuid and two timestamps and no
other personal data, which is exactly what `deletion_log` already retains
permanently and what the privacy policy already discloses under "what survives
deletion". Bounding it would trade a real erasure guarantee for the deletion of
an opaque identifier that exists to prove an erasure happened.

**What `legal/privacy-policy.md` section 7 must now say**, replacing the `[OPEN]`
paragraph about a second unbounded backup path:

> Logical dumps in object storage are retained for **35 days** (scheduled) or
> **90 days** (taken before a planned change), enforced by an object expiry rule
> rather than by hand. A dump may be placed on hold beyond that only for a stated
> reason, and holds are reviewed. Records of erasure are kept indefinitely, and
> hold only an internal identifier and the dates, so that a restore can re-apply
> the erasure.

### Encryption

Client-side, before upload: AES-256-CBC with a PBKDF2-derived key (600k
iterations, a fresh salt per object), then HMAC-SHA256 over the ciphertext with
an independent key. Encrypt-then-MAC, and the MAC is checked **before** the
decrypt on every read.

R2's own at-rest encryption is under Cloudflare's key and protects against a
stolen disk and nothing else. If the R2 access key leaked, a server-side-only
encrypted dump would be plaintext to whoever held it. This replaces the
pgBackRest repository cipher that went away with the Hetzner node, and the key is
subject to the escrow requirement in section 4.

Every `dump` **reads its own object back**, re-MACs it, decrypts it and runs
`pg_restore --list` on the result before reporting success. The verification is
deliberately at write time, not at restore time: a backup nobody has read is not
a backup, and the moment to find that out is not during a recovery. Same lesson,
same shape as `infra/lib/tfstate-snapshot.sh`.

### R2 does not support object versioning

`PutBucketVersioning` and `GetBucketVersioning` are unimplemented, and
`GetBucketVersioning` returns an **empty body at exit 0** rather than an error,
which is exactly what S3 returns for a bucket where versioning was never enabled.
That is why several documents in this repository once claimed versioning was on.
**Nothing in `infra/backup/` assumes a previous version of an object can be
recovered:** every write goes to a key that has never existed, and
`ledger-export` HEADs before it PUTs and refuses to overwrite.

R2 _does_ support lifecycle expiry, which is what the retention rules above use.
One R2 feature being absent says nothing about another; both were probed.

### The schedule

Four units in `infra/backup/systemd/`. **Two are installed and enabled on the
staging node as of 2026-07-29**; the other two are deliberately not, and the
reason is in the table rather than left to be rediscovered.

| Unit                      | When                       | Installed | Why that cadence, or why not                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pullfm-backup-dump`      | daily 03:23 UTC            | **yes**   | this layer's RPO **is** the interval; before the 06:17 audit purge so the two agree; daily is also what makes the 35-day window recoverable                                                                                                                            |
| `pullfm-backup-retention` | Mondays 07:11 UTC          | **yes**   | lifecycle rules drift when a person changes them, not on their own                                                                                                                                                                                                     |
| `pullfm-deletion-ledger`  | every 10 minutes           | no        | superseded: `apps/bff` writes the ledger object inline with the deletion cascade and fails the request if that write fails, so the RPO is 0 and this is now a reconciler that would need a second R2 credential on the node to backfill rows that no longer accumulate |
| `pullfm-restore-drill`    | 1st of the month 04:47 UTC | no        | it **destroys data** on the staging branch and needs a Neon API key that can delete branches. Monthly drilling is a Gate 4 obligation, but arming it unattended on a node that has never run it once is how a drill becomes an incident. Operator-run for now          |

**Why daily and not weekly, stated against the retention number.** The lifecycle
rule expires `dumps/scheduled/` after 35 days. Retention is a window, not a
count: what can actually be restored to is the window divided by the interval.
Daily gives about 35 recovery points inside it; weekly would give five, and
"35 days of backups" would be a true statement about object lifetime and a
misleading one about recoverability. Nothing finer than daily is warranted,
because Neon's own six-hour history already covers every fault noticed quickly
and this layer exists for the two it cannot cover. Section 1 states this layer's
RPO as 24 hours, and that number **is** the `OnCalendar` line.

**No `RandomizedDelaySec`, deliberately.** `pullfm-cf-ranges.timer` carries an
hour of jitter because it is a polite client of a shared public endpoint.
Every _job_ timer instead pins `AccuracySec=1s` and owns a distinct minute,
because systemd's default one-minute accuracy window lets it coalesce timers and
put two jobs on one small node at the same instant. Jitter would also turn
"before the 06:17 audit purge" into a probability rather than an ordering, and
that ordering is why the dump and the purge do not disagree about which rows
existed. `:23` is a minute nothing else uses.

Both installed units use `OnFailure=pullfm-job-alert@%n.service` in `[Unit]`, so
they reach the same alert path as the four application jobs, and neither sets
`SuccessExitStatus=`: unlike those jobs there is no "ran, with something worth a
look" outcome here. Either a verified encrypted dump is in R2 or the only copy of
this database outside Neon is a day older than anyone thinks.

**Still open: `infra/scripts/check-job-schedule.mjs` does not lint them.** Its
`UNIT_DIR` is `infra/staging/app/systemd` and its `JOBS` list is four hard-coded
entries, so nothing cross-checks these `OnCalendar` expressions against
`systemd-analyze` or asserts `Type=oneshot` on them. `make jobs` covers four
scheduled units out of six, which is worth knowing before quoting it.

### What the node needs that a stock image does not have

`pullfm-backup.sh` shells out to `pg_dump`, `psql`, `openssl`, `python3` and
`aws`. Ubuntu 24.04 ships the middle two and neither of the outer two, and
`bootstrap.sh` installs them:

- **`postgresql-client-18` from PGDG**, not from Ubuntu. Neon runs Postgres 18
  and `pg_dump` refuses outright to dump a server newer than itself; noble's
  newest is 16. The check is on `/usr/lib/postgresql/18/bin/pg_dump` rather than
  on `command -v pg_dump`, because `/usr/bin/pg_dump` is `pg_wrapper` and any
  other package pulling in `postgresql-client` satisfies a presence check with
  the wrong major version. A drop-in pins the unit's `PATH` to the versioned
  bindir so this stays true whatever else is installed later.
- **`aws-cli` v2, pinned to an exact version and SHA-256**, from the versioned
  download URL rather than the moving one. The moving URL changes under you, so a
  hash check against it fails on release day and no hash check installs whatever
  was served.

Neither the unit, its drop-in, nor `/etc/pullfm/backup.env` contains a bucket
host. The endpoint in that file is a **seed the tool probes**, not an answer it
trusts, so a node whose recorded endpoint is stale warns and keeps working
rather than reporting that the backup bucket does not exist. R2 jurisdiction is
immutable at bucket creation, so a residency change means new buckets on a
different host; `infra/backup/README.md` ends with the full list of what a move
has to touch, in and out of that directory.

### This survives a node rebuild only once converge ships it

**`infra/staging-env.sh converge` does not send `infra/backup` or `infra/lib`**,
so `bootstrap.sh` takes its `else` branch and warns that no scheduled backup will
be installed. The first install was done by shipping those two directories over
the same SSH path converge uses, by hand. **A node rebuilt today comes back with
no backup**, which is section 2 of this runbook happening again, one control
along. The fix is one tar next to the observability one, plus placing
`backup.env` the way `metrics.env` is placed; both are written out in
`infra/backup/README.md`.

---

## 7. Rebuilding the application node

```bash
./infra/staging-env.sh up      # 45 seconds, and then it serves nothing
```

Then the manual bootstrap, which is the untimed part: nginx, the Cloudflare
origin certificate, the container, `/etc/pullfm/bff.env`, `/etc/pullfm/backup.env`
and the timers. See `infra/staging/README.md` and section 2.

**Once `pullfm-deploy.timer` is running, the application recovers itself**: it
polls the registry every 60 seconds and pulls the current build. That part of the
design works, because the gap is narrower than "we cannot rebuild": it is
precisely the secret-bearing configuration layer between a booted node and a
running deploy agent.

**`./infra/staging-env.sh down` no longer destroys any database.** The Hetzner
compute it destroys is still billed by the hour, so tearing it down is still
correct; the database is a Neon branch and survives. When staging data needs
discarding, reset the branch instead of destroying anything:

```bash
infra/backup/pullfm-restore.sh from-branch staging --source main
```

**Symptom guide during a rebuild:**

| Symptom                              | Meaning                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **525**                              | Cloudflare cannot complete TLS with the origin. The origin certificate or nginx is missing. This is the signature of the Gate 4 failure. |
| **521**                              | Origin refused the connection. nginx is not running.                                                                                     |
| **522**                              | Origin did not answer. Firewall or the node is not up.                                                                                   |
| **503 with `Retry-After`**           | Maintenance mode, deliberately. Not a fault.                                                                                             |
| **`/healthz` 200 but `/readyz` 503** | The app is up and a dependency is not. `checks` names which.                                                                             |

---

## 8. Whole environment loss

Order matters, because each step depends on the previous one existing:

1. **Terraform state.** Without it, Terraform will try to create resources that
   already exist. `envs/staging` and `infra/neon` state are in R2. **`shared` and
   `prod` are local and would have to be reconstructed by import**, which is slow
   and error-prone. Migrating them is the single highest-value infrastructure
   task in this document.
2. **Credentials**, from 1Password: Hetzner token, per-environment Cloudflare
   tokens, the Neon API key, both R2 key pairs, WorkOS keys, the KEK, **and the
   backup cipher key**.
3. `terraform apply` in `envs/shared`, then the environment root.
4. Bootstrap the nodes (section 7).
5. Restore the database (section 5). If Neon is intact this is seconds; if it is
   not, it is 5.5 into a fresh Postgres 18.
6. **Replay the deletions** (5.3).
7. Verify from the **public URL**, not from the node. That is the only check that
   proves the whole path works.

---

## 9. Cloudflare account loss (`PULLFM-RISK-001`)

The Cloudflare account is **shared with the operator's unrelated personal
fleet**, which is a documented accepted risk rather than an oversight. A
suspension takes down, simultaneously:

- DNS for `pull.fm`
- TLS termination and the edge protections
- **The R2 buckets: Terraform state, the logical dumps, and the erasure ledger**
- The maintenance worker, if one ever exists

That is the worst correlated failure in the system, because the things you would
use to recover are inside the thing that failed.

**It got slightly better and slightly worse on 2026-07-29.** Better, because the
database is now at Neon rather than on a Hetzner node whose backups were the only
copy: a Cloudflare suspension no longer touches the database or its six-hour
history at all. Worse, because the **erasure ledger** is now in that bucket too,
so a Cloudflare suspension plus a Neon restore is a combination in which the
replay list is unreachable exactly when it is needed.

**Mitigations that exist:** hardware-key MFA; tokens scoped to the minimum zone
and bucket; verified pre-apply state snapshots (`infra/lib/tfstate-snapshot.sh`);
dumps encrypted client-side under a key that is not in Cloudflare, so bucket
access alone yields ciphertext.

**A mitigation that was listed here and never existed:** object versioning on
the state bucket. R2 does not implement it, so it was never a control. The
snapshot script replaces it for the bad-apply case and only for that case:
snapshots live in the same bucket under the same credential.

**Mitigation that does not exist:** an off-Cloudflare copy of the dumps and the
ledger. `[OPEN]` For a service with real user data, the backups and the erasure
record should not live solely in the same account as DNS and the edge. The ledger
makes this more urgent than it was, because it is small, it is legally load
bearing, and a second copy of it costs almost nothing.

Recovery: the domain registrar holds the delegation, so DNS can be re-pointed
elsewhere. Everything else waits on the account.

---

## 10. Vendor unavailability

| Vendor                     | Impact                                                           | Response                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon**                   | Total database outage. Nothing serves.                           | Wait, if it is an outage. If it is account or project loss, section 5.5 into any Postgres 18: Neon is stock Postgres with no proprietary wire format. |
| **WorkOS**                 | Nobody can sign in. Existing sessions survive until they expire. | Wait. There is no fallback, and none is planned: we hold no password hashes precisely so there is no hostage, but that also means no local auth path. |
| **Hetzner**                | Total outage                                                     | Rebuild elsewhere. The Terraform is Hetzner-specific; a move is days, not hours.                                                                      |
| **Cloudflare**             | See section 9                                                    |                                                                                                                                                       |
| **ListenBrainz / Last.fm** | Recommendations degrade                                          | Circuit breaker opens, the section is omitted, `degraded: true`. Cache-first means this is a degradation, not an outage.                              |
| **MusicBrainz**            | **Existential if it is a revocation rather than an outage**      | See below.                                                                                                                                            |
| **iTunes / Deezer**        | Previews unavailable                                             | Degrade. Do not cache around it: caching preview audio breaches both.                                                                                 |
| **SeatGeek**               | Events unavailable                                               | Their contractual liability is capped at fifty dollars, so nothing user-facing may depend on them being up. Honest empty state.                       |

**A revocation is not an outage.** Last.fm and MusicBrainz revoke without appeal
or SLA, and there is **no second supplier of MBIDs**. Treat any 403 or explicit
revocation notice as SEV-3 in [`RUNBOOK-INCIDENT.md`](RUNBOOK-INCIDENT.md),
outranking a full outage, because an outage is recoverable and this is not. The
documented long-term mitigation is a local MusicBrainz mirror (`PLAN.md`
section 3), which is also the 50k-user unlock.

---

## 11. Bus factor 1

One person holds 1Password, Cloudflare, Hetzner, Neon, GitHub, WorkOS, the
registrar, and the LLC bank. There is no separation-of-duties control available,
so the controls are the ones that survive the person being unavailable:

- **Printed 1Password Emergency Kit**, stored somewhere a successor can reach.
- **A nominated account recovery contact** on 1Password.
- **A one-page successor document**: what Pull.fm is, what it costs, where the
  accounts are, and what to do if it must be shut down. `PLAN.md` section 10
  budgets an hour for this in Phase 0.
- **The shutdown path is a legitimate outcome** and should be written down as
  one. Users can export their own data without operator involvement, which is
  the property that makes an orderly shutdown possible at all.

`[OPEN]` None of the three artifacts above is confirmed to exist. They are the
cheapest items in this entire runbook and the only ones that work when the
operator does not.

---

## 12. Drill schedule

| Drill                              | Frequency                           | Status                                                                      |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| **Database restore, timed**        | Monthly (Gate 4)                    | **Run 2026-07-29. PASSED.** Section 5. Automated in `restore-drill.sh`.     |
| **Deletion replay across restore** | Every drill run                     | **Run 2026-07-29. Falsified the published claim; fixed and re-proved.** 5.3 |
| **Dump readback**                  | Every dump, automatically           | **Passing.** Every `dump` verifies its own object before reporting success. |
| Backup retention conformance       | Weekly                              | Unit written; **timer not installed.** `infra/backup/README.md`             |
| Environment rebuild from IaC       | Every gate run, implicitly          | **Run 2026-07-29. Failed.** Section 2. Not a database problem.              |
| KEK rotation                       | Before Gate 3 closes, then annually | **Never run.** Section 4.                                                   |
| Backup cipher key escrow readable  | At every risk review                | **Never checked.** New key, same obligation as the KEK.                     |
| Replica promotion                  | Once, then torn down (Gate 6)       | Not run; not applicable to Neon in the old form                             |

**Previously five of five rows here had never been run.** Three now have, and
the one that mattered most came back with a finding rather than a green tick,
which is what a drill is for. The remaining rows are the honest list of what is
still a design rather than a control.

---

## Appendix: the 2026-07-29 drill, in full

`infra/backup/restore-drill.sh`, run `20260729T084524Z`, target branch `staging`,
`history_retention_seconds = 21600`.

| Phase                                            | Wall clock |
| ------------------------------------------------ | ---------- |
| 0. preflight                                     | 7.0 s      |
| 1. seed the known markers                        | 4.8 s      |
| 2. capture a restore point (branch + dump to R2) | 34.3 s     |
| 3. erase a user the way the application does     | 9.2 s      |
| 4. RPO probe: writes either side of an instant   | 3.6 s      |
| 5. destroy the data                              | 5.7 s      |
| 6. restore from the pinned branch                | 6.1 s      |
| 7. verify what came back                         | 5.8 s      |
| 8. replay deletions from the R2 ledger           | 11.3 s     |
| 9. PITR to a recorded instant, measured RPO      | 11.1 s     |
| 10. dump path: R2 -> a fresh database            | 29.3 s     |
| 11. clean up and prove it                        | 27.1 s     |
| **total**                                        | **2m35s**  |

Results: data identical to seed (`3e4c0173f515c895ae8792f0aa9b0104` both sides),
RPO exact, `pg_restore` errors zero, all four extensions present in the restored
database, all five drill branches confirmed deleted afterwards, staging returned
to its original parent with zero rows. One finding: section 5.3.

The report is written to `s3://<backups-bucket>/drills/<run>-report.json`,
which has a 14-day expiry, because evidence that only exists on the laptop of
whoever ran the drill is not evidence.

**Reproduced the same evening**, run `20260729T085508Z`, on a scratch branch:
5.6 s branch restore, 5.4 s PITR, 21.3 s dump restore, same verdicts, same
finding. Two runs is not a trend, but a drill that produces the same numbers
twice is a measurement rather than an anecdote.

### The drill refused to run, and that was correct

Between those two runs another agent wrote a user row to `staging`, and the
drill stopped at preflight:

```
branch already holds 1 user rows.
REFUSING: phase 5 deletes rows and phase 6 rolls the whole branch back.
```

**This is the guard doing its job and it should never be casually overridden.**
Phase 5 deletes and phase 6 rolls the entire branch back to phase 2, so anything
written to the branch by anyone else in between is gone. `PULLFM_DRILL_NONEMPTY=1`
exists for the case where that is genuinely acceptable, and it is deliberately
not set in `/etc/pullfm/backup.env`.

The consequence for the monthly schedule: **once staging holds anything worth
keeping, the timer will start failing on this check rather than destroying it.**
That is the right default, and the right response at that point is to point the
drill at a scratch branch created from staging (`--branch`, plus
`PULLFM_BACKUP_DSN` for that branch), which is how the reproducibility run above
was done and which proves exactly as much.

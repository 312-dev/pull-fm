# `infra/backup` - what is here and what still has to be installed

The tools. Everything below is executable from a laptop today and was executed
on 2026-07-29; the timings in [`../../docs/RUNBOOK-DR.md`](../../docs/RUNBOOK-DR.md)
section 5 came out of them.

| File                      | What it is                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `pullfm-restore.sh`       | Neon restore primitives: restore points, PITR, branch restore, restore-from-dump   |
| `pullfm-backup.sh`        | Logical dumps to R2, retention rules, and the out-of-band erasure ledger           |
| `restore-drill.sh`        | The Gate 4 drill. Destroys data on the staging branch and gets it back, timed      |
| `systemd/`                | Unit files for the four scheduled jobs. **Not installed anywhere yet.** See below. |
| `../lib/backup-common.sh` | Credential loading, timing, the R2 endpoint probe, the Neon API wrapper            |

---

## What still has to happen on the node, and who owns it

`infra/staging/` is owned by the deploy work, not by this directory, so the four
units in `systemd/` are written but **not wired in**. Three things are needed
there and none of them is in this change:

### 1. Install the units, the way the other four are installed

`infra/staging/app/bootstrap.sh` already contains a loop that installs
`pullfm-${job}.service` and `.timer` for `warm-cache`, `sweep-expired`,
`purge-audit` and `reap-unverified`, plus `pullfm-job-alert@.service`. These
four follow the identical shape and want the identical treatment:

```
pullfm-backup-dump         nightly 03:23 UTC
pullfm-deletion-ledger     every 10 minutes
pullfm-backup-retention    Mondays 07:11 UTC
pullfm-restore-drill       1st of the month 04:47 UTC
```

They reference `pullfm-job-alert@%n.service` in `OnFailure=`, so they inherit the
existing alert path with no change to it.

That sentence was **false until 2026-07-29**. All four carried `OnFailure=` in
`[Service]`, where it is not a valid directive: systemd parsed it, logged
`Unknown key name 'OnFailure' in section 'Service', ignoring`, and wired
nothing, so these units had no alert path at all. All four also carried
`RuntimeMaxSec=` on a `Type=oneshot` unit, which systemd likewise discards, so
none of them was bounded either. Both are fixed; the directives are now
`OnFailure=` in `[Unit]` and `TimeoutStartSec=`. It is the same pair of defects
that was found and fixed in the four application job units, and neither was
caught here for the reason given in section 2 immediately below.

### 2. `infra/scripts/check-job-schedule.mjs` only looks at one directory

Its `UNIT_DIR` is `infra/staging/app/systemd`, and its `JOBS` list is four
hard-coded entries. These units are therefore **not linted**: their
`OnCalendar` expressions are not cross-checked against `systemd-analyze`, and
nothing asserts `Type=oneshot` or `AccuracySec=1s` on them. When the units move
into `infra/staging/app/systemd`, they should be added to that list. Until then
the checker's green result covers four jobs out of eight, which is worth knowing
before quoting it.

### 3. `/etc/pullfm/backup.env`, rendered at 0600 like `bff.env`

There is no `op` on the node and there should not be, so the tools take their
credentials from the environment when it already has them and only reach for
1Password when it does not. The env file needs:

```
PULLFM_BACKUP_DSN=            # DIRECT endpoint, not the pooler (pg_dump opens >1 connection)
PULLFM_BACKUP_ENDPOINT=       # https://<account>.eu.r2.cloudflarestorage.com  (see the trap below)
AWS_ACCESS_KEY_ID=            # 1Password pull-fm/staging/R2_CREDENTIALS
AWS_SECRET_ACCESS_KEY=
NEON_API_KEY=                 # 1Password, the Neon API key
PULLFM_BACKUP_CIPHER_PASS=    # 1Password pull-fm/infra/BACKUP_DUMP_KEY, 'cipher passphrase'
PULLFM_BACKUP_HMAC_KEY=       # same item, 'hmac key'
```

`PULLFM_DRILL_NONEMPTY` is deliberately **not** in that list. Setting it lets the
drill run against a branch that already holds user rows, and that decision
should be made by a person at the time, not by a file.

---

## The traps, all of which cost time before they were written down

**The R2 endpoint.** `pull-fm-backups-staging` is an EU-jurisdiction bucket, so
it lives on `<account>.eu.r2.cloudflarestorage.com`. The account's default host
answers `NoSuchBucket` for it. The `s3 endpoint` field on the 1Password item was
recording the default host and has been corrected; `backup-common.sh` probes
anyway and says so loudly if it has to correct the recorded value, because "the
backup bucket does not exist" is the worst thing to read during a restore.

**R2 has lifecycle expiry but not object versioning.** Expiry is used and is the
enforcement mechanism for retention. Versioning is unimplemented and returns an
empty body at exit 0 rather than an error, which is why this repository believed
it had it. Nothing here writes to a key twice.

**A branch restore re-parents the target.** After
`from-branch staging --source rp-x`, `staging` is a child of `rp-x`, and Neon
refuses to delete a branch that has children. Every branch restore therefore
consumes branch slots out of a quota of ten until the target is put back under
its original parent. The drill does that in its cleanup phase and verifies it.

**`pg_dump --schema=public` silently drops the extensions.** `citext`,
`pg_trgm`, `pgcrypto` and `unaccent` are database-level objects, so a
schema-restricted dump omits them, and `users.email` is `citext`. That dump
restores perfectly into a Neon branch, which inherits the extensions from its
parent, and fails completely into a fresh database, which is the only place a
dump is ever actually needed. Dumps are full-database for this reason.

**Temporary tables survive the client on Neon.** Neon parks idle backends and
hands the same one to the next connection, so `CREATE TEMPORARY TABLE` in one
psql invocation can collide with the next one. Every temp table here is preceded
by `DROP TABLE IF EXISTS`.

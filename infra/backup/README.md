# `infra/backup` - what is here and what still has to be installed

The tools. Everything below is executable from a laptop today and was executed
on 2026-07-29; the timings in [`../../docs/RUNBOOK-DR.md`](../../docs/RUNBOOK-DR.md)
section 5 came out of them.

| File                      | What it is                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `pullfm-restore.sh`       | Neon restore primitives: restore points, PITR, branch restore, restore-from-dump   |
| `pullfm-backup.sh`        | Logical dumps to R2, retention rules, and the out-of-band erasure ledger           |
| `restore-drill.sh`        | The Gate 4 drill. Destroys data on the staging branch and gets it back, timed      |
| `systemd/`                | Unit files for four scheduled jobs. **Two are installed on the node.** See below.  |
| `../lib/backup-common.sh` | Credential loading, timing, the R2 endpoint probe, the Neon API wrapper            |

---

## What happened on the node on 2026-07-29, and what is still open

Everything in the section below used to be a list of work. Most of it is done;
what is left is called out as **STILL OPEN** so it cannot be read as finished.

### 1. Install the units, the way the other four are installed - DONE

`infra/staging/app/bootstrap.sh` installs and `enable --now`s two of the four,
in a section that follows the application-job loop exactly:

```
pullfm-backup-dump         nightly 03:23 UTC          INSTALLED, ENABLED
pullfm-backup-retention    Mondays 07:11 UTC          INSTALLED, ENABLED
pullfm-deletion-ledger     every 10 minutes           not installed, superseded
pullfm-restore-drill       1st of the month 04:47 UTC not installed, destructive
```

The two that are not installed are decisions rather than omissions, and the
reasoning is in `bootstrap.sh` and in `docs/RUNBOOK-DR.md` section 6: the ledger
exporter was superseded by the BFF writing the ledger object inline with the
deletion cascade, and the restore drill destroys data and wants a Neon API key
that can delete branches.

They reference `pullfm-job-alert@%n.service` in `OnFailure=`, so they inherit the
existing alert path with no change to it.

**STILL OPEN: `infra/staging-env.sh` does not ship this directory.** `converge`
tars `infra/staging/app` and then `infra/observability` into
`/tmp/pullfm-config`; `infra/backup` and `infra/lib` are not in either tar, so
`bootstrap.sh` takes its `else` branch and warns that no scheduled backup will be
installed. The first install was done by shipping them by hand over the same SSH
path converge uses. One line in `cmd_converge`, next to the observability tar,
closes it:

```bash
tar czf - -C "${ROOT}/infra" backup lib |
  ssh_node "${app_ip}" "tar xzf - -C /tmp/pullfm-config"
```

`backup.env` needs the same treatment as `metrics.env` a few lines further down.
Until both are added, **a rebuilt node comes back without a backup** - which is
the Gate 4 lesson in section 2 of `../staging/README.md` happening again, one
control along.

### 1b. The node needs two binaries a stock image does not have - DONE

`pullfm-backup.sh` shells out to `pg_dump`, `psql`, `openssl`, `python3` and
`aws`, and Ubuntu 24.04 has the middle two only. `bootstrap.sh` installs:

- **`postgresql-client-18` from PGDG.** Neon runs Postgres 18 and `pg_dump`
  refuses to dump a server newer than itself; noble's newest is 16. The check is
  on `/usr/lib/postgresql/18/bin/pg_dump`, not on `command -v pg_dump`, because
  `/usr/bin/pg_dump` is `pg_wrapper` and anything that pulls in the unversioned
  `postgresql-client` satisfies a presence check with the wrong major version.
  That happened, on this node, within an hour of the check being written.
- **`aws-cli` v2, pinned to a version and a SHA-256**, from the versioned URL.
  The moving URL changes under you: a hash check against it fails on release day,
  and no hash check installs whatever was served.

That sentence was **false until 2026-07-29**. All four carried `OnFailure=` in
`[Service]`, where it is not a valid directive: systemd parsed it, logged
`Unknown key name 'OnFailure' in section 'Service', ignoring`, and wired
nothing, so these units had no alert path at all. All four also carried
`RuntimeMaxSec=` on a `Type=oneshot` unit, which systemd likewise discards, so
none of them was bounded either. Both are fixed; the directives are now
`OnFailure=` in `[Unit]` and `TimeoutStartSec=`. It is the same pair of defects
that was found and fixed in the four application job units, and neither was
caught here for the reason given in section 2 immediately below.

### 2. STILL OPEN: `infra/scripts/check-job-schedule.mjs` only looks at one directory

Its `UNIT_DIR` is `infra/staging/app/systemd`, and its `JOBS` list is four
hard-coded entries. These units are therefore **not linted**: their
`OnCalendar` expressions are not cross-checked against `systemd-analyze`, and
nothing asserts `Type=oneshot` or `AccuracySec=1s` on them. Its `JOBS` table
should gain `pullfm-backup-dump` and `pullfm-backup-retention` with their unit
directory made per-job, which is a change to a file this work does not own.
Until then the checker's green result covers four scheduled units out of six,
which is worth knowing before quoting it.

### 3. `/etc/pullfm/backup.env`, rendered at 0600 like `bff.env` - DONE

There is no `op` on the node and there should not be, so the tools take their
credentials from the environment when it already has them and only reach for
1Password when it does not. `pullfm_render_staging_secrets` in
`../lib/secrets.sh` renders it, and converge places it root-owned `0600`:

```
PULLFM_BACKUP_DSN=            # DIRECT endpoint, not the pooler (pg_dump opens >1 connection)
PULLFM_BACKUP_ENDPOINT=       # copied from the vault's 's3 endpoint'; a probe SEED, see the trap below
AWS_ACCESS_KEY_ID=            # 1Password pull-fm/staging/R2_CREDENTIALS, BUCKET-SCOPED
AWS_SECRET_ACCESS_KEY=
PULLFM_BACKUP_CIPHER_PASS=    # 1Password pull-fm/infra/BACKUP_DUMP_KEY, 'cipher passphrase'
PULLFM_BACKUP_HMAC_KEY=       # same item, 'hmac key'
PULLFM_GIT_SHA=               # not a secret; see below
```

**Three things are deliberately NOT in it**, because an environment file is also
a blast radius:

- `NEON_API_KEY`. Only the restore drill needs it, and the drill is not
  installed. The key can create and delete branches.
- `PULLFM_LEDGER_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`. A **different token for a
  different bucket**, and never interchangeable with the pair above: the backup
  token cannot see `pull-fm-ledger-staging` at all, so a ledger command run with
  it reports an EMPTY LEDGER rather than a permission error. The BFF holds that
  pair in `bff.env` because the BFF is the thing that writes the ledger inline.
- `PULLFM_DRILL_NONEMPTY`. Setting it lets the drill run against a branch that
  already holds user rows, and that decision should be made by a person at the
  time, not by a file.

`PULLFM_GIT_SHA` is not a credential. `cmd_dump` stamps a git sha into every
object key and manifest, and derives it by running `git rev-parse` in the tree
the script lives in - which on the node is `/opt/pullfm`, an `install`ed copy
rather than a checkout. Every scheduled object would otherwise have been keyed
`-unknown`. `secrets.sh` reads it where a checkout does exist.

### 4. What is deliberately NOT in a dump

`pullfm-backup.sh` excludes the ROWS of `mb.*` (`DUMP_EXCLUDE_DATA`) and keeps
their DDL. `mb.canonical` reached 31.5 million rows and 10 GB on 2026-07-29
against roughly 500 KB for the entire rest of the database, and it is an import
of a published upstream dataset that `../mb-loader/mb-canonical-load.sh`
rebuilds on demand. The first scheduled dump after that load hit
`TimeoutStartSec` and was killed at ten minutes with nothing uploaded.

`--exclude-table-data`, not `--exclude-schema` and emphatically not
`--schema=public`: the tables, indexes, constraints and grants stay in the
artifact, so a restore reproduces the full schema with an empty `mb.canonical`
for the loader to refill. Every manifest records `excluded_table_data`, because
a dump that is missing rows and does not say so restores cleanly and quietly and
the gap is found by a user. Anything added to that list must be re-derivable by
a committed command, named in the comment next to it.

---

## The traps, all of which cost time before they were written down

**The R2 endpoint, and why nothing here writes a jurisdiction down.** A
jurisdiction-scoped bucket lives on a jurisdiction host and the account's default
host answers `NoSuchBucket` for it, which is an error that says the bucket does
not exist when it does. Jurisdiction is **immutable at bucket creation**, so a
residency change is not a setting change, it is new buckets on a different host,
and any tool that had learned the old host breaks on the day of the move.

`backup-common.sh` therefore treats every recorded endpoint as a **candidate to
probe**, never as a fact: the `s3 endpoint` field in the vault, and the value
rendered into a node's environment file where there is no vault to read. A stale
record costs one extra `HEAD` and a loud warning, not an outage. Each bucket is
probed with the credential about to be used on it, and **no code path assumes the
backups bucket and the ledger bucket share a host** - they are separate buckets
with separate credentials and independently fixed jurisdictions.

Places a residency move still has to touch are listed at the end of this file.

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

---

## Moving the buckets to a different jurisdiction

R2 jurisdiction is fixed when a bucket is created, so a residency change means
**new buckets**, new credentials scoped to them, and a new endpoint host. The
backup and restore tooling is written so that this is a data change rather than a
code change, but it is not free. Everything that has to be touched, whether or
not it lives in this directory:

**Changes by re-pointing a value, no code edit:**

| What                                                       | Where the value comes from                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The bucket names                                           | `PULLFM_BACKUP_BUCKET` / `PULLFM_LEDGER_BUCKET` in `../lib/backup-common.sh`, both `${VAR:-default}` |
| The endpoint the tools use                                 | probed. Update the `s3 endpoint` field on the vault items and re-converge      |
| The endpoint and bucket the node uses                      | `/etc/pullfm/backup.env`, rendered by `../lib/secrets.sh` from those fields    |
| The endpoint, bucket and keys the BFF uses for the ledger  | `ERASURE_LEDGER_*` in `bff.env`, same renderer, same vault items               |
| The drill's ledger bucket and credential                   | `PULLFM_LEDGER_BUCKET` and the item read in `restore-drill.sh`                 |

**Needs a real edit, and none of it is in this directory:**

| File                                                       | What has to change                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `../terraform/modules/backup-storage/variables.tf`         | `jurisdiction` default and its `validation`; the description calls the `eu` value a GDPR control    |
| `../terraform/modules/backup-storage/outputs.tf`           | derives the endpoint from the jurisdiction. Correct already, but it is the authority worth checking |
| `../terraform/envs/*/versions.tf`, `backend.hcl.example`   | comment blocks asserting which buckets are and are not EU-pinned                                    |
| `../terraform/README.md`, `../neon/backend.hcl.example`    | the same assertions in prose, including a recorded open decision about the state bucket             |
| `legal/privacy-policy.md`                                  | **the load-bearing one.** Sections stating backups are "pinned to an EU jurisdiction bucket" become false the moment the buckets move, in a document published to users |
| `apps/bff/src/lib/r2.ts` and its tests                     | comments and fixtures use a jurisdiction host as the worked example; the code itself takes the endpoint from config |
| `../neon/README.md`                                        | references a risk about the state bucket not being EU-pinned                                        |

Two things that are **not** on either list, deliberately. Nothing in
`pullfm-backup.sh`, `pullfm-restore.sh` or `../lib/backup-common.sh` names a
jurisdiction as an answer: the only occurrence is one entry in the probe's
candidate list, which is a guess to be tested rather than an assertion. And no
systemd unit, drop-in or env template contains a host at all.

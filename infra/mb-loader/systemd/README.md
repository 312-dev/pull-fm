# The MusicBrainz canonical refresh timer

Two units, `pullfm-mb-canonical.service` and `pullfm-mb-canonical.timer`, that
keep `mb.canonical` current. The data, the licence position and the query shapes
are in [`docs/runbooks/mb-canonical-data.md`](../../../docs/runbooks/mb-canonical-data.md);
this file is only about how the thing is scheduled and why it is scheduled that
way.

---

## Why these live here and not in `infra/staging/app/systemd/`

Every unit in `infra/staging/app/systemd/` runs its job as a one-shot container
built from the exact BFF image digest currently serving traffic, via
`/usr/local/bin/pullfm-job`. That is the right shape for the four application
jobs, and it is the wrong shape for this one, for a reason that is a property of
the work rather than a preference.

**The loader is not a Node program.** It is `curl -> tee(sha256) -> zstd -dc ->
tar -xO -> psql COPY`, and it needs `psql`, `zstd`, `tar`, `curl` and `awk` on
the machine that runs it. The BFF runtime image is `node:22.21.1-alpine3.22`
plus `dumb-init` and has **none of them**, and the loader script is not in the
image either: the build ships `pnpm deploy --prod /out`, which is JavaScript and
`node_modules`. So `pullfm-job refresh-mb-canonical` would fail on a missing
binary before it reached anything this repository controls.

The two ways to make the container path work are both worse than not taking it:

- **Add a Postgres client, zstd and curl to the runtime image.** That puts a
  database client and a decompressor on the request path's attack surface,
  permanently, so that a job which runs for four minutes a fortnight can use
  them. The image is deliberately minimal.
- **Build a second image just for the loader.** A new Dockerfile, a new build,
  a new digest to pin, and a new thing that can be one deploy behind - for a
  shell script with no dependencies that the host can already almost run.

So this follows `infra/backup/` instead, which made the same call for the same
reason: `pullfm-backup-dump.service` runs `pullfm-backup.sh` **on the host**
because it needs `pg_dump`. Two host jobs and four container jobs is not an
inconsistency; it is the split between work that is the application and work
that is about the database.

`apps/bff` still has `refresh:mb-canonical`, and it is still the right
entrypoint from a checkout or from any image that does carry the four binaries.
It is what holds the cross-node session advisory lock and turns the loader's
exit code into the 0/1/2 contract. Nothing on the deployed path invokes it
today, and `apps/bff/package.json` says so at the script.

---

## Installing

**Converge installs these. Do not install them by hand.**

```bash
./infra/staging-env.sh converge
```

That is the whole procedure, and it is the same one that installs the backup
timer. Three things had to be true for it to be, and all three are now:

| step                                                                 | where it lives                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `infra/mb-loader/` ships to the node                                 | `cmd_converge`, in the `observability backup mb-loader lib` tar     |
| `/etc/pullfm/mb-canonical.env` is rendered from 1Password            | `pullfm_render_staging_secrets` in `infra/lib/secrets.sh`           |
| the units are installed, given a PATH drop-in, and the TIMER enabled | the `if [ -d mb-loader ]` block in `infra/staging/app/bootstrap.sh` |

**Installing them by hand is the failure mode, not the fallback.** A hand-placed
`/etc/pullfm/mb-canonical.env` is overwritten by the next converge, and a
hand-copied unit survives until somebody rebuilds the node - which is a documented
answer to a whole class of problem here, because the node holds nothing and the
database is Neon. A control that does not survive a rebuild disappears on the day
it is most likely to be wanted. This job spent a day in exactly that state: the
units were correct, committed, and installed nowhere, and an earlier attempt had
copied them up to run `systemd-analyze verify` and removed them again.

That is not a hypothetical. **The node was destroyed and rebuilt twenty minutes
after the first load** - new tailnet address, zero timers, empty `/etc/pullfm` -
and the next `converge`, run by somebody else for an unrelated reason and touching
nothing in this directory, put the loader, both units, the `PATH` drop-in, the
`0600` env file and the enabled timer back on a bare machine with no manual step.
The 31,554,198 rows were unaffected: they are in Neon, not on the node.

The service reads one variable, and `infra/lib/secrets.sh` writes it:

```
DATABASE_URL_DIRECT=postgres://...
```

**The direct endpoint, never the pooled one.** The swap takes `ACCESS EXCLUSIVE`
and the loader holds state across separate `psql` sessions; Neon's pooled
endpoint is PgBouncer in transaction mode and hands the server connection to
somebody else at COMMIT. The file is the credential, so it is `0600 root:root`,
which is why the unit reads it through `EnvironmentFile=` (systemd opens it as
PID 1) rather than the script sourcing it. It is a SEPARATE file from `bff.env`
because this DSN is the owner role, which can `DROP` the live table, and
`bff.env` is bind-mounted into the internet-facing container.

Forcing a run, which is how the first load is done and how a missed publication
is caught up:

```bash
# --no-block, so a dropped SSH session cannot orphan a four-minute load.
sudo systemctl start --no-block pullfm-mb-canonical.service
journalctl -u pullfm-mb-canonical.service -f
```

`enable --now` goes on the **timer** and never on the `.service`. A unit file
that is installed and whose timer is not enabled looks like a working control in
a diff, in a file listing and in `ls /etc/systemd/system`, and loads exactly as
much as no unit at all. `systemctl list-timers` showing a real NEXT is the only
evidence that anything is scheduled:

```
NEXT                        LEFT  UNIT                       ACTIVATES
Thu 2026-07-30 09:19:00 UTC  11h  pullfm-mb-canonical.timer  pullfm-mb-canonical.service
```

---

## The first load against a brand new, empty database

Written for somebody who has a fresh, empty database and nothing to compare
against. Every step below was discovered by doing it, not by reading.

### Order: migrations first, always

`packages/db/migrations/0007_mb_canonical.sql` creates the schema, an **empty**
`mb.canonical`, and `mb.load_state`. The loader does **not** create them; it
checks for the schema and exits 1 with `the mb schema does not exist. Run
migration 0007 first.` So:

```bash
DATABASE_URL_DIRECT=... node packages/db/scripts/migrate.mjs
DATABASE_URL_DIRECT=... pnpm mb:load
```

The migration deliberately creates **no indexes** on `mb.canonical`. That is not
an omission: the loader builds every index on its own staging table, where
nothing is reading, and the swap renames them into place. A migration that also
created them would be asserting a shape the first load immediately replaces.

### Check the branch size limit before you start

The load needs about **11 GB** of headroom. Neon's free plan caps a branch at
512 MiB, which is not a soft limit and not a warning: the load runs, streams the
whole 2.32 GB archive, and dies partway through the `COPY`. Nothing is
corrupted, but you find out four minutes in rather than in one API call. The
one-line check is in
[`docs/runbooks/mb-canonical-data.md`](../../../docs/runbooks/mb-canonical-data.md)
section 4.

### Before or after the app is serving? Either. Prefer before.

**It is safe at any time**, and that is a property of the design rather than a
scheduling convention:

- The loader never mutates the live table. It builds
  `mb.canonical_stage_<pid>_<epoch>` and replaces the live table by rename inside
  **one transaction**, so there is no midway state to be observed.
- That transaction sets its own `lock_timeout` (15 s by default). The `DROP`
  needs `ACCESS EXCLUSIVE`, so a reader mid-query holds it off; without the
  timeout the swap would queue and every later reader would queue behind it,
  turning a maintenance job into an outage. With it, the swap simply fails and
  the previous data keeps serving.
- On an empty database the swap replaces a zero-row table, so there is nothing
  to hold it off and nothing to lose.
- `MB_LOCAL_ENABLED` defaults to `false`, so the application does not read this
  table at all until somebody turns it on.

**Prefer before** anyway, for one reason: an empty `mb.canonical` is a permanent
local miss, so until the first load succeeds the feature is off in practice
whatever the flag says. Loading first means the flag can be turned on and
observed in one step instead of two.

### Expected cost, and how to know if yours is different

Measured by this unit on `pullfm-staging-app-1` (Ashburn, 3 vCPU) against the
`us-east-1` Neon staging branch, 2026-07-29 21:22:39 UTC:

|                      | first load                                                | daily no-op run |
| -------------------- | --------------------------------------------------------- | --------------- |
| wall clock           | **3 min 35 s** (138 s of it the `COPY`, 67 s the indexes) | **1.72 s**      |
| downloaded           | **2.32 GB**                                               | **533 bytes**   |
| disk on the job host | **none** - peak 28.4 MB RSS, free space unchanged         | none            |
| space in Postgres    | **10 GB** (6,558 MB heap, 3,950 MB indexes)               | none            |
| rows                 | **31,554,198**                                            | none            |
| CPU                  | **1 min 16.7 s**                                          | negligible      |

Per index: `pkey` 7.1 s, `lookup` 18.4 s, `recording` 11.9 s, `release` 9.0 s,
`artist` (GIN) 20 s.

An earlier load from a different node into the EU branch took **3 min 58 s** with
a 129 s `COPY` and 98 s of indexes. The two totals agreeing to within 10% is a
coincidence of two offsetting changes rather than stability: this run's download
was **slower** (138 s against 129 s) and its index build **30% faster** (67 s
against 98 s). Download tracks distance to `data.metabrainz.org`; indexes track
the database's compute. They move independently, so read `mb.load_state` rather
than this table.

Two of these are load-bearing if yours differ:

- **Disk on the job host is genuinely zero.** The archive is streamed
  `curl -> tee(sha256) -> zstd -dc -> tar -xO -> psql COPY` and neither the
  2.32 GB archive nor the 7.5 GB CSV is ever written down. A node too small to
  hold the file can still load it. If you see disk filling, something has changed
  shape.
- **Wall clock is dominated by network distance, not by the database.** The three
  and a half minutes above came from a datacenter host with a good path to
  `data.metabrainz.org` and a short one to the database. The same 2.32 GB off a
  congested public mirror at 1 MB/s is 39 minutes on its own, which is why
  `TimeoutStartSec=3600` is not excessive. The measured worst case so far is not
  a mirror at all: **the same load driven from a residential workstation ran at
  0.5 MB/s, upload bound, about 5.5 hours.** Run it on the node.

The loader records rows, timings and measured heap/index sizes into
`mb.load_state` on every run, so after the first load the honest numbers for
**your** deployment are one query away:

```sql
SELECT dump_id, status, rows_loaded, finished_at - started_at AS duration,
       pg_size_pretty(bytes_heap), pg_size_pretty(bytes_indexes)
  FROM mb.load_state ORDER BY id DESC LIMIT 5;
```

### Things that will bite, all of them found by doing it

- **Use the DIRECT connection string, never the pooled one.** On Neon the pooled
  host is the one with `-pooler` in it. See "Installing" above.
- **The owner role may carry a `statement_timeout` role default** (15 minutes,
  from `infra/neon/sql/set-role-timeouts.sql`). The `COPY` is a **single
  statement** that runs for the whole load, so under that default it is
  cancelled partway, every time, with an error that explains nothing. The loader
  already clears it per session, and it has to do that with a SQL `SET` rather
  than `PGOPTIONS`, because Neon's proxy rejects `statement_timeout` in the
  libpq startup packet **even on the direct endpoint**. Do not "simplify" that
  away.
- **Do not run with `--max-rows` unless you mean it.** It sets the row floor to
  itself, so a capped run publishes a deliberately short table over a good one.
  It is an operator tool.
- **A failed or killed run is safe and leaves a reason.** SIGTERM runs the EXIT
  trap, which drops the staging table and writes the failure into
  `mb.load_state.error`; the live table is never touched. This was exercised for
  real: a load was killed mid-`COPY`, the trap dropped its staging table, and the
  schema was left exactly as the migration creates it.
- **Nothing here needs a MusicBrainz account or token.** `data.metabrainz.org` is
  a static file host, not the rate-limited web service, so the load spends none
  of the 1 req/s budget. Only the Live Data Feed needs a token, which is a second
  reason not to reach for it.

---

## The cadence, and the evidence for it

**Daily, 09:19 UTC.** The dump is published fortnightly, so this is 14x tighter
than the thing it tracks. The full argument is in the timer file next to the
`OnCalendar=` line; the short version is three measurements:

| fact                                                                                           | source                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Published twice a month, dated the **3rd and 17th** (documented as 1st and 15th)               | the `canonical_data/` directory index, 2026-07-29 |
| **Exactly two dumps retained**, older ones deleted                                             | the same index: two entries, and that is all      |
| A run with nothing to do costs **533 bytes** (a 469-byte listing, a 64-byte digest) and 1.72 s | measured on the node, 2026-07-29                  |

Retention is what sets the cadence, not freshness. A run that fails has until
the _second_ next publication - roughly thirty days - before the dump it missed
is deleted upstream and that fortnight of catalogue is gone for good. A
fortnightly timer gets **one** retry inside that window; a daily timer gets
about thirty.

The publication interval is also not a constant 14 days: the 3rd to the 17th is
14 days and the 17th to the next month's 3rd is 15 to 17. Anything expressed as
a period (`OnUnitActiveSec=14d`) drifts against that and starts firing on the
wrong side of a publication within two months. A calendar timer cannot.

**This depends on the loader checking `mb.load_state` before it fetches
anything.** It does, and the ordering is called out in the loader as
load-bearing: with the licence gate first, a daily no-op would pull 32 MiB a day
off a charity's file host to learn something one `SELECT` already knew. That is
533 bytes against 33,554,432 - about a gigabyte a month saved, for a reordering.

---

## What the deploy path owed this job, and what it still owes

The first four items were the gap. All four are closed, and the closing change is
named next to each so that a reader can check the claim rather than take it.

1. ~~`postgresql-client` on the node.~~ **Done.** `bootstrap.sh` installs
   `postgresql-client-18` from PGDG, keyed on the major version rather than on
   `command -v`, from `ensure_pg_client` - a function rather than a block inside
   `if [ -d backup ]`, so a node converged with `mb-loader` and without `backup`
   still gets a client. `zstd`, `tar`, `curl` and `awk` are all on the stock
   Ubuntu 24.04 image, so nothing else is missing.

2. ~~`/etc/pullfm/mb-canonical.env`, placed from 1Password.~~ **Done**, by
   `pullfm_render_staging_secrets` in `infra/lib/secrets.sh` and shipped by
   `cmd_converge`, root-owned `0600`, exactly the way `backup.env` and
   `metrics.env` travel.

   **It reuses the `database_url_direct` that block already read for `bff.env`
   rather than reading the item title a second time**, and that is deliberate
   rather than tidy. The residency items were mid-rename while this was written:
   `pull-fm/staging/DATABASE_URL_DIRECT_US` pointed at `us-east-1` and the plain
   `pull-fm/staging/DATABASE_URL_DIRECT` still pointed at the EU rollback
   project. A second read of the title would have meant two lines to flip on the
   day of the rename, and one of them quietly loading a fortnight of catalogue
   into the wrong database.

3. ~~`infra/mb-loader/` synced to `/opt/pullfm/infra/mb-loader/` and the units
   enabled.~~ **Done.** `cmd_converge` sends `mb-loader` in the same tar as
   `observability backup lib`; the `if [ -d mb-loader ]` block in `bootstrap.sh`
   installs the loader and both units, and the tail of that script runs
   `systemctl enable --now pullfm-mb-canonical.timer`. **The timer, not the
   service** - copied-but-not-enabled is the exact defect
   `infra/scripts/check-job-schedule.mjs` was written to catch.

   Only `mb-canonical-load.sh` is shipped. `selftest.sh` stays off the node: it
   wants a local docker Postgres from `stack:up` and exits 77 without one, and
   nothing installed here executes it.

4. ~~A `PATH` drop-in for this unit.~~ **Done**, from `install_pg_path_dropin`,
   which now writes the same drop-in for this unit and for
   `pullfm-backup-dump.service` instead of the backup section carrying its own
   copy of the `cat >`:

   ```
   /etc/systemd/system/pullfm-mb-canonical.service.d/10-pg-path.conf
   [Service]
   Environment=PATH=/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   ```

   It is deliberately NOT hard-coded into the unit file here: `${PGMAJOR}` is a
   fact about the node's shape and about the server version, and `bootstrap.sh`
   is where that already lives. Duplicating the literal would mean three places
   to change and two of them silently stale.

   **This one was robustness, not a blocker**, and the distinction is worth
   keeping because the backup job's version of it IS a blocker. `/usr/bin/psql`
   is `pg_wrapper`, which dispatches to whichever major version it decides is
   current based on what else is installed. `pg_dump` **refuses outright** to
   dump a server newer than itself, so the wrong client breaks backups
   completely; `psql` will happily `COPY` into a newer server, and a client 16
   `\copy` of all 31,554,198 rows into the Postgres 18 branch was measured
   working. So a wrong-version client degrades this job rather than stopping it -
   but "works by luck of what got installed" is not a property to keep.

Still open, and outside this work's ownership:

5. **`infra/scripts/check-job-schedule.mjs` extended to cover host jobs.** It
   asserts over `infra/staging/app/systemd/` only, so neither these units nor the
   four `infra/backup/` ones are checked by it at all. That gap predates this
   work, and this job makes it one unit wider. It is the check that would have
   caught this whole class of defect in CI rather than by somebody logging into
   the node and counting timers.

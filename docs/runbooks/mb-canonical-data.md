# The MusicBrainz canonical data pipeline

The `mb` schema holds a local copy of the MusicBrainz canonical data dump. This
is the operator's document: what it is for, what it costs, how to load it, what
breaks and what to do about it, and what still has to change outside this
pipeline before it is finished.

Everything below that is a number was measured on 2026-07-29 against
`musicbrainz-canonical-dump-20260717-080003`, not estimated.

**The whole dump has been loaded end to end**, all 31,554,198 rows, so section 4
is a measurement rather than an extrapolation from a 1-in-40 sample - and two of
the sampled projections turned out to be badly wrong in a way worth
understanding (see "where the extrapolation failed").

**The database it was loaded into no longer exists.** Hosting is moving and a
managed-Postgres region is fixed at project creation, so that branch was
discarded. Nothing in this pipeline is tied to it: the loader takes its
connection from `DATABASE_URL_DIRECT` and holds no host, region or project
identifier anywhere. The measurements are a shape to expect, not this
deployment's figures. **For a first load against a new, empty database, start at
[`infra/mb-loader/systemd/README.md`](../../infra/mb-loader/systemd/README.md)**,
which records the ordering against migrations and the things that only show up by
doing it.

---

## 1. Why it exists

MusicBrainz permits **one request per second for the entire service, per IP**,
as a licence condition. That ceiling is why no HTTP route may call MusicBrainz,
and none does: every request-path read goes through `CachedUpstream.peek`, which
reads `upstream_cache` and never calls out. Only the background cache warmer
fetches, from its own process.

So a peek miss is not slow, it is **empty**. The item is dropped and the user is
shown nothing until the warmer happens to reach that MBID. Working through a
catalogue of 31.5 million recordings at one request per second, the warmer can
cover a working set and never a catalogue.

The local table turns that miss into an answer.

**It is not a rate-limiting or denial-of-service fix and must not be described as
one.** There is nothing on the request path to rate limit. The rate limiter,
single flight and circuit breaker in `@pull-fm/upstream` are untouched by this
work; they see less traffic and behave identically for the traffic they see.

A by-product worth knowing about: an MBID absent from `mb.canonical` cannot be a
recording, release or artist in the canonical set, so **"is this id real" becomes
a local index probe rather than a network call**. `PgCanonicalStore.exists()`
exposes it. Note the asymmetry - the dump is a subset of MusicBrainz, so `true`
is authoritative and `false` means "not known here". Using `false` to reject a
request is a policy decision for the route that makes it.

---

## 2. Licensing, and the check that runs on every load

The canonical dump is **CC0 1.0 Universal**, verified by extracting `COPYING`
from inside the archive rather than reading it off a web page.

MetaBrainz apply licences **per archive**, not repository-wide, which is what
makes the CC0 file evidence rather than boilerplate:

| archive                  | `COPYING` bytes | `COPYING` sha256 | licence            |
| ------------------------ | --------------- | ---------------- | ------------------ |
| canonical dump           | 6,390           | `75f3c90d...`    | CC0 1.0            |
| `mbdump.tar.bz2`         | 6,390           | `75f3c90d...`    | CC0 1.0, identical |
| `mbdump-derived.tar.bz2` | 15,818          | `011e1a16...`    | CC BY-NC-SA 3.0 US |
| Live Data Feed           | n/a             | n/a              | CC BY-NC-SA        |

Two precisions that are easy to state backwards:

- The **core full export is CC0**, not encumbered. It is simply not used here: it
  is far larger and carries no pre-normalised lookup column. That is a size and
  shape argument, not a licence one.
- **Genres are core CC0 data**; "tags (including genre associations)" are
  supplementary and are not. So the genre _vocabulary_ is free and the
  artist-to-genre _associations_ are not, which makes the free half the useless
  half.

CC0 is a public-domain dedication rather than a contract, so it cannot be revoked
for data already obtained. But MetaBrainz can relicense **future** dumps, and
because this job re-fetches fortnightly it is effectively **re-consenting
fortnightly**. A silent licence change would be invisible: the archive would
still download, still parse and still load.

So the loader extracts `COPYING` and compares its SHA-256 to the pinned CC0 value
on **every run**, before it downloads the archive body, and **fails with exit 1**
on a mismatch. A missing `COPYING` is also a failure, not a skip: an archive
whose licence cannot be read is one that must not be loaded.

The dumps need **no access token**. Only the Live Data Feed does. 2.32 GB was
pulled anonymously at HTTP 200.

---

## 3. What the data actually looks like

Measured over the complete 2026-07-17 CSV, 7,519,259,059 bytes uncompressed:

| property                                      | value                                     |
| --------------------------------------------- | ----------------------------------------- |
| rows                                          | **31,554,198**                            |
| rows with a wrong field count                 | 0                                         |
| **rows whose `artist_mbids` is not one UUID** | **4,808,992 (15.2%)**                     |
| duplicate `combined_lookup` values            | **0** (globally unique)                   |
| `combined_lookup` values containing non-ASCII | **0**                                     |
| longest `combined_lookup`                     | 953 characters                            |
| `score` range                                 | 1 .. 5,623,672                            |
| archive                                       | 2,320,377,487 bytes, sha256 `65796cec...` |

Three of those are load-bearing and each one changed the design.

### 3.1 `artist_mbids` is multi-valued, and the head of the file hides it

15.2% of rows carry several UUIDs, comma separated, inside a quoted CSV field:

```
"731b7296-...,97523d67-...,5c21f675-..."   Harry Romero, Junior Sanchez & Alexander Technique
```

The remaining 84.8% carry a single bare UUID with no array punctuation.

That format is `uuid` for neither shape and `uuid[]` for neither shape. Postgres
array input requires braces, so `COPY` into a `uuid[]` column rejects both `a`
and `a,b`, and a `uuid` column rejects `a,b`.

**The first five million rows of the published file are all single-UUID "Various
Artists" credits.** A `uuid` column therefore passes every small fixture, passes
a 800,000-row load, and fails somewhere past row 5,000,000 on the only run that
matters. This was caught by loading the real dump, not by reading it.

The column is stored as `text`, verbatim, which also keeps `COPY` a straight byte
pipe with no projection. The array-ness is recovered by an expression GIN index:

```sql
CREATE INDEX ... USING gin ((string_to_array(artist_mbids, ',')::uuid[]))
```

`string_to_array(text, text)` and the cast are both `IMMUTABLE`, so that is a
legal index expression. **Any query that wants this index must repeat the
expression character for character**, or it falls back to a sequential scan of 31
million rows.

### 3.2 `combined_lookup` is unique and always ASCII

Zero collisions in 31,554,198 rows, and zero non-ASCII characters. The first
means an exact lookup expects at most one answer. The second confirms that
`unidecode` always finishes the job upstream, which is what makes the ASCII test
in `canonical-key.ts` a sound way to decide - for free, before any query - that a
key we could not fully fold cannot match any row.

The index is deliberately **not** declared unique anyway: one collision in a
future dump would fail the whole load and take the feature offline, which is far
worse than two rows sharing a key.

### 3.3 `score` is a rank over releases and LOWER IS BETTER

Not a popularity score, despite the name. Every row sharing a `release_mbid`
carries the same value (274,830 releases sampled, zero with more than one
distinct score), and it is only meaningful within one artist: Shorty Rogers ranks
4 while Simon & Garfunkel's _Bridge Over Troubled Water_ ranks 564.

**Order ascending. Never compare across artists.** `ORDER BY score DESC` would
consistently pick the least canonical row.

---

## 4. Measured footprint, and how long the load takes

**The real thing, all 31,554,198 rows**, loaded by
`pullfm-mb-canonical.service` on `pullfm-staging-app-1` (Ashburn, 3 vCPU, Ubuntu
24.04) into the `us-east-1` Neon staging branch on **2026-07-29 at 21:22:39
UTC**. This is the load that is live: `mb.canonical` holds these rows now, and
`mb.load_state` row 3 records them.

**By the unit, not by hand.** `systemctl start --no-block
pullfm-mb-canonical.service`, so the work was supervised by systemd under the
committed `TimeoutStartSec=3600` and `MemoryMax=512M` rather than by whatever
shell happened to be attached. Two earlier attempts driven by hand from an SSH
session are rows 1 and 2 of `mb.load_state`, both `failed`, one of them because a
ten-minute tool timeout killed the session out from under it. That is the
difference the unit buys and the reason the runbook says to use it.

**Read `mb.load_state`, not this section.** The loader writes timings, row counts
and measured sizes on every run:

```sql
SELECT dump_id, status, rows_loaded, finished_at - started_at AS duration,
       pg_size_pretty(bytes_heap), pg_size_pretty(bytes_indexes)
  FROM mb.load_state ORDER BY id DESC LIMIT 5;
```

### Time: 3 minutes 35 seconds, end to end

| phase                                         | wall      |
| --------------------------------------------- | --------- |
| discovery, `.sha256`, licence gate            | 4 s       |
| stream + `COPY` (2.32 GB archive, 7.5 GB CSV) | 138 s     |
| `count(*)` against the row floor              | 5 s       |
| five indexes + `ANALYZE`                      | 67 s      |
| swap + bookkeeping                            | 1 s       |
| **total**                                     | **215 s** |

`mb.load_state` records `00:03:30.235` for the same run; the 5-second difference
is the unit's own start and teardown either side of the script. CPU was 1 min
16.7 s of the 3 min 35 s, so this job is waiting on the network for most of its
life. Per index, from `\timing` inside the build: `pkey` 7.1 s, `lookup` 18.4 s,
`recording` 11.9 s, `release` 9.0 s, `artist` (GIN) 20 s.

**The comparison with the earlier EU load is the useful part, and it is not
reassuring in the way it first looks.** That run took 3 min 58 s with a 129 s
`COPY` and 98 s of indexes. This one is 23 seconds faster overall, by two changes
in opposite directions: the download got **slower** (138 s against 129 s, a
longer path to `data.metabrainz.org`) and the index build got **30% faster** (67 s
against 98 s, a larger Neon compute). Totals that agree to within 10% by
offsetting error are a coincidence, not stability. Download tracks distance to the
publisher; indexes track the database's compute; they move independently.

The number that shows how wide that spread gets: **the same load driven from a
residential workstation ran at 0.5 MB/s, upload bound, about 5.5 hours** - 92x
this run. The timer lives on the node for that reason and no other.

### Disk on the job host: none

**Peak 28.4 MB for the entire process tree**, from systemd's own accounting for
the unit ("Consumed 1min 16.710s CPU time, 28.4M memory peak, 0B memory swap
peak"), and the node's free space was byte-identical before and after (`2.9G`
used on a 75G disk both times). An earlier `/usr/bin/time -v` run of the same
script outside systemd reported 19 MB; the difference is the cgroup accounting
the unit adds, not a change in the pipeline. The archive is never written down:
`curl -> tee(sha256) -> zstd -dc -> tar -xO -> psql COPY` means the 2.32 GB
archive and the 7.5 GB CSV exist only as bytes in flight. Nothing about this job
needs a big node - a machine that could not hold the file can still load it, and
this one loaded it while also serving traffic, both Redis instances and nginx in
3.8 GB.

### Space in Postgres: 10 GB

| component                             | **measured at 31,554,198 rows**  | 1-in-40 sample projected |
| ------------------------------------- | -------------------------------- | ------------------------ |
| heap                                  | **6,558 MB**                     | 6.42 GB                  |
| `canonical_lookup_idx` btree          | 1,766 MB                         | 1.73 GB                  |
| `canonical_recording_idx` btree       | 949 MB                           | 0.93 GB                  |
| `canonical_pkey` btree                | 676 MB                           | 0.66 GB                  |
| `canonical_release_idx` btree         | **331 MB**                       | 0.89 GB                  |
| `canonical_artist_idx` GIN expression | **227 MB**                       | 1.44 GB                  |
| **total, default index set**          | **10 GB** (3,950 MB of it index) | ≈ 12.1 GB                |

**Every figure in the middle column reproduced to the megabyte on the `us-east-1`
branch**, read out of `pg_relation_size` after the swap. That is worth noting
because the two timings in the section above did not: storage is a property of the
data and the index types, so it is the part of this table that travels between
deployments unchanged, while wall clock is a property of where the job runs.

### Where the extrapolation failed, and why it matters

Four of the six rows above were projected to within 3%. Two were not, and both
were **over**-estimates, in the same direction and for the same reason:

- `canonical_artist_idx` (GIN): projected 1.44 GB, **actual 227 MB - 6.5x too
  high**.
- `canonical_release_idx` (btree): projected 0.89 GB, **actual 331 MB - 2.7x**.

Both index a **low-cardinality** column, and both structures share work across
rows with the same key. A GIN index stores one entry per distinct artist UUID
with a compressed posting list of row pointers, and a btree deduplicates
identical keys into a single posting list too (Postgres 13+). 31.5 million rows
carry far fewer distinct artists and releases than that - many recordings per
release, many releases per artist - so scaling 40x adds mostly _pointers to
existing keys_, not new keys.

The lesson is general and worth keeping: **bytes-per-row from a uniform sample
is only linear for structures that store one independent thing per row.** The
heap and the three high-cardinality btrees projected almost exactly. Anything
that aggregates by key will be over-projected, and the error grows with the
sampling ratio.

### The 512 MiB problem: check it, do not assume it

This document previously recorded that the database was on Neon's **free plan**,
whose hard limit is `branch_logical_size_limit_bytes = 536870912` - 512 MiB per
branch - and that the dump therefore did not fit, by a factor of about 24.

That was true of the free plan and stopped being true when the plan changed. The
EU project the first load ran against reported a 16 TiB branch limit and 0.25 to
8 CU of compute autoscaling, and 10 GB fitted with room to spare.

**This is a per-project property and it does not travel**, which the residency
move is the demonstration of: the `us-east-1` project (`cold-brook-02833828`) is a
different project, and the load above is the evidence that its `staging` branch
holds 10 GB - not an inference from the EU project's limit. A new project starts
on whatever plan it was created with, so before the first load on any new
database, read the limit rather than assuming it:

```bash
curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects?org_id=$PULLFM_NEON_ORG_ID" |
  python3 -c 'import json,sys; [print(p["name"], p["branch_logical_size_limit_bytes"]) for p in json.load(sys.stdin)["projects"]]'
```

Anything below about 11 GB will not hold this dump. **The failure mode if you
skip this check is not subtle but it is expensive**: the load runs, streams the
whole 2.32 GB archive, and dies partway through the `COPY` when the branch hits
its ceiling. Nothing is corrupted - the staging table is dropped and the live
table is untouched - but you find out several minutes in rather than in one API
call.

**The cost moved rather than disappeared.** 10 GB of managed-Postgres storage is
a recurring line item for data that is rebuildable from a public URL in four
minutes. That is the argument for keeping `mb` out of the backups (section 9),
and it is worth re-checking against the plan's included storage before this ships
to production.

`--max-rows` still exists for an environment that is size-capped for some other
reason, and the row floor (`--min-rows`, default 20,000,000) is what stops a
partial load being published by accident. **`--max-rows` sets the floor to
itself**, so a capped run publishes a deliberately short table. It is an operator
tool, and leaving it set in a scheduled job would quietly replace the catalogue
with a prefix of it.

---

## 5. Measured query performance

**At the full 31,554,198 rows**, Neon staging branch, `EXPLAIN (ANALYZE)`. The
789k column is the earlier sample, kept because the comparison is the point: a
40x table costs roughly nothing extra, because every one of these is an index
probe rather than a scan.

| query                                          | plan at 31.5M rows                             | 31.5M   | 789k    |
| ---------------------------------------------- | ---------------------------------------------- | ------- | ------- |
| exact `combined_lookup = $1 ORDER BY score`    | Index Scan `canonical_lookup_idx`, no sort     | 0.34 ms | 0.99 ms |
| artist prefix `~>=~ / ~<~` + `ORDER BY score`  | Index Scan `canonical_lookup_idx` + top-N sort | 2.08 ms | 1.15 ms |
| artist containment via the GIN expression      | Bitmap Index Scan `canonical_artist_idx`       | 0.16 ms | 0.09 ms |
| `recording_mbid = $1` (a miss)                 | Index Only Scan `canonical_recording_idx`      | 0.55 ms | 1.14 ms |
| pg_trgm `combined_lookup % $1` (threshold 0.6) | Bitmap Index Scan `canonical_trgm_idx`         | _n/a_   | 21.2 ms |

Every one of the four default-index paths uses the index it was built for at
full scale; none falls back to a sequential scan. The prefix scan is the only
one that grew, and visibly so rather than mysteriously: `radiohead` matches 2,251
rows at full scale against a handful in the sample, and those 2,251 go through a
top-N heapsort to satisfy `ORDER BY score`. That is the cost of the prefix being
selective on artist but not on release, and it is still 2 ms.

`pg_trgm` is not built (see below), so there is no full-scale number for it.

### Why `text_pattern_ops` and `~>=~` rather than `LIKE` or `>=`

The dump's fold is per character, so it distributes over the concatenation and a
folded artist name is exactly a prefix of every one of that artist's
`combined_lookup` values. Finding an artist is a prefix scan. Three ways to write
it, two of which are wrong:

- `>=` / `<` compare under the **database collation**. Under any non-C collation
  string ordering is not byte ordering, so a prefix range is simply not the set
  of strings with that prefix. It would return wrong rows, quietly, on some
  deployments and not others. This Neon database happens to be `C.UTF-8`, so it
  would have worked here - which is exactly why not depending on it matters.
- `LIKE $1 || '%'` is correct but its index use depends on the planner extracting
  a prefix from a value it does not know at plan time. A generic plan there is a
  sequential scan of 31 million rows.
- `~>=~` and `~<~` are the `text_pattern_ops` operators. Byte ordering regardless
  of collation, guaranteed to use the index. The exclusive upper bound is
  computed in JS (`prefixUpperBound`), which is sound only because the keys are
  provably ASCII.

### pg_trgm: measured, and off by default

It works and it is useful - a typo'd `thebeatleshermajesti` returns _The Beatles
/ Her Majesty_ at similarity 0.826. It costs **3.1 GB projected** and is 20x
slower than the exact path.

**Recommendation: leave it off.** Fuzzy matching already exists one layer up, on
`mbid_crosswalk.normalized_key`, over a table that holds only names this product
has actually seen. A second trigram index over 31 million rows the product has
never asked about is 3.1 GB spent on the least likely lookups. Turn it on with
`--with-trgm` if the local hit rate turns out to be limited by near-misses rather
than by absence, and measure before and after.

---

## 6. Running it

**Normally, nothing runs it: the timer does.** `pullfm-mb-canonical.timer` fires
daily at 09:19 UTC on the staging application node and is installed by
`converge`. Forcing a run, which is how the first load is done and how a missed
publication is caught up:

```bash
# On the node. --no-block, so a dropped SSH session cannot orphan the load.
sudo systemctl start --no-block pullfm-mb-canonical.service
journalctl -u pullfm-mb-canonical.service -f
```

**Do not run a full load from a workstation.** Measured 2026-07-29: from a
residential connection the 2.32 GB fetch ran at **0.5 MB/s, upload bound, about
5.5 hours**; the same load driven by the unit on the node took minutes. Distance
to `data.metabrainz.org` and to the database is essentially the entire cost of
this job, which is the whole reason the timer lives on the node.

The forms below are the operator tools, run from a checkout:

```bash
# Normal fortnightly run. Discovers the newest dump, declines if already loaded.
DATABASE_URL_DIRECT=postgres://... ./infra/mb-loader/mb-canonical-load.sh

# Discover and report, change nothing.
DATABASE_URL_DIRECT=... ./infra/mb-loader/mb-canonical-load.sh --dry-run

# Bounded load for a size-capped environment.
DATABASE_URL_DIRECT=... ./infra/mb-loader/mb-canonical-load.sh --max-rows 800000

# From a local archive, verified in full before a single row is parsed.
DATABASE_URL_DIRECT=... ./infra/mb-loader/mb-canonical-load.sh \
    --archive /var/tmp/musicbrainz-canonical-dump-20260717-080003.tar.zst
```

**The direct URL, never the pooled one.** The swap takes `ACCESS EXCLUSIVE` and
the loader holds an advisory lock across statements; a transaction pooler hands
the server connection to somebody else at COMMIT and both silently stop working.
Neon's pooled endpoint is PgBouncer in transaction mode.

The connection is parsed into `PGHOST`/`PGUSER`/`PGPASSWORD`/... and **never
appears in argv**, where any local user could read it out of `ps` for the hour a
load takes. An absent `sslmode` defaults to `require`, not libpq's weaker
`prefer`; the local self-test passes `?sslmode=disable` explicitly because the
docker Postgres speaks no TLS.

### Never compute the dump directory from a date

MetaBrainz document the cadence as "twice a month, on the 1st and 15th". **The
published directories are dated the 3rd and the 17th**, a consistent two-day
offset. Anything that derives the directory name from the documented schedule
404s on the 1st of every month, silently, on a fortnightly job nobody watches.
The loader enumerates the directory listing and picks the newest. This is the
"simplification" a future reader will reach for; it is wrong.

### The self-test

```bash
./infra/mb-loader/selftest.sh          # 24 cases against a real Postgres
```

It builds fixture archives and makes every failure mode actually happen -
truncated download, sha mismatch, malformed row, relicensed `COPYING`, missing
`COPYING`, a short but well-formed load, a blocked swap, two concurrent loaders -
and asserts after each one that **the previous dump is still serving**. Requires
docker Postgres (`pnpm stack:up`); exits 77 if it cannot get one.

---

## 7. How the swap works

The loader **never mutates the live table**. Every load builds
`mb.canonical_stage_<pid>_<epoch>`, private to that run, and publishes it with
one transaction:

```sql
BEGIN;
SET LOCAL lock_timeout = '15000ms';
DO $$ BEGIN PERFORM pg_advisory_xact_lock(7, hashtext('mb:canonical:swap')); END $$;
DROP TABLE IF EXISTS mb.canonical;
ALTER TABLE mb."<stage>" RENAME TO canonical;
ALTER INDEX mb."<stage>_pkey" RENAME TO canonical_pkey;
-- ... one rename per index ...
COMMIT;
```

- **One transaction, so there is no midway.** Anything that fails before COMMIT
  rolls back and the previous data keeps serving. The self-test proves this for
  each failure mode rather than asserting it.
- **DROP then RENAME**, not RENAME-RENAME-DROP: dropping the old table first frees
  its index names inside the same transaction, so the staged indexes take the
  canonical names without a collision and without a second pass.
- **`lock_timeout` is what stops this wedging the application.** The DROP needs
  `ACCESS EXCLUSIVE`, so a reader mid-query holds it off; without a timeout the
  swap queues, and because it is queued for `ACCESS EXCLUSIVE` every subsequent
  reader queues behind it. That turns a maintenance job into an outage.
- **Staging names carry the pid**, so two loaders cannot destroy each other's
  work. They duplicate effort, which is wasteful and harmless; the advisory lock
  means the published result is one of the two loads, whole, never a mixture.

**Verified after the 2026-07-29 21:22 UTC load**, on the machine rather than from
the script's exit code: `mb.canonical` holds 31,554,198 rows, all five indexes are
present under their canonical names (`canonical_pkey`, `canonical_lookup_idx`,
`canonical_recording_idx`, `canonical_release_idx`, `canonical_artist_idx`), there
is **no `mb.canonical_stage_*` table left**, and `mb.load_state` has **no row in
`running`**. The index names are the evidence the rename half of the transaction
committed; the absent stage table is the evidence nothing was left half-published.

If a load ever does leave either behind, recovery is two statements and does not
touch the live table:

```sql
DROP TABLE mb."canonical_stage_<pid>_<epoch>";
UPDATE mb.load_state SET status = 'failed' WHERE status = 'running';
```

Two advisory-lock keys share namespace 7 and **must stay distinct**:
`mb:canonical:swap` (transaction-scoped, in the loader) and `mb:canonical:refresh`
(session-scoped, held by the job for its whole run). One key would make the
loader block on the job that spawned it, from a different session, forever.

---

## 8. The feature flag

`MB_LOCAL_ENABLED`, **default `false`**.

This is a deliberate response to the `SEATGEEK_ENABLED` lesson: that flag was
documented as a kill switch, declared with `.default("true")` in `config.ts`
**and** force-written `true` by `infra/lib/secrets.sh`, so the documented lever
had already been bypassed by every deployment holding credentials before anybody
thought to pull it.

Layers that fail closed, all of them tested:

1. `config.ts` - `.default("false")`
2. `LocalFirstMusicBrainzClient` - requires the boolean `true`; the string
   `"true"`, a `1`, a `null` and `undefined` all leave it off
3. the same class - stays off when no store was wired, whatever the flag says
4. `PgCanonicalStore` - answers "miss" rather than throwing when the table is
   absent, so even an enabled resolver degrades to the previous behaviour, and
   backs off for 60 s rather than failing once per lookup

**The layer not under this code's control**: whatever `infra/lib/secrets.sh`
writes into the deployed environment. If it ever starts asserting a value for
`MB_LOCAL_ENABLED`, the default above stops being a defence - exactly as it
stopped being one for SeatGeek. It currently does not.

Turning the flag off restores the previous behaviour byte for byte, because the
local path is a lookup in front of an unchanged client rather than a replacement
for it.

### What the flag does and does not cover

| method                                               | flag on                         |
| ---------------------------------------------------- | ------------------------------- |
| `searchRecording(artist, title)`                     | local exact key, then network   |
| `searchArtist(name)`                                 | local prefix scan, then network |
| `lookupRecording` / `lookupArtist` / `lookupRelease` | **always network, unchanged**   |

The MBID lookups are deliberately not intercepted. The dump carries no `length`,
no release `date`, no `country` and no track count, so a local answer would be a
recording with no duration - and the warmer would then write that impoverished
row into `upstream_cache` where the request path reads it. A partial answer that
displaces a complete one is worse than a slow one.

Every locally answered search is **re-verified** before it is returned: the row's
own `artist_credit_name` is re-folded and compared to the query's. A prefix scan
finds `beatlesque` for `beatles`, and the fold concatenates, so artist `ab` +
title `c` reaches the same key as artist `a` + title `bc`. Without the re-fold
the resolver writes a wrong MBID into a `UNIQUE`-keyed crosswalk, permanently.

### Coverage gap, by design

`combined_lookup` is `unidecode(...)`, a 100k-entry transliteration table.
`@pull-fm/upstream` has **no runtime dependencies** and is not acquiring one for
a lookup key. `canonical-key.ts` implements the Latin-script subset: NFKD plus
combining-mark removal handles every precomposed accent, and an explicit table
covers the atomic Latin letters NFKD does not decompose (`ø æ ß ł đ þ ...`).

Non-Latin scripts are **not** transliterated, so a CJK title is unreachable
locally. That is the safe direction: no local match means the caller falls
through to the unchanged rate-limited path. The failure mode is "the optimisation
did not apply", never "the wrong MBID was returned". `canonicalCoverage()` decides
this before spending a query, and `LocalFirstStats.unmatchable` counts it so the
gap is measurable rather than assumed small.

---

## 9. Backups: what `infra/backup` must exclude

**`mb` must not be in the R2 logical dumps.** Every byte in it is rebuildable
from a public URL, none of it is user data, and at a projected 12 GB it would
dominate both the dump and every restore drill that has to move it before the
drill can assert anything about the data that actually matters.

`infra/backup/pullfm-backup.sh` currently runs `pg_dump --format=custom
--compress=9` with **no schema restriction at all**, deliberately - the comment
there explains that `--schema=public` silently dropped all four extensions and
produced a dump that could not restore anywhere but into a Neon branch. Do not
reintroduce `--schema`.

**Recommended change, one flag:**

```
pg_dump --format=custom --compress=9 --exclude-table-data='mb.*' ...
```

`--exclude-table-data` rather than `--exclude-schema`, and the difference is a
trap worth stating:

- `--exclude-schema=mb` drops the **DDL as well as the rows**. A restored
  database then has `schema_migrations` claiming `0007_mb_canonical` is applied
  while the schema it creates does not exist, so the next migration run does
  nothing and the schema stays missing until somebody notices.
- `--exclude-table-data='mb.*'` keeps the empty tables and drops the rows. The
  restored database is structurally identical, `mb.canonical` is empty, the
  reader treats empty as a miss, and the next loader run refills it.

Either is **safe** as far as this code is concerned - `PgCanonicalStore` tolerates
the whole schema being absent and turns it into a miss - but the second leaves a
restored database that is a truthful copy of the original minus the rebuildable
rows, which is what a restore drill should be asserting against.

Also worth adding to the backup metadata: `mb.load_state` is excluded along with
everything else in the schema, so after a restore "which dump am I serving" reads
as "none". That is correct and self-healing; the refresh job fixes it on its next
run.

---

## 10. The refresh job, and what it took to get it running

`apps/bff/src/services/mb-canonical-refresh.ts` plus
`apps/bff/src/scripts/refresh-mb-canonical.ts`. Fortnightly or more often;
running more often is nearly free because the loader exits 0 without doing
anything when the newest published dump is already loaded, and running **less**
often than fortnightly is the real risk - only two dumps are retained upstream,
so sleeping through two publications means the one you are behind on is gone.

The advisory lock is taken with `pg_try_advisory_lock` on a **pinned connection**
via `Database.withConnection`. A session-scoped lock taken through the pool lands
on an arbitrary connection which is immediately returned, so the unlock usually
runs on a different connection and leaks it, while a concurrent caller handed the
same connection re-acquires it successfully because advisory locks are re-entrant
within a session. The mutual exclusion then silently does not exist while every
symptom of having it remains.

Exit codes:

| code | meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | ran, or declined because another run held the lock, or nothing new |
| 1    | **could not run and changed nothing.** The alert-worthy case       |
| 2    | ran with failures, but nothing is unbounded and nothing is broken  |

A **timeout is 2, not 1**: the loader is killed with `SIGTERM`, its EXIT trap
drops the staging table, and the live table was never touched. Nothing changed
and nothing is broken. Conflating that with a real failure is how an operator
learns to ignore the code that means something.

The loader reports failure by **exit code, not by throwing**, which is the same
shape as `WorkOsClient.deleteUser` - the bug the directory reaper shipped with,
where only a thrown error was checked and every refused deletion counted as a
success. `defaultRunner` resolves with the code and never rejects on a non-zero
one, so a caller is forced to look at it.

### The schedule: daily, and why not fortnightly

`infra/mb-loader/systemd/pullfm-mb-canonical.{service,timer}`, **daily at 09:19
UTC**. The full argument is in the timer file and in
`infra/mb-loader/systemd/README.md`; the three measurements it rests on:

| fact                                                 | evidence                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Published twice a month, dated the **3rd and 17th**  | the `canonical_data/` index on 2026-07-29                   |
| **Exactly two dumps retained**; the third is deleted | the same index has exactly two entries, and that is the lot |
| A no-op run costs **533 bytes** and 1.72 s           | measured on the node                                        |

**Retention, not freshness, is what sets the cadence.** A failed run has until
the _second_ next publication - about thirty days - before the dump it missed is
deleted upstream and that fortnight of catalogue is unrecoverable. A fortnightly
timer gets one retry inside that window; a daily timer gets about thirty. Daily
also happens to bound staleness at one day rather than the four weeks a
misaligned fortnightly timer would allow, but that is the secondary benefit.

The publication interval is **not a constant 14 days** - the 3rd to the 17th is
14, the 17th to the next month's 3rd is 15 to 17 - so a period-based timer
(`OnUnitActiveSec=14d`) drifts and starts firing on the wrong side of a
publication. A calendar timer cannot.

This is only affordable because the loader checks `mb.load_state` **before** it
fetches anything. It did not always; with the licence gate first, a daily no-op
pulled 33,554,432 bytes a day off a charity's file host instead of 533.

### Installed and running. What that took, and what is still open

1. ~~**The unit files are not installed by anything.**~~ **Closed.** `converge`
   ships `infra/mb-loader` in the same tar as `observability backup lib`;
   `bootstrap.sh` gates on `if [ -d mb-loader ]`, installs the loader to
   `/opt/pullfm/infra/mb-loader/`, installs both units, writes the versioned
   `PATH` drop-in, and runs `systemctl enable --now pullfm-mb-canonical.timer`;
   `infra/lib/secrets.sh` renders `/etc/pullfm/mb-canonical.env` root-owned
   `0600`. **Verified by running the real `converge` rather than by reading the
   diff**: it created
   `/etc/systemd/system/timers.target.wants/pullfm-mb-canonical.timer` and
   `systemctl list-timers` then showed a NEXT.

   **Then the node was rebuilt, and that is the better evidence.** Twenty
   minutes after the load, unrelated work destroyed and recreated
   `pullfm-staging-app-1` - new tailnet address, zero timers, empty
   `/etc/pullfm`. The next `converge`, run by somebody else for an unrelated
   reason and touching nothing in `infra/mb-loader`, brought the loader, the two
   units, the `PATH` drop-in, the `0600` env file and the enabled timer back onto
   a bare machine with no manual step. That is the property that matters: the
   node is disposable on purpose, because the database is Neon and the node holds
   nothing, so "rebuild it" is the documented answer to a whole class of problem.
   A control that only exists because somebody once installed it by hand is a
   control that disappears on exactly that day. `mb.canonical`'s 31,554,198 rows
   were unaffected - they are in Neon, not on the node.

   The state it was in before is worth keeping written down, because it is the
   shape a repository cannot show you. The units were correct and committed, and
   `mb.canonical` had never held a row. An earlier attempt had copied them onto
   the node to run `systemd-analyze verify` and removed them again, so the
   machine had been touched by this work and carried no trace of it. That is
   PULLFM-RISK-012 in a second place: a control that exists in git, which is why
   reading the repository would have concluded it was present.

2. ~~**`psql` is absent from the staging node.**~~ **Closed.** `bootstrap.sh`
   installs `postgresql-client-18` from PGDG via `ensure_pg_client`, keyed on the
   major version rather than on `command -v`, because the unversioned
   `postgresql-client` metapackage pulls client 16 on noble and a check a WRONG
   version satisfies is not a check. It is a shared function rather than a block
   inside the backup section, so a node converged with `mb-loader` and without
   `backup` still gets a matching client.

3. **`infra/scripts/check-job-schedule.mjs` only looks at
   `infra/staging/app/systemd/`.** Neither these units nor the four
   `infra/backup/` ones are asserted by it at all. That gap predates this work,
   and it is the check that would have caught the defect in item 1 in CI rather
   than by somebody logging into the node and counting timers. **Still open**,
   and outside this work's ownership.

4. **The BFF entrypoint cannot run in the BFF image.**
   `apps/bff/package.json` now has `refresh:mb-canonical`, but the runtime image
   is `node:22-alpine` plus `dumb-init` and carries none of `psql`, `zstd`,
   `curl`, and does not contain the loader script either. So the timer runs the
   loader **on the host**, the same way `infra/backup` does, and
   `MbCanonicalRefresh`'s cross-node advisory lock is currently unused. That is
   acceptable at one application node and is not acceptable at two; the README in
   `infra/mb-loader/systemd/` records the choice and the trigger to revisit it.

---

## 11. Tests

| suite                                                       | cases |
| ----------------------------------------------------------- | ----- |
| `packages/upstream/src/musicbrainz/canonical-key.test.ts`   | 20    |
| `packages/upstream/src/musicbrainz/canonical-store.test.ts` | 16    |
| `packages/upstream/src/musicbrainz/local-first.test.ts`     | 18    |
| `apps/bff/src/services/mb-canonical-refresh.test.ts`        | 14    |
| `infra/mb-loader/selftest.sh`                               | 24    |

The key fixtures in `canonical-key.test.ts` are **not invented**: every expected
value is the `combined_lookup` the 2026-07-17 dump actually published for that
row. A fold that merely looks reasonable produces keys that match no row, the
local table silently answers nothing, and every other test still passes because
falling through is legal behaviour.

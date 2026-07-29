# The MusicBrainz canonical data pipeline

The `mb` schema holds a local copy of the MusicBrainz canonical data dump. This
is the operator's document: what it is for, what it costs, how to load it, what
breaks and what to do about it, and the two things outside this pipeline that
have to change before it is finished.

Everything below that is a number was measured on 2026-07-29 against
`musicbrainz-canonical-dump-20260717-080003` and a disposable Neon branch, not
estimated. The extrapolations are labelled as such.

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

## 4. Measured footprint

Loaded into a disposable Neon branch off staging, as a **uniform 1-in-40 sample**
of the whole file (788,854 rows, 15.23% multi-artist - the full file is 15.24%,
so the sample is representative rather than the unrepresentative head).

| component                                           | measured | bytes/row | **projected at 31,554,198 rows**   |
| --------------------------------------------------- | -------- | --------- | ---------------------------------- |
| heap                                                | 164.2 MB | 218.3     | **6.42 GB**                        |
| `canonical_lookup_idx` btree                        | 44.2 MB  | 58.7      | 1.73 GB                            |
| `canonical_artist_idx` GIN expression               | 36.8 MB  | 48.9      | 1.44 GB                            |
| `canonical_recording_idx` btree                     | 23.8 MB  | 31.6      | 0.93 GB                            |
| `canonical_release_idx` btree                       | 22.8 MB  | 30.3      | 0.89 GB                            |
| `canonical_pkey` btree                              | 16.9 MB  | 22.5      | 0.66 GB                            |
| **total, default index set**                        | 309 MB   | 412       | **≈ 12.1 GB** (5.6 GB of it index) |
| `canonical_trgm_idx` GIN pg_trgm _(off by default)_ | 79.3 MB  | 105.4     | +3.10 GB                           |
| **total with pg_trgm**                              | 388 MB   | 517       | **≈ 15.2 GB**                      |

The prior estimate of 15-20 GB was close for the with-trgm case and high for the
default one.

### The 512 MiB problem

The Neon project is on the **free plan**, whose hard limit is
`branch_logical_size_limit_bytes = 536870912` - **512 MiB per branch**. The
staging branch currently holds 33 MB.

**The full dump does not fit, by a factor of about 24.** This pipeline needs a
paid Neon plan, or a different host for the `mb` schema, before it can serve the
whole catalogue. The loader's `--max-rows` exists so a size-capped environment can
hold a bounded prefix rather than nothing, and the row floor (`--min-rows`,
default 20,000,000) is what stops a partial load being published by accident.

---

## 5. Measured query performance

789k rows, Neon 0.25-CU compute, `EXPLAIN (ANALYZE)`:

| query                                          | plan                                       | execution |
| ---------------------------------------------- | ------------------------------------------ | --------- |
| exact `combined_lookup = $1 ORDER BY score`    | Index Scan `canonical_lookup_idx`, no sort | 0.99 ms   |
| artist prefix `~>=~ / ~<~` + `ORDER BY score`  | Index Scan `canonical_lookup_idx` + top-N  | 1.15 ms   |
| artist containment via the GIN expression      | Bitmap Index Scan `canonical_artist_idx`   | 0.09 ms   |
| `recording_mbid = $1`                          | Index Only Scan `canonical_recording_idx`  | 1.14 ms   |
| pg_trgm `combined_lookup % $1` (threshold 0.6) | Bitmap Index Scan `canonical_trgm_idx`     | 21.2 ms   |

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

## 10. The refresh job, and what is still missing

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

### Not done, and outside this work's ownership

1. **No `refresh:mb-canonical` script in `apps/bff/package.json`.** Every other
   job is invoked by its pnpm command from a systemd unit. Adding it needs
   `"refresh:mb-canonical": "node dist/scripts/refresh-mb-canonical.js"`.
2. **No systemd timer.** `infra/staging/app/systemd/` needs a
   `pullfm-refresh-mb-canonical.{service,timer}` pair with `SuccessExitStatus=2`
   and an `OnFailure`, enabled by `bootstrap.sh`, and the job added to the list in
   `infra/scripts/check-job-schedule.mjs`. Until then this job is a command that
   nothing invokes - which is the exact gap that checker was written to catch.
3. **The 512 MiB Neon free-plan branch limit** (section 4). The full dump needs a
   paid plan or a different host.

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

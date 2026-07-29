# Preview sourcing options: is there a bulk alternative to one iTunes call per track?

**Researched 2026-07-28.** Every claim below was checked with a live HTTP request on that date
unless explicitly marked otherwise. Nothing here is reconstructed from memory. Where a page
required a login, returned 403, or rendered only via JavaScript, this document says so rather than
filling the gap.

**Convention:** text in a blockquote marked **VERBATIM** is copied exactly from the cited source.
Everything else is the reviewer's paraphrase or judgement.

---

## The question

We resolve MusicBrainz recording MBIDs to 30-second Apple preview URLs via
`itunes.apple.com/search`, one call per track, inside a conservative 15/min budget. Preview URLs
are **content-addressed** and therefore not derivable from a track id, an ISRC, or anything else:
the path segments are the asset UUID's own prefix.

> trackId `1679849823` maps to
> `https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview126/v4/8d/e0/bb/8de0bb10-0593-83cc-4d2c-4e9f6ea9b575/mzaf_16440589638018943894.plus.aac.p.m4a`
>
> `8d/e0/bb` is the prefix of `8de0bb10-…`. There is no function from track id to preview URL.

So the question is whether some dataset, API, or service has already collected Apple preview URLs,
or Apple/iTunes track ids, keyed by something we hold (MBID, ISRC, or artist+title), so that we can
seed in bulk rather than learn ~15 rows a minute.

---

## Verdict

**Nothing exists. Apple remains the only path. Pre-seed and accept the long tail.**

Every candidate was checked and every one fails, for one of three reasons: it does not contain
preview URLs, it is not keyed to anything we hold, or it is dead / dying / paywalled. There is no
public corpus of Apple preview URLs and no public MBID-to-Apple-track-id mapping of usable size.

**However, the research produced one genuinely actionable result that was not the thing we went
looking for:** the same unauthenticated iTunes endpoint we already use supports **batching and
album-level expansion**, and that is worth a measured **~10x** on preview acquisition per API call.
See [The one real win](#the-one-real-win-album-expansion-on-the-endpoint-we-already-use). This does
not remove the Apple dependency — nothing does — but it materially changes the seeding economics
and it reduces exposure to the IP-reputation 403 risk recorded as A14 in the Apple terms review,
because it needs roughly a tenth as many requests.

### Summary table

The final column is the one that matters. "Removes Apple dependency" means we would no longer need
to call Apple at all.

| Option                               | Has preview URLs?              | Keyed to MBID / ISRC / artist+title? | Licence / cost                      | Removes Apple dependency?                 |
| ------------------------------------ | ------------------------------ | ------------------------------------ | ----------------------------------- | ----------------------------------------- |
| HF `xinyangli/apple_music_id`        | No                             | **No — unkeyed bare id list**        | Unstated (no card, no licence)      | **No.** Useless: nothing to join on       |
| Apple Music API `filter[isrc]`       | **Yes** (`previews` attribute) | ISRC, max 25/request                 | **$99/yr** Apple Developer Program  | **No.** It _is_ Apple, just the paid door |
| Odesli / song.link                   | **No**                         | Platform URLs/ids only, not MBID     | Free, 10 req/min                    | **No.** Also **retired 2026-07-31**       |
| Wikidata P10110                      | No                             | MBID — but only **689 rows**         | CC0                                 | **No.** Too small to matter               |
| MusicBrainz url-rels (release level) | No                             | MBID                                 | CC0                                 | **No.** 0.194% link rate                  |
| iTunes album expansion _(new)_       | **Yes, 100%**                  | artist+album                         | Same grant we already operate under | **No** — but ~10x cheaper                 |

---

## Thread 1: the HuggingFace dataset lead

The prior run surfaced a hit reading `apple-music-id-from-metadata` / "Apple Music Track ID
Lookup" and never investigated it. It has now been found and investigated.

### What it actually is

Searching the HuggingFace datasets API for `apple-music-id`, `apple music`, and `itunes` returns
exactly one plausible candidate:

- **`xinyangli/apple_music_id`** — <https://huggingface.co/datasets/xinyangli/apple_music_id>
- Created 2026-06-25, last modified 2026-06-26, 7,775 downloads, 0 likes
- `usedStorage` 229,475,238 bytes
- Tags: `region:us` only
- **`gated: false`, `private: false`** — no login required, downloads fine
- **No README, no dataset card, no licence field of any kind.** The `tags` array contains no
  `license:` entry and there is no card content. The licence is not merely permissive-unknown, it
  is _entirely unstated_.

Two files, both fetched directly and inspected byte-for-byte via HTTP range requests:

| File                 | Size (bytes) | Actual content                                                        |
| -------------------- | ------------ | --------------------------------------------------------------------- |
| `apple_music.csv`    | 195,940,352  | One `https://music.apple.com/{cc}/song/{id}` URL per line. No header. |
| `apple_music_id.csv` | 33,534,886   | One bare integer per line. No header.                                 |

Verbatim first lines of `apple_music_id.csv`:

> **VERBATIM**
>
> ```
> 1862239894
> 285318221
> 285318225
> 285318268
> ```

Verbatim first lines of `apple_music.csv`:

> **VERBATIM**
>
> ```
> https://music.apple.com/fr/song/1862239894
> https://music.apple.com/us/song/1862239894
> https://music.apple.com/fr/song/1862239894
> https://music.apple.com/us/song/1862239894
> https://music.apple.com/gb/song/285318221
> ```

### Why it is useless to us

**It is a single-column, unkeyed, duplicate-ridden list of Apple Music song ids.** There is no
ISRC column, no MBID column, no artist, no title, no preview URL — no key of any kind. It is not a
mapping. It cannot be joined to anything we hold. The HuggingFace dataset viewer additionally
fails to load it at all, reporting a schema error because the first data row is being parsed as a
header:

> **VERBATIM** (HuggingFace dataset viewer error)
> "All the data files must have the same columns, but at some point there are 1 new columns
> ({'1862239894'}) and 1 missing columns."

The name that surfaced in the prior run — "Apple Music Track ID Lookup" — is misleading. Nothing
in this repository performs a lookup, because there is nothing to look _up from_.

**Verdict: dead end.** Even setting the join problem aside, the licence is unstated, which for a
project that already dropped a vendor over a licence clause is on its own disqualifying.

### The one thing it was good for

It provided ~26,476 distinct real Apple track ids from the first 800 KB, which made it possible to
measure the iTunes `lookup` endpoint's true batching behaviour with real ids rather than
synthetic ones. That measurement is what produced
[the one real win](#the-one-real-win-album-expansion-on-the-endpoint-we-already-use).

### Broader dataset survey

<!-- AGENT_DATASET_SURVEY -->

---

## Thread 2: Apple's ISRC batch lookup

The prior run hit "Get Multiple Catalog Songs by ISRC" in Apple's docs, got back only a page
title, and correctly refused to fabricate the details. The docs HTML is a JavaScript shell and
returns no usable content to a plain fetch — that is why the prior attempt failed. The real
content is served as JSON from `developer.apple.com/tutorials/data/...`, which was fetched
successfully (HTTP 200, 17,075 bytes).

### The real endpoint

> **VERBATIM** (endpoint declaration)
> `GET https://api.music.apple.com/v1/catalog/{storefront}/songs`

> **VERBATIM** (`storefront`, path parameter, required)
> "An iTunes Store territory, specified by an ISO 3166 alpha-2 country code. The possible values
> are the `id` attributes of `Storefront` objects."

> **VERBATIM** (`filter[isrc]`, query parameter, required, type `[string]`)
> "The International Standard Recording Code (ISRC) values for the songs. You can substitute
> `filter[isrc]` for `ids`, or use it in conjunction with `ids` for additional filtering. Note that
> one ISRC value may return more than one song. **The maximum fetch limit is 25.**"

So: **25 ISRCs per request**, and one ISRC may legitimately fan out to several songs (different
editions/territories), which we would have to disambiguate ourselves.

### Does it return preview URLs?

Yes. From the `Songs.Attributes` dictionary (fetched as JSON, HTTP 200):

> **VERBATIM**
> `previews` — required — type `[Preview]` — "The preview assets for the song."

Also present and required: `artwork`, `durationInMillis`, `url`. Also present but **optional**:
`isrc` ("The International Standard Recording Code (ISRC) for the song").

This is the one option in the entire survey that would fix matching accuracy and preview
acquisition simultaneously — ISRC is an exact key, and MusicBrainz ships ISRCs in its CC0 dump, so
we already hold the join column.

### The auth requirement, established plainly

The documented response codes include:

> **VERBATIM**
> `UnauthorizedResponse` — "A response indicating an incorrect `Authorization` header."

Confirmed live, unauthenticated:

```
$ curl -i "https://api.music.apple.com/v1/catalog/us/songs?filter%5Bisrc%5D=GBAYE9100113"
HTTP/2 401
server: daiquiri/5
content-length: 0
```

**HTTP 401, empty body.** The Apple Music API requires a developer token, which is a JWT signed
with a MusicKit private key. MusicKit keys are issued only to members of the **Apple Developer
Program, which costs USD $99/year**. We do not have one.

**This is a paid door onto the same building.** It does not remove the Apple dependency in any
sense — it _is_ Apple, and using it puts us under the Apple Music API terms and the MusicKit
agreement rather than the one-paragraph Search API grant we currently rely on. That is a _larger_
legal surface, not a smaller one, and it would need its own terms review before adoption.

### The related negative that closes off a cheaper idea

Since MusicBrainz gives us ISRCs for free, the obvious question is whether the _unauthenticated_
iTunes endpoints accept an ISRC. **They do not.** Tested live against `itunes.apple.com/lookup`
with real ISRCs taken from MusicBrainz (`USUG11904251` for The Weeknd "Blinding Lights",
`US23A8492092` for Billie Eilish "bad guy"):

| Request                                 | Result           |
| --------------------------------------- | ---------------- |
| `lookup?isrc=USUG11904251`              | `resultCount: 0` |
| `lookup?isrc=USUG11904251&entity=song`  | `resultCount: 0` |
| `lookup?isrc=USUG11904251&country=US`   | `resultCount: 0` |
| `lookup?isrc=USUG11904251,US23A8492092` | `resultCount: 0` |

This is the endpoint's silent-ignore behaviour for unrecognised parameters, not a data miss.
Control tests confirm the endpoint itself was healthy throughout:

| Control                                            | Result                           |
| -------------------------------------------------- | -------------------------------- |
| `lookup` with no parameters                        | `resultCount: 0`                 |
| `lookup?flurb=123` (nonsense parameter)            | `resultCount: 0`                 |
| `lookup?amgArtistId=468749` (documented parameter) | `resultCount: 1`, "Jack Johnson" |

`isrc` behaves exactly like `flurb`. It is not a supported parameter.

Confirming the same from the other direction: the `lookup` response objects contain **no ISRC
field at all** (checked across all 19 track objects of a full album response). The free iTunes
API can neither accept nor emit an ISRC. **ISRC-keyed matching is available only behind the $99/yr
paid API.**

**Verdict: real, works, returns previews, exact ISRC keying — and costs $99/yr, caps at 25 ISRCs
per request, and expands rather than reduces our legal exposure to Apple.** Worth revisiting only
as a deliberate decision to become an Apple developer, never as a way to escape Apple.

---

## Thread 3: Odesli / song.link

The prior run got a 307 redirect to `app.notion.com` and never re-fetched. The document has now
been retrieved in full, by calling Notion's own `POST /api/v3/loadPageChunk` against page id
`d0ebe08a-5e30-4a55-9284-05eb682f6741` (HTTP 200, 125,481 bytes, 60 blocks rendered). This is the
canonical Odesli API documentation that `songlink/docs` on GitHub redirects to.

### It is being switched off in three days

The document now opens with a deprecation banner that did not exist when most third-party
integrations were written:

> **VERBATIM**
> "Deprecation notice — Songlink (Odesli) public API
>
> The entire v1-alpha.1 API namespace is deprecated and will be retired on July 31, 2026. Until
> then, requests are subject to stricter per-IP daily rate limits; over-quota requests return 429
> Too Many Requests. After the sunset date, all v1-alpha.1 endpoints will return 410 Gone.
>
> We have stopped giving out API keys, but those with a legitimate, sustained need for API access
> can request allowlisting via the form in the Help Center article: Sunsetting the Songlink
> (Odesli) public API.
>
> The public song.link / album.link landing pages are not affected by this change."

Today is **2026-07-28**. The API dies on **2026-07-31**. This was corroborated independently by a
third-party migration notice ("Action Required: Songlink API Shutting Down July 31st").

The stricter limits are already live and observable: during this research a plain
`GET https://api.song.link/v1-alpha.1/links?...` returned **HTTP 429** from this workstation's IP
after fewer than 20 total requests in the session.

`v1-alpha.1` is the only version that has ever existed — the docs say so:

> **VERBATIM**
> "This is the main (and right now, only) 😅 endpoint"

So there is no successor namespace to migrate to.

### It has no preview URLs, and cannot be keyed by MBID

Even ignoring the sunset, Odesli fails on the merits. A live call
(`platform=itunes&type=song&id=1679849823&userCountry=US`, HTTP 200) returned matches across nine
platforms — `amazonMusic`, `amazonStore`, `anghami`, `appleMusic`, `boomplay`, `deezer`, `itunes`,
`napster`, `pandora` — and a scan of the entire serialised response for any key or value containing
`preview` returned **zero hits**.

That is consistent with the documented response type, whose per-entity object is exactly:

> **VERBATIM** (from the `Response` flow type)
>
> ```
> id: string,
> type: 'song' | 'album',
> title?: string,
> artistName?: string,
> thumbnailUrl?: string,
> thumbnailWidth?: number,
> thumbnailHeight?: number,
> apiProvider: APIProvider,
> platforms: Platform[],
> ```

**Links and artwork only. No audio of any kind.** Odesli would give us an Apple track id, from
which we would still have to make an Apple call to get the preview — so it never removes the Apple
dependency, it only adds a hop.

And it cannot be keyed by what we hold. Accepted input is a platform URL, or a
`platform` + `type` + `id` triple. MusicBrainz is not a supported platform. The platform list does
include the tokens `isrc` and `upc`, but a live attempt
(`platform=isrc&type=song&id=USUG11904251`) returned:

> **VERBATIM**
> `{"statusCode":400,"code":"could_not_fetch_entity_data"}`

### Terms, rate limits, storage

For completeness, since these were asked for:

> **VERBATIM** (Auth)
> "You do not need any special authentication or authorization for our API. However, if you do
> provide a valid API key you will benefit from higher rate limits and preferred support."

> **VERBATIM** (Rate Limiting)
> "Without an API key, the rate limit is 10 requests per minute."

> **VERBATIM** (Attribution)
> "Please properly attribute your integration with our API by displaying to your users that your
> feature or product is powered by Songlink."

> **VERBATIM** (Terms of Service)
> "Use of our API is governed by our API Terms of Service."

The linked "API Terms of Service" is the only place storage/caching rights would be defined, and
the documentation does not restate them. **This was not chased further**, because the sunset makes
it moot: 10 requests/min against a corpus of millions, for three remaining days, cannot seed
anything. There is also no non-commercial concern to evaluate — the API will not exist.

**Verdict: dead, and would have been useless anyway.** No previews, wrong keys, 10 req/min,
retired 2026-07-31, no successor version, and API keys are no longer being issued.

---

## Thread 4: MusicBrainz's own link data (closing this out properly)

Already ruled out by the prior run; recorded here so it is not re-measured a third time. The prior
run's scan (`rel_scan.py` over a 92,176-release prefix of the MusicBrainz release dump) measured
the **release** level, not just recordings:

| Metric                                    | Value                          |
| ----------------------------------------- | ------------------------------ |
| Releases scanned                          | 92,176                         |
| With any URL relationship                 | 72,261 (78.4%)                 |
| **With an Apple/iTunes URL relationship** | **179 (0.194%)**               |
| Tracks on those releases                  | 2,171 of 1,130,218 (**0.19%**) |

The top link domains are `discogs.com` (58,875), `amazon.com` (27,373), `rateyourmusic.com`
(2,780). `itunes.apple.com` (107) and `music.apple.com` (104) sit below `deezer.com` (111).

MusicBrainz editors simply do not add Apple links. This is dead at both the recording level and
the release level. **Do not re-measure.**

### Wikidata — checked, and also too small

Wikidata is CC0, so if it carried the mapping it would be ideal. It carries property **P10110
"Apple Music track ID"** ("track ID (after ?i=) that represents a track in Apple Music") and
**P4404 "MusicBrainz recording ID"**. Measured live against the Wikidata SPARQL endpoint:

| Query                                       | Count     |
| ------------------------------------------- | --------- |
| Items with P10110 (Apple Music track ID)    | **1,435** |
| Items with P4404 (MusicBrainz recording ID) | 25,675    |
| Items with **both** P10110 and P4404        | **689**   |
| Items with both P10110 and ISRC (P1243)     | 947       |
| Items with P2281 (Apple Music _album_ ID)   | 11,612    |

**689 usable MBID-to-Apple-track-id rows.** Against a catalogue in the millions this is noise —
roughly 45 minutes of ordinary API calls. Also note P10110's format is `albumId?i=trackId`, not a
bare track id, so it needs parsing.

**Verdict: correct shape, correct licence, three orders of magnitude too small.**

---

## Thread 5: other aggregators

Twelve services were checked with live HTTP calls. **Three of them genuinely do what we want
technically — and all three forbid the one thing that would make it useful: persisting the result.**
None of the twelve returns preview audio.

### The three that technically work, and why each is still unusable

| Service     | ISRC → Apple track id?               | Previews?                  | Cost                      | Blocker                                                                    |
| ----------- | ------------------------------------ | -------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| Soundcharts | **Yes, verified live**               | No                         | from $50/mo, no free tier | Terms bar redistribution "free of charge or in consideration of a payment" |
| Chartmetric | Yes (`/api/track/isrc/{id}/get-ids`) | No                         | from **$350/mo**          | Terms name "store" directly                                                |
| SonoVault   | Yes, **and MusicBrainz ids too**     | No (deliberately excluded) | Free tier 1,000/mo        | Terms bar building any music metadata database                             |

**Soundcharts** was verified end to end against their open sandbox
(`x-app-id: soundcharts`, `x-api-key: soundcharts`, no signup):
`GET /api/v2.25/song/by-isrc/{isrc}` → song UUID → `GET /api/v2/song/{uuid}/identifiers`, both
HTTP 200, returning `{"platformName":"Apple Music","identifier":"1692867642", …}`. This is exactly
the shape we wanted. But:

> **VERBATIM** (Soundcharts Terms, Article 5.1, prohibited uses)
> "Copying, modifying, or distributing content, data, information from Soundcharts or from the
> Service, free of charge or in consideration of a payment, without the consent of Soundcharts"

The phrase "free of charge" is doing deliberate work there — it forecloses the "but we're
non-commercial" argument explicitly.

**Chartmetric**'s endpoint shape was confirmed from two independent real client libraries rather
than from memory (the Go client's `TrackIDs` struct carries `isrc` and `itunes_ids`), and the live
API returns `422 {"error":"Token is not valid."}` unauthenticated. Terms:

> **VERBATIM** (Chartmetric Terms, Section 13)
> "You may not: Copy, store, redistribute, or resell any part of the Services"

**SonoVault** is the only one with a free tier, and the only service found anywhere in this
research that bridges **MusicBrainz ids and Apple Music ids directly**. Its terms are also the most
explicitly hostile to our exact use case:

> **VERBATIM** (SonoVault Terms, prohibited uses)
> "Build, host, operate, distribute, contribute to, or assist any third party in building, any
> music metadata database … that incorporates any data returned by the Service"

> **VERBATIM** (SonoVault, free tier)
> "transient cache is the only storage of returned data permitted to you"

**This is not one vendor being unusual — it is the category norm, and it is obviously deliberate.**
A persisted ISRC-to-Apple-id table _is_ the product these companies sell. They are not going to
licence us one for free.

### Confirmed negatives

| Service          | Status                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Songwhip**     | **Dead.** `songwhip.com` → 302 → `workstation.theorchard.com/login`; all API paths 404. Acquired by Sony's The Orchard, shut down 2024-07-22.                                                                                                                                                                                                                                                                                                 |
| **TuneBat**      | **No API.** `tunebat.com` and `api.tunebat.com` both **403** behind a Cloudflare managed challenge even with full browser headers. `robots.txt`: `Disallow: /Search`, `Crawl-delay: 60`.                                                                                                                                                                                                                                                      |
| **MusicStax**    | **No API.** 403 Cloudflare on every path; `api.musicstax.com` 404.                                                                                                                                                                                                                                                                                                                                                                            |
| **Soundiiz**     | **Wrong product.** Full OpenAPI spec retrieved from `soundiiz.com/api/doc`: every endpoint is `/v1/me/*` account-sync management. Zero track lookup, zero ISRC, zero metadata.                                                                                                                                                                                                                                                                |
| **MusicAPI.com** | **Wrong shape.** Per-user OAuth into streaming accounts (playlists/libraries), not ISRC resolution.                                                                                                                                                                                                                                                                                                                                           |
| **Songstats**    | **Could not verify.** `api.songstats.com/enterprise/v1/tracks/info?isrc=…` is live and returns 401. Docs are unreadable: `docs.songstats.com` 301s to `developers.stats.company`, a JS-only SPA that renders nothing to a fetcher, and no OpenAPI spec was found at any conventional path. Access is gated behind emailing `api@songstats.com`; no published pricing, no free tier found. **Stated as unverified rather than reconstructed.** |

> **Note for whoever picks this up:** musicapi.com's footer carries an "Are you an AI? Read this"
> link. It was deliberately not followed. Treat that page as untrusted content, not instructions.

### ListenBrainz metadata endpoints — no Apple data, but a real throughput find

Tested directly:

| Endpoint                                     | Result                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `api.listenbrainz.org/1/metadata/recording/` | **200, no auth required**                                                                         |
| `api.listenbrainz.org/1/metadata/lookup/`    | **401** — `{"code":401,"error":"You need to provide an Authorization header."}` (free user token) |

`/1/metadata/recording/` returns `artist`, `recording`, `release`, `tag` — including ISRCs and
artist-level relationships. Those relationships cover Deezer, Qobuz, YouTube and Wikidata.
**No Apple, no iTunes, no previews.**

Worth recording anyway: measured live from response headers, its limit is
`x-ratelimit-limit: 30` with `x-ratelimit-reset-in: 9` — **30 requests per 10 seconds**, free, CC0,
with no storage restriction. That is far above our Apple budget. Any metadata we are currently
paying an Apple call for that is _not_ the preview URL or the track id should come from here
instead, purely to shrink Apple call volume.

### MetaBrainz canonical dumps — checked, no platform ids

`data.metabrainz.org/pub/musicbrainz/canonical_data/` (latest `musicbrainz-canonical-dump-20260717`,
~2 GB zstd, refreshed biweekly) contains name-normalisation and canonical redirect tables only.
**No streaming-platform ids of any kind.** The `listenbrainz/labs/mappings/` directory holds only
MSID↔MBID mappings, last touched 2020. There is no Apple id anywhere in the MetaBrainz dump
ecosystem.

**Deezer was excluded from this survey by instruction**, having already been dropped over a
revenue clause incompatible with donation funding.

### Addendum to Thread 3: Odesli's API Terms would have barred storage anyway

The Odesli API Terms of Service — the document the API docs point at but do not restate — was
retrieved as a PDF from `odesli.co/api-terms`. It independently disqualifies Odesli even ignoring
the sunset:

> **VERBATIM** (Odesli API Terms, Section 5(e), prohibited uses of returned content)
> "Scrape, build databases, or otherwise create permanent copies of such content;"

> **VERBATIM** (Odesli API Terms, Section 9(b))
> "delete any cached or stored content that was permitted by the cache header under Section 5."

Retention is scoped to cache headers only. A permanently seeded table is precisely what Section 5(e)
names. **So Odesli fails on all four counts independently: no previews, wrong keys, no storage
rights, and retired in three days.**

---

## The one real win: album expansion on the endpoint we already use

This was not what the research set out to find, but it is the only actionable result, and it is
substantial. It requires **no new vendor, no new licence, no new key, and no new legal review** —
it is the same `itunes.apple.com` grant already assessed in
[`apple-itunes-terms-review.md`](./apple-itunes-terms-review.md).

### Finding 1: `lookup` accepts batched ids, capped at ~200

Measured live with real Apple track ids:

| Ids requested | Tracks returned          | With preview | URL length |
| ------------- | ------------------------ | ------------ | ---------- |
| 25            | 12                       | 12           | 298        |
| 50            | 36                       | 36           | 550        |
| 100           | 49                       | 49           | 1,097      |
| 150           | 73                       | 73           | 1,647      |
| 200           | 119                      | 119          | 2,197      |
| 250           | 169                      | 169          | 2,731      |
| 300           | 201                      | 201          | 3,260      |
| 350           | 201                      | 201          | 3,786      |
| 400           | 201                      | 201          | 4,309      |
| 450           | 201                      | 201          | 4,857      |
| 500           | **HTTP 502 Bad Gateway** | —            | —          |

Results plateau hard at **201** regardless of how many ids are requested, and the request fails
outright somewhere between 450 and 500 ids. **Treat ~200 ids per call as the working cap.**

The low return counts at the head of the file are a property of that particular id list, not the
endpoint. Sampling the same 200-id batch size at different offsets:

| Offset | Requested | Returned | Missing                               |
| ------ | --------- | -------- | ------------------------------------- |
| 0      | 200       | 119      | 81 (file head is `gb`-storefront ids) |
| 2,000  | 200       | 188      | 12                                    |
| 8,000  | 200       | 194      | 6                                     |
| 16,000 | 200       | 192      | 8                                     |

So roughly **3–6% of arbitrary Apple ids do not resolve in the default US storefront**.

### Finding 2: every track returned carries a preview URL

Across every measurement in this research — well over 1,000 track objects — the preview rate on
returned tracks was **100%, with zero exceptions**. `previewUrl` was present on 451/451 tracks in
the album-route run and 19/19 on a full-album expansion.

The response also carries everything the Apple licence and our data model need:

| Field                                                                             | Present           |
| --------------------------------------------------------------------------------- | ----------------- |
| `previewUrl`                                                                      | 19/19             |
| `trackViewUrl`                                                                    | 19/19             |
| `collectionViewUrl`                                                               | 19/19             |
| `artworkUrl100`                                                                   | 19/19             |
| `trackId`, `collectionId`, `trackName`, `artistName`, `trackNumber`, `discNumber` | 19/19             |
| any ISRC field                                                                    | **0/19 — absent** |

`trackViewUrl` is the field needed to satisfy Apple licence **condition (ii)** (the store badge
link) flagged as finding **A1/A2** in the Apple terms review. The batched route returns it, so
adopting album expansion does not compromise that fix — it supplies exactly the same field.

### Finding 3: one album id expands to a whole tracklist, and album ids batch too

`lookup?id={collectionId}&entity=song&limit=200` returns the album plus **all of its tracks, each
with a preview URL**. And album ids batch the same way as track ids: five album ids in a single
call returned **74 tracks, 74 with previews**.

### Finding 4: measured end-to-end, the album route is ~10x cheaper

A full run against a real popularity-weighted sample (40 albums drawn from ListenBrainz sitewide
all-time top releases), pacing at 3.2 s between calls to stay well inside the 15/min budget:

| Metric                                   | Value          |
| ---------------------------------------- | -------------- |
| Albums in sample                         | 40             |
| Albums matched on iTunes                 | **38 (95.0%)** |
| `search` calls (1 per album)             | 40             |
| `lookup` calls (batches of 10 album ids) | 4              |
| **Total iTunes API calls**               | **44**         |
| Tracks returned                          | 451            |
| **Tracks with a preview URL**            | **451 (100%)** |
| **Tracks-with-preview per API call**     | **10.25**      |

**10.25 previews per call, against 1.0 for the current per-track route.** At the existing 15/min
budget that is roughly 9,200 previews/hour instead of 900.

This also directly mitigates **A14** in the Apple terms review (403 blocks keyed to egress IP
reputation): the same seeding job becomes about a tenth as many requests, which lowers the
reputational exposure rather than merely staying under a documented ceiling. It is the closest
thing available to the higher-volume path that **A15** records as no longer existing.

### The catch, measured honestly

Album search is not precise about _editions_. Over a 30-album sample, comparing the top result's
normalised album+artist to the query:

| Metric                        | Value             |
| ----------------------------- | ----------------- |
| Top-1 exact edition match     | 21/30 (**70.0%**) |
| Exact match anywhere in top 5 | 22/30 (73.3%)     |

Some "misses" are benign near-misses that still contain the right recordings — `In Utero (20th
Anniversary Edition)`, `Abbey Road (2019 Mix)`, `The Beatles (The White Album)`. Others are
genuinely wrong records:

| Query                                      | Top result returned                                 |
| ------------------------------------------ | --------------------------------------------------- |
| Pink Floyd — The Dark Side of the Moon     | **The Wall**                                        |
| Red Hot Chili Peppers — Californication    | **Greatest Hits**                                   |
| System of a Down — Toxicity                | **The Rough Dog (feat. System of a Down) - Single** |
| Tame Impala — Currents                     | **Currents B-Sides & Remixes - EP**                 |
| Arctic Monkeys — Favourite Worst Nightmare | _(no result at all)_                                |

**This is a throughput optimisation, not a matching strategy, and it must not be used as one.**
The mitigation is straightforward and costs nothing: `lookup` returns `trackName`, `trackNumber`
and `discNumber` for every track, so accept a preview only where the track title matches the
MusicBrainz recording title we were trying to resolve. A wrong album then yields no rows rather
than wrong rows. Fall back to the existing per-track search for anything the album route misses.

**It does not remove the Apple dependency.** Nothing does. It makes the same dependency about ten
times cheaper to exercise.

---

## Recommendation

1. **Close the "find a bulk preview source" question.** It has now been asked twice and answered
   the same way both times. There is no public corpus of Apple preview URLs, no public
   MBID-to-Apple mapping above ~700 rows, and no third-party API that returns preview audio.
   Apple is the only path.
2. **Do not buy the $99/yr Apple Developer Program to get `filter[isrc]`.** It caps at 25 ISRCs per
   request, does not remove the dependency, and moves us onto a broader set of Apple agreements
   that would need their own review. Revisit only if ISRC-exact _matching accuracy_ (not
   throughput) becomes the binding constraint.
3. **Do not build anything on Odesli.** It is retired on 2026-07-31 and has no preview data.
4. **Adopt album expansion for bulk seeding**, gated on track-title verification against the
   MusicBrainz recording, with the existing per-track search as the fallback. Measured ~10x.
5. **Accept the long tail.** Prior measurements stand: ListenBrainz popular head 71.2% (n=368),
   MusicBrainz canonical 84.9% with metadata fallback (n=73), long tail 2.5–9.2% (n=120). No
   source found in this research improves the tail, because the tail is not on Apple at all.

---

## Source retrieval log

All retrieved 2026-07-28. Status codes are as observed.

| Source                                     | URL                                                                                                      | Result                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| HF datasets search API                     | `huggingface.co/api/datasets?search=…`                                                                   | 200                                            |
| HF dataset metadata                        | `huggingface.co/api/datasets/xinyangli/apple_music_id`                                                   | 200                                            |
| HF dataset card page                       | `huggingface.co/datasets/xinyangli/apple_music_id`                                                       | 200, **no card content, no licence**           |
| HF data files                              | `…/resolve/main/apple_music{,_id}.csv`                                                                   | 200, range requests                            |
| Apple ISRC endpoint docs (HTML)            | `developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc`                     | 200 but **JS-only shell, no readable content** |
| Apple ISRC endpoint docs (JSON)            | `developer.apple.com/tutorials/data/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc.json` | 200, 17,075 bytes                              |
| Apple Songs attributes (JSON)              | `…/applemusicapi/songs/attributes-data.dictionary.json`                                                  | 200, 15,185 bytes                              |
| Apple Music API, unauthenticated           | `api.music.apple.com/v1/catalog/us/songs?filter[isrc]=…`                                                 | **401, empty body**                            |
| iTunes `lookup` (batching, ISRC, controls) | `itunes.apple.com/lookup?…`                                                                              | 200 throughout; 502 at 500 ids                 |
| iTunes `search` (album route)              | `itunes.apple.com/search?…&entity=album`                                                                 | 200 throughout                                 |
| Odesli docs redirect stub                  | `raw.githubusercontent.com/songlink/docs/master/api-v1-alpha.1.md`                                       | 200, points to Notion                          |
| Odesli canonical docs                      | Notion `POST /api/v3/loadPageChunk`, page `d0ebe08a…`                                                    | 200, 125,481 bytes                             |
| Odesli live API                            | `api.song.link/v1-alpha.1/links?…`                                                                       | 200, then **429**                              |
| Odesli homepage                            | `odesli.co`                                                                                              | 200, **no API information on the page**        |
| Wikidata property search                   | `wikidata.org/w/api.php?action=wbsearchentities`                                                         | 200                                            |
| Wikidata SPARQL                            | `query.wikidata.org/sparql`                                                                              | 200                                            |
| MusicBrainz WS/2                           | `musicbrainz.org/ws/2/recording?…&inc=isrcs`                                                             | 200                                            |
| ListenBrainz sitewide stats                | `api.listenbrainz.org/1/stats/sitewide/releases`                                                         | 200                                            |

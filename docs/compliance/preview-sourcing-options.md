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
> `8d/e0/bb` is the prefix of `8de0bb10-...`. There is no function from track id to preview URL.

So the question is whether some dataset, API, or service has already collected Apple preview URLs,
or Apple/iTunes track ids, keyed by something we hold (MBID, ISRC, or artist+title), so that we can
seed in bulk rather than learn ~15 rows a minute.

---

## Verdict

**No source removes the Apple dependency. Nothing found anywhere returns preview audio except
Apple itself.** But the honest answer is not a flat negative, because three results change how we
should seed.

### 1. One dataset is a genuine partial win

The **WASABI** corpus carries roughly 700k rows holding both an Apple track id and a MusicBrainz
recording MBID. CC BY-NC 4.0, free, no login, one 2.7 GB download. Its Apple ids have rotted
(measured: **35% still resolve**), leaving about **240k usable MBID to Apple-id rows**. That is a
real cold-start seed. It does not remove the Apple dependency, because preview URLs still have to
be fetched from Apple, but it removes the _search_ step for those rows and it replaces a fuzzy
artist+title match with an exact id.

### 2. Two negatives that would have cost us real work

**Odesli / song.link is switched off on 2026-07-31, three days from now.** It is exactly the kind
of service we would plausibly have integrated: free, no auth, cross-platform track resolution, well
known. Building on it would have produced a shipped integration that broke within the week. Its own
canonical documentation carries the deprecation notice, its API Terms separately forbid persisting
results, and it never returned preview audio in the first place. Four independent disqualifiers,
none of which are visible from the marketing site. See [Thread 3](#thread-3-odesli--songlink).

**The free iTunes API cannot accept or emit an ISRC at all.** This kills the obvious "we already
hold ISRCs from the MusicBrainz CC0 dump, so let us match on those" plan. ISRC keying exists only
behind the authenticated Apple Music API. Measured and controlled, see
[Thread 2](#thread-2-apples-isrc-batch-lookup).

### 3. The Apple Music API is available to us, and we should still not use it

Thread 2 was reopened on the information that the operator holds an Apple Developer Program
membership, which removes the cost objection. The technical answer is good: `filter[isrc]` is real,
takes 25 ISRCs per request, and `previews[].url` is a **documented required field**, so it would fix
matching accuracy and preview retrieval together.

**The licence answer is bad enough to override that.** The Apple Music API is governed by the Apple
Developer Program License Agreement §3.3.6(D), not by the short Search API grant, and it is
**materially more restrictive than the terms we already operate under**. Three clauses cut directly
against our architecture: a purpose limitation to "facilitating access to Your end users' Apple
Music subscriptions" (we have no Apple sign-in and most users have no subscription), an express ban
on indirect monetisation "or otherwise in any way" (we are donation-funded, and this is a closer
analogue to the Deezer clause than anything in the Search API), and a requirement that "full songs
must be enabled for playback" (we are a preview-only player). It also puts the operator's developer
membership at risk where today Apple has no account to terminate. Full analysis with verbatim
clauses in [Apple Music API terms](#apple-music-api-terms-the-important-part).

### 4. The endpoint we already use is about 10x cheaper than the way we are using it

Not what the research went looking for, and the single most actionable result.
`itunes.apple.com/lookup` batches ~200 ids per call and expands a **UPC** or an album id into a
full tracklist, with every returned track carrying a preview URL. **We already hold barcodes for
57% of MusicBrainz releases** in the dump we have. See
[The one real win](#the-one-real-win-batching-and-upc-expansion-on-the-endpoint-we-already-use).

Everything else was checked and failed, for one of three reasons: no preview URLs, not keyed to
anything we hold, or dead / dying / licence-blocked. Notably, **the three services that technically
do solve ISRC to Apple-id (Soundcharts, Chartmetric, SonoVault) each independently forbid storing
the result**, which is the entire value of seeding. That is the category norm rather than one
vendor being awkward: a persisted ISRC-to-Apple-id table is the product they sell.

### Summary table

The final column is the one that matters. "Removes Apple dependency" means we would no longer need
to call Apple at all.

| Option                                   | Has preview URLs?                             | Keyed to MBID / ISRC / artist+title? | Licence / cost                             | Removes Apple dependency?                                      |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| **WASABI corpus**                        | No (its stored Deezer previews are dead)      | **MBID 52%, ISRC 64%, Apple id 37%** | **CC BY-NC 4.0**, free                     | **No**, but seeds ~240k live Apple ids                         |
| **iTunes UPC / album expansion** _(new)_ | **Yes, 100%**                                 | UPC (MusicBrainz barcode), album id  | Same grant we already operate under        | **No**, but ~10x cheaper                                       |
| Apple Music API `filter[isrc]`           | **Yes**, `previews[].url` documented required | ISRC, max 25/request                 | Apple Developer Program (operator has one) | **No.** It _is_ Apple, under a **worse** licence. Do not adopt |
| HF `xinyangli/apple_music_id`            | No                                            | **No, unkeyed bare id list**         | Unstated (no card, no licence)             | **No.** Useless: nothing to join on                            |
| Soundcharts / Chartmetric / SonoVault    | No                                            | **Yes, ISRC to Apple id**            | $50 to $350/mo (SonoVault has a free tier) | **No.** All three **forbid storing results**                   |
| Odesli / song.link                       | **No**                                        | Platform URLs/ids only, not MBID     | Free, 10 req/min                           | **No. Retired 2026-07-31**; terms forbid storage               |
| Kaggle iTunes preview dumps              | **Yes**, and they still resolve (22/22)       | artist+title only, **no ISRC/MBID**  | ODC-By / MIT                               | **No.** ~15k rows, unjoinable                                  |
| Wikidata P10110                          | No                                            | MBID, but only **689 rows**          | CC0                                        | **No.** Too small to matter                                    |
| MusicBrainz url-rels (release level)     | No                                            | MBID                                 | CC0                                        | **No.** 0.194% link rate                                       |
| ListenBrainz `/metadata/recording`       | No                                            | MBID                                 | CC0, 30 req/10s                            | **No Apple data at all**, but useful elsewhere                 |

---

## Thread 1: the HuggingFace dataset lead, and the wider dataset survey

The prior run surfaced a hit reading `apple-music-id-from-metadata` / "Apple Music Track ID
Lookup" and never investigated it. It has now been found and investigated.

### `xinyangli/apple_music_id`: found, and it is not a mapping

- <https://huggingface.co/datasets/xinyangli/apple_music_id>
- Created 2026-06-25, last modified 2026-06-26, 7,775 downloads, 0 likes
- `usedStorage` 229,475,238 bytes
- Tags: `region:us` only
- `gated: false`, `private: false`. No login required, downloads fine
- **No README, no dataset card, no licence field of any kind.** The `tags` array contains no
  `license:` entry and there is no card content. The licence is not merely permissive-unknown, it
  is _entirely unstated_.

Two files, both fetched directly and inspected byte for byte via HTTP range requests:

| File                 | Size (bytes) | Actual content                                                        |
| -------------------- | ------------ | --------------------------------------------------------------------- |
| `apple_music.csv`    | 195,940,352  | One `https://music.apple.com/{cc}/song/{id}` URL per line. No header. |
| `apple_music_id.csv` | 33,534,886   | One bare integer per line. No header.                                 |

> **VERBATIM** (first lines of `apple_music_id.csv`)
>
> ```
> 1862239894
> 285318221
> 285318225
> 285318268
> ```

> **VERBATIM** (first lines of `apple_music.csv`)
>
> ```
> https://music.apple.com/fr/song/1862239894
> https://music.apple.com/us/song/1862239894
> https://music.apple.com/fr/song/1862239894
> https://music.apple.com/us/song/1862239894
> https://music.apple.com/gb/song/285318221
> ```

**It is a single-column, unkeyed, duplicate-ridden list of Apple Music song ids.** No ISRC, no
MBID, no artist, no title, no preview URL. It is not a mapping and cannot be joined to anything we
hold. The HuggingFace dataset viewer additionally fails to load it at all, parsing the first data
row as a header:

> **VERBATIM** (HuggingFace dataset viewer error)
> "All the data files must have the same columns, but at some point there are 1 new columns
> ({'1862239894'}) and 1 missing columns."

The name that surfaced in the prior run, "Apple Music Track ID Lookup", is misleading. Nothing in
this repository performs a lookup, because there is nothing to look _up from_.

**Verdict: dead end.** Even setting the join problem aside, the unstated licence is on its own
disqualifying for a project that has already dropped a vendor over a licence clause.

Its one use: it supplied ~26,476 distinct real Apple track ids, which made it possible to measure
the `lookup` endpoint's true batching behaviour with real ids rather than synthetic ones.

### WASABI Song Corpus: the one real find

<https://zenodo.org/records/5603369> (DOI 10.5281/zenodo.5603369). Verified against the Zenodo API
and by range-reading the archive rather than downloading it whole.

| Property         | Value                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| File             | `wasabi-2-0.tar`, **2,716,805,120 bytes**, containing `json/json.zip` (1.98 GB) |
| `song.json`      | ~12.96 GB uncompressed, ~2.1M song objects                                      |
| **Licence**      | **`cc-by-nc-4.0`** (exact string from the Zenodo API)                           |
| Access           | `access_right: "open"`, **no login**, Zenodo honours HTTP Range                 |
| Publication date | **2020-12-09**, version 2.0                                                     |
| SPARQL endpoint  | `wasabi.inria.fr/sparql` is **dead** (connection refused, verified)             |

Fields it actually carries, confirmed by parsing an 81,440-record sample:

```
urlITunes            = "https://itunes.apple.com/us/album/id{albumId}?i={trackId}"
id_song_musicbrainz  = recording MBID
isrc, id_song_deezer, preview (Deezer 30s mp3), urlSpotify, lastfm_id
```

Measured fill rates over those 81,440 records:

| Field                                              | Non-empty |
| -------------------------------------------------- | --------- |
| `urlITunes`                                        | 37.1%     |
| `isrc`                                             | 63.7%     |
| `id_song_musicbrainz`                              | 52.2%     |
| **Apple track id AND recording MBID both present** | **33.1%** |
| **Apple track id AND ISRC both present**           | **33.6%** |

Extrapolated to ~2.1M songs that is roughly **690k to 710k rows** carrying both an Apple track id
and an MBID.

**The catch, measured rather than assumed.** The dataset is from 2020 and its Apple ids have rotted
badly. 60 random `urlITunes` track ids fed to `itunes.apple.com/lookup`: **21/60 (35%) still
resolve** in the US store, 22/60 in GB. Control, to prove this is age and not the endpoint: 60
track ids from a 2024-vintage dataset resolved 54/60 (90%), and a 200-id batch resolved 189 (94.5%).
The MBIDs by contrast are fine, 10/10 sampled still resolve on MusicBrainz today.

So WASABI realistically yields **~240k current Apple track ids joinable to MBID**, free, in one
download. Note the licence is **non-commercial**, which suits our stated posture but is a
constraint to record: it is not CC0 and it would bind us if the project's funding model ever
changed.

### Other datasets: small, clean, and unjoinable

| Dataset                                                    | Rows                                | Keys                                                      | Preview liveness (measured) | Licence    | Updated    |
| ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------- | --------------------------- | ---------- | ---------- |
| `kanchana1990/apple-music-dataset-10000-tracks-uncovered`  | 10,000 rows, 8,741 unique `trackId` | `trackId`, `previewUrl`, `collectionId`. **No ISRC/MBID** | **12/12 HTTP 206**          | ODC-By     | 2024-02-11 |
| `ashyou09/itunes-music-dataset`                            | 10,514 + 4,915 rows                 | `track_id`, `preview_url`. **No ISRC/MBID**               | **10/10 HTTP 206**          | MIT        | 2026-04-22 |
| `sternritterarrancar/apple-music-dataset-3000-music-track` | 3,933 rows, 2,598 unique `trackId`  | `trackId`, `collectionId`. No previewUrl                  | n/a                         | Apache 2.0 | 2025-06-18 |

All three download without a login (verified). **Preview-URL rot is much lower than feared: 22/22
tested URLs returned HTTP 206, including from a dataset 2.5 years old.** That is a useful datum in
its own right, and it suggests our persisted preview URLs are less fragile than finding A6 in the
Apple terms review assumes. But these datasets are keyed only on artist+title, are ~15k rows total,
and cannot be joined to MBIDs.

### Verified dead ends

- **Zenodo / figshare:** Zenodo API `q=ISRC` returns **2 total hits**, neither music-ID related. No
  Apple/iTunes dataset exists there beyond WASABI.
- **`sourabhy/isrc-dataset`** (Kaggle, 1.17 GB, licence "Unknown"): the zip central directory reads
  `ISRC-data/div_1080/4k-3840-x-2160-wallpapers-themefoxx (1).jpg`. It is **desktop wallpapers**.
  "ISRC" is an institute acronym. Not music.
- **`mattisschulte/isrcs-genre-predictions-spotify-id-mapping`** (783 MB, CC0, 2026-05-12): first
  member inflates to `isrc,genre,score`. ISRC to genre/Spotify only, **no Apple**.
- **GitHub code search** (authenticated API): `audio-ssl.itunes.apple.com extension:csv` returns 38
  hits, all hobby or coursework scrapes of a few hundred rows. `apple_music_id extension:csv`
  returns **1**. `itunes_track_id extension:csv` returns **3**. `isrc previewUrl trackId
extension:csv` returns **0**.
- **HuggingFace:** `search=isrc` returns **0 datasets**. `search=itunes` returns 2, both
  entity-matching benchmarks. `search=apple music` returns ~20, all LLM-training shards.
- **MIR datasets, all verified by real fetch, none carry Apple ids or preview URLs.** Also worth
  recording: **LFM-2b, LFM-1b, Spotify MSSD and Spotify MPD are all withdrawn.**

  > **VERBATIM** (LFM-2b) "The dataset is not available for download anymore due to license issues."

  **Melon** (`arena.kakao.com`) TCP-times-out on :443 and :80. **Music4All** is email-gated and has
  no MBID/ISRC. **MSD** carries only artist-level MBIDs, not recording MBIDs. **AcousticBrainz** is
  recording-MBID-keyed but frozen at 2022-06-23 with an unstated licence, and its `asin` field is
  Amazon, not Apple. **#nowplaying-rs** is unjoinable: its `track_id` values are bare 32-char
  hashes.

---

## Thread 2: Apple's ISRC batch lookup

The prior run hit "Get Multiple Catalog Songs by ISRC" in Apple's docs, got back only a page title,
and correctly refused to fabricate the details. The reason it failed is that the docs HTML is a
JavaScript shell that returns no readable content to a plain fetch. The real content is served as
JSON from `developer.apple.com/tutorials/data/...`, which was fetched successfully (HTTP 200,
17,075 bytes).

**This thread was reopened mid-research** on the information that the operator holds an Apple
Developer Program membership, and that the intended posture is **developer-token-only, server-side
catalog access, with no per-user Apple sign-in and no Music User Token**.

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

So **25 ISRCs per request**, and one ISRC may legitimately fan out to several songs (different
editions or territories), which we would have to disambiguate ourselves.

### Does it return preview URLs? Documented yes, and the field is required

From `Songs.Attributes` (fetched as JSON, HTTP 200):

> **VERBATIM**
> `previews` - required - type `[Preview]` - "The preview assets for the song."

And the `Preview` object itself (fetched as JSON, HTTP 200):

> **VERBATIM**
> `url` - **required** - type `string` - "The preview URL for the content."
> `hlsUrl` - optional - type `string` - "The HLS preview URL for the content."
> `artwork` - optional - type `Artwork` - "The preview artwork for the associated preview music video."

`previews` is a **required** attribute of the catalog `Songs` resource, and `url` is a **required**
member of `Preview`. In Apple's documentation model, required means always present in the response.

### Does developer-token-only auth suffice for catalog data?

Apple's documentation is explicit that the Music User Token is only for subscriber-specific data:

> **VERBATIM** (User Authentication for MusicKit)
> "Apple Music API requires the inclusion of a Music User Token for any requests for data specific
> to an Apple Music subscriber, such as to fetch content from the user's library."

> **VERBATIM** (Generating Developer Tokens)
> "A developer token is used to authorize all Apple Music API requests. If you manage this
> directly, in all requests, pass the `Authorization: Bearer` header set to the developer token."

Catalog songs are not subscriber-specific data. **On the documented contract, a developer token
alone is sufficient and `previews[].url` will be populated.**

**Honest limitation, stated plainly: this was NOT verified empirically.** No MusicKit private key
exists in the operator's 1Password MCP vault (the only Apple item there is a Sign in with Apple
signing key for Cloudflare Access, which is a different service and a different key type). I
therefore could not make a live authenticated call. What _was_ verified live is the unauthenticated
rejection:

```
$ curl -i "https://api.music.apple.com/v1/catalog/us/songs?filter%5Bisrc%5D=GBAYE9100113"
HTTP/2 401
server: daiquiri/5
content-length: 0
```

I deliberately did **not** scrape the public developer token that Apple's own web player embeds in
its JavaScript bundle, which is the usual shortcut for this kind of verification. Borrowing a
credential Apple issued to itself, in the course of writing a compliance document, would be exactly
the wrong thing to do. **The first thing to do with a real key is one `filter[isrc]` call, checking
that `previews[0].url` is present and that the URL returns HTTP 200.** Until then, treat "previews
are populated with developer-token-only auth" as documented and strongly corroborated, not measured.

### Rate limits: Apple states a limit exists and publishes no number

> **VERBATIM** (Generating Developer Tokens, "Request Rate Limiting")
> "Apple Music API limits the number of requests your app can make using a developer token within a
> specific period of time. If this limit is exceeded, you'll temporarily receive `429 Too Many
Requests` error responses for requests that use the token. This error resolves itself shortly
> after the request rate has re[duced]."

**No figure is published anywhere in Apple's documentation.** Any specific number you find in
forums or blog posts is community folklore and should be treated as such. The one concrete
improvement over the Search API is that the failure mode is a clean `429` tied to _the token_,
rather than the Search API's opaque, empty-bodied `403` tied to _egress IP reputation_ (finding A14
in the Apple terms review). That is a materially better operational position even at an unknown
rate: it is attributable, it is self-healing, and it is not poisoned by other tenants sharing our
cloud egress.

### Auth mechanics, practically

| Item           | Requirement                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| Identifier     | A **Media Services identifier (MusicKit)** created in the developer account        |
| Key            | A **MusicKit private key** (`.p8`), downloadable once; note its **Key ID**         |
| Team ID        | From Membership in the developer account sidebar                                   |
| Token          | JWT, **ES256 only**. Header `{alg, kid}`, claims `{iss (Team ID), iat, exp}`       |
| Token lifetime | **Maximum 15,777,000 seconds (6 months)** from current server time                 |
| Smoke test     | `curl -v -H 'Authorization: Bearer [token]' "https://api.music.apple.com/v1/test"` |

> **VERBATIM** (Generating Developer Tokens)
> "Apple Music supports only developer tokens signed with the ES256 algorithm. Apple Music rejects
> unsecured developer tokens or developer tokens signed with other algorithms. These rejections
> result in a `401` error code."

No App Store distribution is required to create a MusicKit identifier or key. The base Apple
Developer Program membership is the gate, and the operator already has it.

### Terms

The Apple Music API is governed by a **different agreement** from the one-paragraph Search API
"Legal" block already audited in
[`apple-itunes-terms-review.md`](./apple-itunes-terms-review.md): the **Apple Developer Program
License Agreement §3.3.6(D)**. That agreement is **materially more restrictive than the grant we
already operate under**, and on the strength of it the recommendation is **not to adopt this API**
even though the account now exists. Full analysis with verbatim clauses in
[Apple Music API terms](#apple-music-api-terms-the-important-part) below.

### A related negative that closes off the cheap version of this idea

Since MusicBrainz gives us ISRCs for free, the obvious question is whether the **unauthenticated**
iTunes endpoints accept an ISRC. **They do not.** Tested live with real ISRCs taken from
MusicBrainz (`USUG11904251` for The Weeknd "Blinding Lights", `US23A8492092` for Billie Eilish "bad
guy"):

| Request                                 | Result           |
| --------------------------------------- | ---------------- |
| `lookup?isrc=USUG11904251`              | `resultCount: 0` |
| `lookup?isrc=USUG11904251&entity=song`  | `resultCount: 0` |
| `lookup?isrc=USUG11904251&country=US`   | `resultCount: 0` |
| `lookup?isrc=USUG11904251,US23A8492092` | `resultCount: 0` |

This is the endpoint's silent-ignore behaviour for unrecognised parameters, not a data miss.
Controls confirm the endpoint was healthy throughout:

| Control                                  | Result                           |
| ---------------------------------------- | -------------------------------- |
| `lookup` with no parameters              | `resultCount: 0`                 |
| `lookup?flurb=123` (nonsense parameter)  | `resultCount: 0`                 |
| `lookup?amgArtistId=468749` (documented) | `resultCount: 1`, "Jack Johnson" |

`isrc` behaves exactly like `flurb`. Confirming from the other direction, `lookup` responses contain
**no ISRC field at all** (checked across all 19 track objects of a full album response).

**The free iTunes API can neither accept nor emit an ISRC. ISRC-keyed matching exists only behind
the authenticated Apple Music API.**

---

## Thread 3: Odesli / song.link

The prior run got a 307 redirect to `app.notion.com` and never re-fetched. The document has now
been retrieved in full, by calling Notion's own `POST /api/v3/loadPageChunk` against page id
`d0ebe08a-5e30-4a55-9284-05eb682f6741` (HTTP 200, 125,481 bytes, 60 blocks rendered). This is the
canonical Odesli API documentation that `songlink/docs` on GitHub redirects to.

### It is being switched off in three days

> **VERBATIM** (deprecation banner at the head of the Odesli API documentation)
> "Deprecation notice - Songlink (Odesli) public API
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

Today is **2026-07-28**. The API dies on **2026-07-31**. Corroborated independently by a
third-party migration notice ("Action Required: Songlink API Shutting Down July 31st").

The stricter limits are already live and observable: during this research a plain
`GET https://api.song.link/v1-alpha.1/links?...` returned **HTTP 429** from this workstation after
fewer than 20 requests in the session.

There is no successor namespace to migrate to. `v1-alpha.1` is the only version that has ever
existed:

> **VERBATIM** "This is the main (and right now, only) 😅 endpoint"

### It has no preview URLs, and cannot be keyed by MBID

Ignoring the sunset entirely, Odesli still fails on the merits. A live call
(`platform=itunes&type=song&id=1679849823&userCountry=US`, HTTP 200) returned matches across nine
platforms (`amazonMusic`, `amazonStore`, `anghami`, `appleMusic`, `boomplay`, `deezer`, `itunes`,
`napster`, `pandora`), and a scan of the entire serialised response for any key or value containing
`preview` returned **zero hits**. That matches the documented response type, whose per-entity object
is exactly:

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

**Links and artwork only. No audio of any kind.** Odesli would hand us an Apple track id, from
which we would still have to call Apple for the preview. It never removes the Apple dependency, it
only adds a hop.

Nor can it be keyed by what we hold. Accepted input is a platform URL, or a `platform` + `type` +
`id` triple. MusicBrainz is not a supported platform. The platform list does include the tokens
`isrc` and `upc`, but a live attempt (`platform=isrc&type=song&id=USUG11904251`) returned:

> **VERBATIM** `{"statusCode":400,"code":"could_not_fetch_entity_data"}`

### Its terms would have barred storage anyway

The Odesli API Terms of Service, the document the API docs point at but do not restate, was
retrieved as a PDF from `odesli.co/api-terms`:

> **VERBATIM** (Odesli API Terms, Section 5(e), prohibited uses of returned content)
> "Scrape, build databases, or otherwise create permanent copies of such content;"

> **VERBATIM** (Odesli API Terms, Section 9(b))
> "delete any cached or stored content that was permitted by the cache header under Section 5."

Retention is scoped to cache headers only. A permanently seeded table is precisely what Section 5(e)
names.

Documented limits, for completeness:

> **VERBATIM** (Rate Limiting) "Without an API key, the rate limit is 10 requests per minute."

> **VERBATIM** (Auth) "You do not need any special authentication or authorization for our API.
> However, if you do provide a valid API key you will benefit from higher rate limits and preferred
> support."

**Verdict: fails on four independent grounds.** No previews, wrong keys, no storage rights, and
retired in three days. **Do not build anything on it.** Worth flagging to anyone who has seen it
recommended, because none of these four facts are visible from the product's marketing surface.

---

## Thread 4: MusicBrainz's own link data

Already ruled out by the prior run; recorded here so it is not measured a third time. The prior
run's scan (`rel_scan.py` over a 92,176-release prefix of the MusicBrainz release dump) measured
the **release** level, not just recordings:

| Metric                                    | Value                          |
| ----------------------------------------- | ------------------------------ |
| Releases scanned                          | 92,176                         |
| With any URL relationship                 | 72,261 (78.4%)                 |
| **With an Apple/iTunes URL relationship** | **179 (0.194%)**               |
| **With a barcode**                        | **52,604 (57.1%)**             |
| Tracks on Apple-linked releases           | 2,171 of 1,130,218 (**0.19%**) |

Top link domains are `discogs.com` (58,875), `amazon.com` (27,373), `rateyourmusic.com` (2,780).
`itunes.apple.com` (107) and `music.apple.com` (104) sit below `deezer.com` (111). An independent
check on random official Digital Media releases measured **3/75 (4%)** carrying an `apple.com` URL
rel, and **0/25** at recording level.

MusicBrainz editors simply do not add Apple links. **Dead at both the recording and release level.
Do not re-measure.**

**But note the barcode row.** 57.1% of releases in that same dump carry a barcode, and that is the
key that makes [the UPC route](#the-one-real-win-batching-and-upc-expansion-on-the-endpoint-we-already-use)
work. The most useful thing in MusicBrainz for this problem was never the Apple links.

### Wikidata: checked, correct shape, three orders of magnitude too small

Wikidata is CC0, so if it carried the mapping it would be ideal. It has **P10110 "Apple Music track
ID"** and **P4404 "MusicBrainz recording ID"**. Measured live against the Wikidata SPARQL endpoint:

| Query                                       | Count     |
| ------------------------------------------- | --------- |
| Items with P10110 (Apple Music track ID)    | **1,435** |
| Items with P4404 (MusicBrainz recording ID) | 25,675    |
| Items with **both** P10110 and P4404        | **689**   |
| Items with both P10110 and ISRC (P1243)     | 947       |
| Items with P2281 (Apple Music _album_ ID)   | 11,612    |

**689 usable rows**, roughly 45 minutes of ordinary API calls. Also note P10110's format is
`albumId?i=trackId`, not a bare track id, so it needs parsing.

---

## Thread 5: commercial aggregators

Twelve services checked with live HTTP calls. **Three genuinely do what we want technically, and
all three forbid persisting the result.** None returns preview audio.

### The three that work, and why each is still unusable

| Service     | ISRC to Apple track id?             | Previews?                  | Cost                      | Blocker                                                               |
| ----------- | ----------------------------------- | -------------------------- | ------------------------- | --------------------------------------------------------------------- |
| Soundcharts | **Yes, verified live**              | No                         | from $50/mo, no free tier | Bars redistribution "free of charge or in consideration of a payment" |
| Chartmetric | Yes, `/api/track/isrc/{id}/get-ids` | No                         | from **$350/mo**          | Terms name "store" directly                                           |
| SonoVault   | Yes, **and MusicBrainz ids too**    | No (deliberately excluded) | Free tier 1,000/mo        | Bars building any music metadata database                             |

**Soundcharts** was verified end to end against their open sandbox (`x-app-id: soundcharts`,
`x-api-key: soundcharts`, no signup): `GET /api/v2.25/song/by-isrc/{isrc}` returns a song UUID, then
`GET /api/v2/song/{uuid}/identifiers` returns
`{"platformName":"Apple Music","identifier":"1692867642", ...}`. Both HTTP 200. Exactly the shape
we wanted.

> **VERBATIM** (Soundcharts Terms, Article 5.1, prohibited uses)
> "Copying, modifying, or distributing content, data, information from Soundcharts or from the
> Service, free of charge or in consideration of a payment, without the consent of Soundcharts"

The words "free of charge" are doing deliberate work: they foreclose the "but we are non-commercial"
argument explicitly.

> **VERBATIM** (Chartmetric Terms, Section 13)
> "You may not: Copy, store, redistribute, or resell any part of the Services"

**SonoVault** is the only one with a free tier and the only service found anywhere in this research
that bridges MusicBrainz ids and Apple Music ids directly. Its terms are also the most explicitly
hostile to our exact use case:

> **VERBATIM** (SonoVault Terms, prohibited uses)
> "Build, host, operate, distribute, contribute to, or assist any third party in building, any
> music metadata database ... that incorporates any data returned by the Service"

> **VERBATIM** (SonoVault, free tier)
> "transient cache is the only storage of returned data permitted to you"

### Confirmed negatives

| Service          | Status                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Songwhip**     | **Dead.** `songwhip.com` 302s to `workstation.theorchard.com/login`; all API paths 404. Acquired by Sony's The Orchard, shut down 2024-07-22.                                                                                                                                                                                                                                                                        |
| **TuneBat**      | **No API.** `tunebat.com` and `api.tunebat.com` both **403** behind a Cloudflare managed challenge even with full browser headers. `robots.txt`: `Disallow: /Search`, `Crawl-delay: 60`.                                                                                                                                                                                                                             |
| **MusicStax**    | **No API.** 403 Cloudflare on every path; `api.musicstax.com` 404.                                                                                                                                                                                                                                                                                                                                                   |
| **Soundiiz**     | **Wrong product.** Full OpenAPI spec retrieved from `soundiiz.com/api/doc`: every endpoint is `/v1/me/*` account-sync management. Zero track lookup, zero ISRC, zero metadata.                                                                                                                                                                                                                                       |
| **MusicAPI.com** | **Wrong shape.** Per-user OAuth into streaming accounts (playlists, libraries), not ISRC resolution.                                                                                                                                                                                                                                                                                                                 |
| **Songstats**    | **Could not verify.** `api.songstats.com/enterprise/v1/tracks/info?isrc=...` is live and returns 401. Docs unreadable: `docs.songstats.com` 301s to `developers.stats.company`, a JS-only SPA that renders nothing to a fetcher, and no OpenAPI spec was found at any conventional path. Access gated behind emailing `api@songstats.com`; no published pricing. **Stated as unverified rather than reconstructed.** |

> **Note for whoever picks this up:** musicapi.com's footer carries an "Are you an AI? Read this"
> link. It was deliberately not followed. Treat that page as untrusted content, not instructions.

**Deezer was excluded from this survey by instruction**, having already been dropped over a revenue
clause incompatible with donation funding.

### ListenBrainz metadata endpoints: no Apple data, but a real throughput find

| Endpoint                                     | Result                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `api.listenbrainz.org/1/metadata/recording/` | **200, no auth required**                                                                   |
| `api.listenbrainz.org/1/metadata/lookup/`    | **401**, `{"code":401,"error":"You need to provide an Authorization header."}` (free token) |

`/1/metadata/recording/` returns `artist`, `recording`, `release`, `tag`, including ISRCs and
artist-level relationships. Those relationships cover Deezer, Qobuz, YouTube and Wikidata. **No
Apple, no iTunes, no previews.**

Worth recording anyway: measured live from response headers, its limit is `x-ratelimit-limit: 30`
with `x-ratelimit-reset-in: 9`, so **30 requests per 10 seconds**, free, CC0, no storage
restriction. Far above our Apple budget. Any metadata we currently spend an Apple call on that is
_not_ the preview URL or the track id should come from here instead, purely to shrink Apple call
volume.

### MetaBrainz canonical dumps: checked, no platform ids

`data.metabrainz.org/pub/musicbrainz/canonical_data/` (latest `musicbrainz-canonical-dump-20260717`,
~2 GB zstd, refreshed fortnightly, **CC0 per its own COPYING file**) contains name-normalisation and
canonical redirect tables only: `recording_mbid` plus `combined_lookup`. **No ISRC and no Apple
ids.** The `listenbrainz/labs/mappings/` directory holds only MSID to MBID mappings, last touched 2020. There is no Apple id anywhere in the MetaBrainz dump ecosystem.

---

## The one real win: batching and UPC expansion on the endpoint we already use

Not what the research set out to find, and the only broadly actionable result. It requires **no new
vendor, no new licence, no new key and no new legal review**: it is the same `itunes.apple.com`
grant already assessed in [`apple-itunes-terms-review.md`](./apple-itunes-terms-review.md).

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
| 500           | **HTTP 502 Bad Gateway** | -            | -          |

Results plateau hard at **201** regardless of how many ids are requested, and the request fails
outright between 450 and 500 ids. **Treat ~200 ids per call as the working cap.**

The low counts at the head of that particular id list are a property of the list, not the endpoint.
Sampling the same batch size at different offsets:

| Offset | Requested | Returned | Missing                               |
| ------ | --------- | -------- | ------------------------------------- |
| 0      | 200       | 119      | 81 (file head is `gb`-storefront ids) |
| 2,000  | 200       | 188      | 12                                    |
| 8,000  | 200       | 194      | 6                                     |
| 16,000 | 200       | 192      | 8                                     |

So roughly **3 to 6% of arbitrary Apple ids do not resolve in the default US storefront.**

### Finding 2: every track returned carries a preview URL

Across every measurement in this research, well over 1,500 track objects, the preview rate on
returned tracks was **100%, with zero exceptions**. The response also carries everything the Apple
licence and our data model need:

| Field                                                                             | Present          |
| --------------------------------------------------------------------------------- | ---------------- |
| `previewUrl`                                                                      | 19/19            |
| `trackViewUrl`                                                                    | 19/19            |
| `collectionViewUrl`                                                               | 19/19            |
| `artworkUrl100`                                                                   | 19/19            |
| `trackId`, `collectionId`, `trackName`, `artistName`, `trackNumber`, `discNumber` | 19/19            |
| any ISRC field                                                                    | **0/19, absent** |

`trackViewUrl` is the field needed to satisfy Apple licence **condition (ii)** (the store badge
link) flagged as findings **A1/A2** in the Apple terms review. The batched route returns it, so
adopting batching does not compromise that fix.

### Finding 3: UPC expansion, keyed on data we already hold

`lookup?upc={barcode}&entity=song&limit=200` returns the album plus **all of its tracks, each with a
preview URL**. **57.1% of MusicBrainz releases in our dump carry a barcode** (52,604 of 92,176,
measured above), so this key is already in hand.

Measured against 25 real MusicBrainz barcodes drawn from the ListenBrainz popular head:

| Metric                                      | Value            |
| ------------------------------------------- | ---------------- |
| MusicBrainz releases with a barcode, tested | 25               |
| Matched an iTunes collection                | **16 (64.0%)**   |
| Tracks returned                             | 1,010            |
| **Tracks with a preview URL**               | **1,010 (100%)** |
| **Tracks with preview per API call**        | **40.4**         |

**40 previews per call.** The UPC is an exact key, so unlike album-name search there is no
wrong-record risk: a barcode either matches Apple's catalogue or it does not.

Two caveats, both measured. First, Apple often resolves a barcode to a **larger edition** than the
MusicBrainz release: `Nevermind` returned 227 tracks against MusicBrainz's 12, `Metallica` 244
against 12, `In Utero` 187 against 12. That is not a defect for our purpose (more previews, all
valid) but it means row counts will not line up with MusicBrainz track counts. Second, 9/25
barcodes returned nothing at all, typically regional CD pressings whose barcode Apple never carried.

### Finding 4: album-name search as the fallback, at about 10x

Where no barcode exists, searching by artist and album name still beats per-track search. Measured
over 40 albums from the ListenBrainz all-time top releases, pacing 3.2 s between calls:

| Metric                               | Value          |
| ------------------------------------ | -------------- |
| Albums in sample                     | 40             |
| Albums matched on iTunes             | **38 (95.0%)** |
| `search` calls (1 per album)         | 40             |
| `lookup` calls (batches of 10)       | 4              |
| **Total iTunes API calls**           | **44**         |
| Tracks returned                      | 451            |
| **Tracks with a preview URL**        | **451 (100%)** |
| **Tracks with preview per API call** | **10.25**      |

**10.25 previews per call against 1.0 for the current per-track route.**

**The catch, measured honestly.** Album-name search is not precise about editions. Over a 30-album
sample, comparing the top result's normalised album and artist to the query:

| Metric                        | Value             |
| ----------------------------- | ----------------- |
| Top-1 exact edition match     | 21/30 (**70.0%**) |
| Exact match anywhere in top 5 | 22/30 (73.3%)     |

Some misses are benign and still contain the right recordings (`In Utero (20th Anniversary
Edition)`, `Abbey Road (2019 Mix)`, `The Beatles (The White Album)`). Others are genuinely wrong:

| Query                                     | Top result returned                                 |
| ----------------------------------------- | --------------------------------------------------- |
| Pink Floyd, The Dark Side of the Moon     | **The Wall**                                        |
| Red Hot Chili Peppers, Californication    | **Greatest Hits**                                   |
| System of a Down, Toxicity                | **The Rough Dog (feat. System of a Down) - Single** |
| Tame Impala, Currents                     | **Currents B-Sides & Remixes - EP**                 |
| Arctic Monkeys, Favourite Worst Nightmare | _(no result at all)_                                |

**This is a throughput optimisation, not a matching strategy, and must not be used as one.** The
mitigation costs nothing: `lookup` returns `trackName`, `trackNumber` and `discNumber` for every
track, so accept a preview only where the track title matches the MusicBrainz recording title being
resolved. A wrong album then yields no rows rather than wrong rows.

### An unverified claim worth re-testing before relying on it

One measurement during this research reported 90 sequential `lookup` calls in 12 seconds (7.5 req/s)
with 90 HTTP 200s and no throttling, suggesting `lookup` is not rate-limited the way `search` is.
**Treat this as unconfirmed and do not design around it.** Apple's documented rejection path for the
Search API family is an opaque 403 keyed to **egress IP reputation** with a delayed onset (finding
A14), so a short clean burst is weak evidence of a sustained allowance. The safe reading is that
batching reduces the number of calls we need, which is valuable _regardless_ of the ceiling, and is
the right reason to adopt it.

### What this does and does not do

**It does not remove the Apple dependency. Nothing in this document does.** It makes the same
dependency roughly 10x (barcode route: up to 40x) cheaper to exercise, and it directly mitigates
A14 by cutting request volume by an order of magnitude rather than merely staying under a documented
ceiling. It is the closest thing available to the higher-volume path that finding **A15** records as
no longer existing.

---

## Apple Music API terms: the important part

**Headline: the Apple Music API licence is materially WORSE for Pull.fm than the public Search API
grant we already operate under. Adopting it would be a bad trade.** It is technically the better
API and legally the worse one.

### Which agreement actually governs

There is no separate "Apple Music API" agreement. The binding contract is the **Apple Developer
Program License Agreement (PDLA)**, section **3.3.6(D) "MusicKit"**.

Established by enumeration rather than assumption: `developer.apple.com/support/terms/` (HTTP 200)
lists only four English agreements (PDLA, Enterprise PDLA, Apple Developer Agreement, Forums
Agreement). No Apple Music or MusicKit-specific agreement exists. The PDLA English PDF (HTTP 200,
1,053,364 bytes, version marker **`LYL251` / June 18, 2026**) contains **zero** occurrences of the
literal string "Apple Music API"; the bridge is Apple's own Identity Guidelines §6.2:

> **VERBATIM** (Apple Music Identity Guidelines §6.2) "The Apple Music API is now part of MusicKit."

The PDLA incorporates by reference the **Apple Music Identity Guidelines**, the **Program
Requirements** and the **Documentation**. Apple Media Services Terms are the _consumer_ agreement
and do not apply to us.

All quotes below were re-verified directly against the downloaded PDLA text (MusicKit clause at
lines 1873 to 1904), not taken on trust.

### The purpose limitation, which a no-sign-in service structurally cannot satisfy

> **VERBATIM** (PDLA §3.3.6(D), opening paragraph)
> "You agree not to call the MusicKit APIs or use MusicKit JS (or otherwise attempt to gain
> information through the MusicKit APIs or MusicKit JS) for purposes unrelated to facilitating
> access to Your end users' Apple Music subscriptions. If You access the MusicKit APIs or MusicKit
> JS, then You must follow the Apple Music Identity Guidelines. You agree not to require payment for
> or indirectly monetize access to the Apple Music service (e.g. in-app purchase, advertising,
> requesting user info) through Your use of the MusicKit APIs, MusicKit JS, or otherwise in any way."

Read that first sentence against our intended posture. We would use a single developer credential,
server-side, with **no Apple sign-in and no Music User Token**, to serve preview URLs to users the
overwhelming majority of whom have **no Apple Music subscription at all**. That is not "facilitating
access to Your end users' Apple Music subscriptions." On its face it is the prohibited case, and
there is no catalog-only exemption anywhere in the PDLA.

Apple's MusicKit product page does describe unauthenticated catalog access as a supported mode
("The Apple Music API gives you full access to the Apple Music catalog... **With user
authorization, you can go further**"). That is a _product_ statement about what the API can do. It
is not a licence grant and it does not override §3.3.6(D).

### The monetisation clause, which is a closer analogue to Deezer's than anything in the Search API

The second half of that same paragraph is an express ban on indirect monetisation, closing with
**"or otherwise in any way."** Recall that the Search API grant, per the existing terms review,
contains **no revenue restriction of any kind** and was therefore compatible with donation funding.
The MusicKit clause is not silent in the same way.

**The PDLA is silent on donations specifically.** It neither permits nor forbids them by name. But
the enumerated examples (in-app purchase, advertising, requesting user info) are all _indirect_,
non-price forms of value extraction, which suggests the clause is meant to be read broadly rather
than narrowly as "do not charge admission." Given that this project already dropped Deezer over a
clause barring receipt of money related to the service, **this clause deserves the same treatment,
not a more optimistic reading because we would prefer the outcome.**

### The clause that rules out our actual product

> **VERBATIM** (PDLA §3.3.6(D), first bullet)
> "If You choose to offer music playback through the MusicKit APIs or MusicKit JS, full songs must
> be enabled for playback, and users must initiate playback and be able to navigate playback using
> standard media controls such as "play," "pause," and "skip", and You agree to not misrepresent the
> functionality of these controls;"

**Pull.fm is a 30-second-preview player. This says full songs must be enabled.** MusicKit's model is
authenticated full-song playback for subscribers, not preview snippets for anonymous visitors. Our
entire product shape is the thing this bullet is written against.

### Storage rights: silent, and the silence is not comfort

There is **no MusicKit caching, retention or deletion clause in the PDLA**. That is notable because
Apple demonstrably writes them when it means them:

| Clause                    | API                            | Language                                                            |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Attachment 6 §2.5         | Apple Maps                     | explicit no-cache plus mandatory deletion                           |
| Attachment 8 (WeatherKit) | Weather                        | "not be cached, pre-fetched, or stored"                             |
| §3.3.6(F)(iv)             | Apple Music **Feed** API       | "streamed only, and not downloaded, saved, cached, or synchronized" |
| **§3.3.6(D)**             | **MusicKit / Apple Music API** | **no caching clause at all**                                        |

But two other bullets bear on it:

> **VERBATIM** (PDLA §3.3.6(D), second bullet)
> "You may not, and You may not permit Your end users to, download, upload, or modify any MusicKit
> Content and MusicKit Content cannot be synchronized with any other content, unless otherwise
> permitted by Apple in the Documentation;"

> **VERBATIM** (PDLA §3.3.6(D), third bullet)
> "You may play MusicKit Content only as rendered by the MusicKit APIs or MusicKit JS and only as
> permitted in the Documentation (e.g., album art and music-related text from the MusicKit API may
> not be used separately from music playback or managing playlists);"

"MusicKit Content" is defined as "music, video, and/or graphical content rendered through the
MusicKit APIs", so persisting the audio or artwork _bytes_ is prohibited outright. A preview URL
string and text metadata are arguably not "Content" and so arguably storable, but serving that URL
from our own table months later, decoupled from any live MusicKit response, sits badly against
"only as rendered by the MusicKit APIs."

**Apple has been asked this precise question in public and has not answered it.** Apple Developer
Forums thread 774891 asks verbatim whether it "would be allowed under Apple's policy to cache
responses from the Catalog API (`/v1/catalog/*`) via our proxy server to avoid hitting the rate
limit." **Zero replies.** That is the state of the art: the one thing that makes seeding worth doing
is unaddressed, and Apple declines to address it.

### Attribution

**There is no Search-API-style condition (ii) for MusicKit.** The badge-proximity requirement and
the "independent entertainment value" limitation exist in the PDLA only in **§3.3.6(F), the Apple
Music _Feed_ API**, which is a different API. For MusicKit the obligation is by reference to the
Identity Guidelines, and it runs badge-to-link rather than content-to-badge:

> **VERBATIM** (Apple Music Identity Guidelines §5, "Apple Music Links")
> "You must provide a link to Apple Music wherever a badge or lockup is used online. You can link to
> any song, video, album, artist, or page on Apple Music."

Plus a "Listen on Apple Music" badge when linking to songs/albums/artists/playlists (§1.2), one
badge only, placed below or right of the promoted content and not dominant (§1.3), and a credit
line (§9.2): "Apple and Apple Music are trademarks of Apple Inc., registered in the U.S. and other
countries".

So on attribution alone MusicKit is _looser_ than the Search API. That is the one axis where it
wins, and it is not enough to outweigh the rest.

### Redistribution, and the enforcement lever

> **VERBATIM** (PDLA §2.6, "No Other Permitted Uses")
> "Except as otherwise set forth in this Agreement, You agree not to rent, lease, lend, upload to or
> host on any website or server, sell, redistribute, or sublicense the Apple Software, Apple
> Certificates, or any Services, in whole or in part, or to enable others to do so. You may not use
> the Apple Software, Apple Certificates, or any Services provided hereunder for any purpose not
> expressly permitted by this Agreement..."

Proxying Apple Music API results to third parties is at minimum arguable redistribution of a
"Service".

**And the risk profile changes shape entirely.** Today Apple has no account to terminate; the worst
case is a 403 on an anonymous endpoint. Under the PDLA, a compliance dispute puts **the operator's
Apple Developer Program membership itself** at risk, which is a personal asset attached to a real
identity and unrelated projects.

### Rate limits: undocumented, same as the Search API

Apple publishes a rate-limit _section_ containing no number:

> **VERBATIM** (Generating Developer Tokens, "Request Rate Limiting")
> "Apple Music API limits the number of requests your app can make using a developer token within a
> specific period of time. If this limit is exceeded, you'll temporarily receive `429 Too Many
Requests` error responses for requests that use the token. This error resolves itself shortly
> after the request rate has reduced."

That is the entire published text. Confirmed: the limit is scoped **per developer token** (not per
IP), it surfaces as **429**, and **no number, window, burst allowance or `Retry-After` /
`X-RateLimit-*` header is documented anywhere**. Developers have asked repeatedly (Forums threads
699396 and 774891) and received no Apple answer. **Any figure you have heard is folklore.** Apple
publishes concrete numbers for other APIs, such as the App Store Server API; it has chosen not to
here.

> **A caution recorded deliberately.** During this research an automated web search returned a
> summary claiming a developer had "confirmed" that catalog-only preview use complies with the
> terms. The underlying sources were fetched and **contain no such confirmation**; the summary
> appears to have echoed the framing of the query that produced it. The nearest real thread (Forums 721116) concerns the MusicKit Swift framework needing `MusicAuthorization.request()` to obtain a
> country code, which is framework behaviour and not a licence statement. **Do not treat it as a
> green light.** This is exactly the failure mode this project has been bitten by before.

### Side by side

| Axis                  | Search API (current)                                 | Apple Music API via MusicKit                                           |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Governing document    | short "Legal" block on the performance-partners page | **PDLA §3.3.6(D)**, a full contract                                    |
| Auth                  | none                                                 | developer JWT, MusicKit private key                                    |
| Purpose limitation    | promotional use, badge-proximate                     | **"facilitating access to Your end users' Apple Music subscriptions"** |
| Monetisation          | **silent, no revenue restriction at all**            | **express ban, "or otherwise in any way"**                             |
| Preview-only playback | the entire point of the grant                        | **"full songs must be enabled for playback"**                          |
| Storage / caching     | condition-style limits, already analysed             | **silent**, and Apple declines to clarify                              |
| Badge required        | **yes, condition (ii)**                              | only if you use a badge, then you must link                            |
| Rate limit            | undocumented                                         | undocumented                                                           |
| Enforcement lever     | none, we have no account                             | **the operator's Developer Program membership**                        |

**Conclusion, stated plainly as requested: the terms are more restrictive than the public Search API
we are already using.** Three independent clauses cut against our exact architecture: the purpose
limitation (no subscriber access to facilitate), the monetisation ban (donation funding), and the
full-song playback requirement (we are preview-only). Solving cold start by adopting this licence
would trade a permissive, account-less grant for a restrictive contract that our product shape does
not fit, with the operator's developer membership as the collateral. **Do not do it.**

---

## Recommendation

1. **Close the "find a bulk preview source" question.** Asked twice, answered the same way both
   times. No public corpus of Apple preview URLs, no public MBID-to-Apple mapping of usable size
   outside WASABI, and no third-party API that returns preview audio at all. Apple is the only
   source of the asset.
2. **Do not build anything on Odesli.** Retired 2026-07-31, no previews, no storage rights, wrong
   keys. Flag this to anyone who has seen it recommended.
3. **Do not pay Soundcharts, Chartmetric or SonoVault.** All three forbid storing the output, which
   is the only thing that would make them worth buying.
4. **Adopt batching now.** It is free, needs no new licence, and is the single highest-leverage
   change available:
   - `lookup?upc={MusicBrainz barcode}&entity=song` where a barcode exists (57% of releases),
     measured 40.4 previews per call;
   - album-name search plus batched `lookup` otherwise, measured 10.25 per call;
   - per-track `search` only for the residue;
   - in all cases gate acceptance on the track title matching the MusicBrainz recording title.
5. **Seed from WASABI as a one-off.** ~240k live MBID-to-Apple-id rows for one 2.7 GB download.
   Validate ids 200 at a time and discard the ~65% that have rotted. Record the **CC BY-NC 4.0**
   licence in `UPSTREAM-TERMS.md`; it is compatible with the current posture but it is a real
   constraint if funding ever changes.
6. **Do not adopt the Apple Music API, despite now having the account for it.** The technical fit is
   good and the licence fit is bad, and the licence decides it. It is governed by PDLA §3.3.6(D),
   which is more restrictive than the Search API grant on the three axes that matter to us
   (subscriber-purpose limitation, indirect-monetisation ban, full-song playback requirement), and
   it stakes the operator's Developer Program membership on the outcome. It is also worse on raw
   throughput: 25 ISRCs per request against the 200-id `lookup` batch we already have for free.

   If it is ever revisited, two things must happen first: (a) the empirical check that could not be
   done here, one `filter[isrc]` call with a real developer token confirming `previews[0].url` is
   present and resolves; and (b) a decision, taken deliberately rather than by omission, on whether
   donation funding survives "indirectly monetize... or otherwise in any way". That is the same
   question that ended the Deezer evaluation, and it should get the same answer discipline.

7. **Accept the long tail.** Prior measurements stand: ListenBrainz popular head 71.2% (n=368),
   MusicBrainz canonical 84.9% with metadata fallback (n=73), long tail 2.5 to 9.2% (n=120). Nothing
   found here improves the tail, because the tail is not on Apple at all.

---

## Source retrieval log

All retrieved 2026-07-28. Status codes as observed.

| Source                                          | URL                                                                                  | Result                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| HF datasets search API                          | `huggingface.co/api/datasets?search=...`                                             | 200                                            |
| HF dataset metadata                             | `huggingface.co/api/datasets/xinyangli/apple_music_id`                               | 200                                            |
| HF dataset card page                            | `huggingface.co/datasets/xinyangli/apple_music_id`                                   | 200, **no card content, no licence**           |
| HF data files                                   | `.../resolve/main/apple_music{,_id}.csv`                                             | 200, range requests                            |
| WASABI record                                   | `zenodo.org/api/records/5603369`                                                     | 200, licence `cc-by-nc-4.0`                    |
| WASABI archive                                  | `zenodo.org/records/5603369` (`wasabi-2-0.tar`)                                      | 200, range-read, not fully downloaded          |
| WASABI SPARQL                                   | `wasabi.inria.fr/sparql`                                                             | **connection refused**                         |
| Apple ISRC endpoint docs (HTML)                 | `developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc` | 200 but **JS-only shell, no readable content** |
| Apple ISRC endpoint docs (JSON)                 | `developer.apple.com/tutorials/data/.../get-multiple-catalog-songs-by-isrc.json`     | 200, 17,075 bytes                              |
| Apple `Songs.Attributes` (JSON)                 | `.../applemusicapi/songs/attributes-data.dictionary.json`                            | 200, 15,185 bytes                              |
| Apple `Preview` object (JSON)                   | `.../applemusicapi/preview.json`                                                     | 200                                            |
| Apple developer-token docs (JSON)               | `.../applemusicapi/generating-developer-tokens.json`                                 | 200, 16,703 bytes                              |
| Apple user-auth docs (JSON)                     | `.../applemusicapi/user-authentication-for-musickit.json`                            | 200                                            |
| Apple Music API, unauthenticated                | `api.music.apple.com/v1/catalog/us/songs?filter[isrc]=...`                           | **401, empty body**                            |
| iTunes `lookup` (batching, ISRC, UPC, controls) | `itunes.apple.com/lookup?...`                                                        | 200 throughout; 502 at 500 ids                 |
| iTunes `search` (album route)                   | `itunes.apple.com/search?...&entity=album`                                           | 200 throughout                                 |
| Odesli docs redirect stub                       | `raw.githubusercontent.com/songlink/docs/master/api-v1-alpha.1.md`                   | 200, points to Notion                          |
| Odesli canonical docs                           | Notion `POST /api/v3/loadPageChunk`, page `d0ebe08a...`                              | 200, 125,481 bytes                             |
| Odesli API Terms                                | `odesli.co/api-terms` (PDF)                                                          | 200                                            |
| Odesli live API                                 | `api.song.link/v1-alpha.1/links?...`                                                 | 200, then **429**                              |
| Odesli homepage                                 | `odesli.co`                                                                          | 200, **no API information on the page**        |
| Soundcharts sandbox                             | `customer.soundcharts.com/api/v2.25/song/by-isrc/...`                                | 200                                            |
| Chartmetric API                                 | `api.chartmetric.com`                                                                | 422, token invalid (shape confirmed)           |
| SonoVault API                                   | `api.sonovault.now/v1/tracks/isrc/...`                                               | 401, missing API key                           |
| Songstats API                                   | `api.songstats.com/enterprise/v1/tracks/info?isrc=...`                               | 401; **docs unreadable, JS-only SPA**          |
| TuneBat / MusicStax                             | `tunebat.com`, `musicstax.com`                                                       | **403 Cloudflare challenge**                   |
| Songwhip                                        | `songwhip.com`                                                                       | **302 to The Orchard login; service dead**     |
| Wikidata property search / SPARQL               | `wikidata.org/w/api.php`, `query.wikidata.org/sparql`                                | 200                                            |
| MusicBrainz WS/2                                | `musicbrainz.org/ws/2/...`                                                           | 200                                            |
| ListenBrainz metadata + stats                   | `api.listenbrainz.org/1/metadata/recording/`, `/1/stats/sitewide/releases`           | 200; `/metadata/lookup/` **401**               |
| MetaBrainz canonical dumps                      | `data.metabrainz.org/pub/musicbrainz/canonical_data/`                                | 200                                            |

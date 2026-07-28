# Upstream provider terms and viability

**Audited 2026-07-28.** Every claim here was verified against a live API call or the provider's
own published terms on that date, not from memory. Re-audit before launch and quarterly after.

This document exists because **the binding constraints on this product are legal and
rate-limit-shaped, not technical.** The infrastructure can serve 50,000 users long before the
upstream licences permit it.

---

## Summary

| Provider       | Technical status       | Commercial use            | Hard limit          | Verdict                   |
| -------------- | ---------------------- | ------------------------- | ------------------- | ------------------------- |
| ListenBrainz   | ALIVE                  | Supporter tier if revenue | 30 req / 10s        | **Primary pillar**        |
| MusicBrainz    | ALIVE                  | Contact for commercial    | **1 req/s global**  | Mirror required at scale  |
| Last.fm        | ALIVE                  | **Non-commercial only**   | Undocumented (~5/s) | **At risk, see L1**       |
| iTunes Search  | ALIVE                  | Promotional use only      | **~20 calls/min**   | **At risk, see L2**       |
| Deezer         | ALIVE                  | **Non-commercial only**   | ~50 req / 5s        | **At risk, see L3**       |
| ReccoBeats     | ALIVE                  | Unstated                  | Undocumented        | Cache-behind only         |
| AcousticBrainz | **DEAD** (frozen 2022) | CC0                       | n/a                 | Dumps only, never runtime |
| Spotify        | **DEAD** for discovery | n/a                       | n/a                 | Not usable as backend     |

---

## Blocking legal issues

These are unresolved and gate the commercial model. They are tracked as **Gate L**.

### L1. Last.fm is non-commercial-only with a 100 MB cache cap

Terms of Service [clauses 3.1-3.2](https://www.last.fm/api/tos) restrict use to non-commercial
purposes; commercial use requires prior written agreement via `partners@last.fm`. Violation is
defined as _"a material breach"_ permitting immediate termination.

Clause 4.3.4 imposes a **100 MB "Reasonable Usage Cap"** on cached Last.fm data without written
consent. A similarity graph over a real catalogue exceeds 100 MB immediately.

Clauses 2.7 and 4.2.2 require specific attribution formats and an approved badge.

**Consequence:** if Pull.fm takes affiliate revenue on purchase links, the Last.fm layer is in
material breach. **Action:** email `partners@last.fm` for commercial terms before building on it.
**Mitigation if refused:** ListenBrainz `/1/lb-radio/artist/{mbid}` plus
`labs.api.listenbrainz.org/similar-artists` replace the similarity role.

_Note: Last.fm went independent from Paramount Skydance in May 2026. Accounts and API preserved;
no shutdown announced._

### L2. Apple's iTunes preview terms arguably exclude this app's core use

[Apple's terms](https://performance-partners.apple.com/search-api) permit previews _"only to
promote store content and not for entertainment purposes"_, require content not be used for
_"independent entertainment value apart from its promotional purpose"_, and require previews be
_"streamed only, and not downloaded, saved, cached, or synchronized"_.

A discovery app whose users audition previews to decide what they like is plausibly
"independent entertainment value". This is a takedown risk, not a technical one.

The no-caching clause **independently forbids** downloading previews to run local audio-feature
extraction.

**Rate limit:** _"approximately 20 calls per minute"_ - one call per 3 seconds, **per IP**. This
makes iTunes unusable for interactive search; it is viable only for on-demand preview resolution
of an already-identified track, behind a persistent cache.

**Preview asset:** genuinely hotlinkable. `audio-ssl.itunes.apple.com/...m4a`, unsigned, no
expiry, `accept-ranges: bytes`. Plays in an `<audio>` tag.

### L3. Deezer is explicitly non-commercial, and preview URLs expire

[Terms section IV](https://developers.deezer.com/termsofuse), verbatim: _"The Developer agrees
that the use of the Services is strictly limited for a non-commercial purpose and in a
non-commercial environment."_ Developers may not receive revenue related to the service.

**Preview URLs are signed and time-limited** (`?hdnea=exp=...~hmac=...`). Unlike Apple's, they
**cannot be cached**. The track object must be re-fetched immediately before playback, or the
URL 403s. This invalidates any design that stores a Deezer preview URL in the crosswalk.

---

## Provider detail

### ListenBrainz - the strongest pillar

Per-user token, `Authorization: Token <token>`. Observed limit: `x-ratelimit-limit: 30` per 10s.

Working recommendation endpoints (verified 200):

```
GET /1/cf/recommendation/user/{name}/recording   # collaborative-filtered MBIDs + scores
GET /1/user/{name}/playlists/createdfor          # Weekly Jams / Weekly Discovery
GET /1/lb-radio/artist/{artist_mbid}             # similar artists -> recordings
GET /1/stats/user/{name}/artists
```

The CF model is actively regenerated (observed model dated three days before audit). This is a
live pipeline, not an abandoned one.

**Gotchas:**

- `/1/similar-artists` and `/1/similar-recordings` do **not** exist on `api.listenbrainz.org`.
  Similarity lives on `labs.api.listenbrainz.org` and requires an exact `algorithm` enum string.
  `labs.*` is an experimental tier with **no SLA** - best-effort only.
- `/1/explore/lb-radio` (prompt-based) returns 500: _"currently disabled due to high load"_.
- `/1/popularity/top-recordings-for-artist/{mbid}` returns 500.

Build on `/1/cf/recommendation/*` and `/1/lb-radio/artist/{mbid}`; treat the rest as optional.

### MusicBrainz - 1 req/s is a global ceiling

Confirmed: _"that rate is (on average) 1 request per second"_ - **per IP, not per user**. That
caps the entire service at ~86,400 lookups/day.

`User-Agent` is mandatory and must identify the app and a contact:
`PullFM/0.1.0 (ope@312.dev)`. Generic agents are throttled harder.

**At scale a local mirror via the Live Data Feed is required**, which itself requires choosing a
MetaBrainz supporter account tier. This contradicts the original plan's claim that no data-layer
change is needed between 10k and 50k users.

### ReccoBeats - works, but unaccountable

Keyless, returns exactly Spotify's deprecated `audio-features` schema. Verified live.

**Two-call sequence required:** `/v1/track?ids=<spotify_id>` returns a ReccoBeats UUID;
`/v1/track/{uuid}/audio-features` needs _that_ UUID. Passing a Spotify ID returns 404.

Anonymous operator ("LatteBit"), undocumented rate limits, no SLA, no status page, no revenue
model. **Judgment, not vendor claim:** this is a convenience layer, not infrastructure. Usable
only behind a persistent local cache so that its disappearance degrades rather than breaks us.

### AcousticBrainz - dead, do not depend on at runtime

Data collection stopped 2022; last update 2022-07-06. MetaBrainz's own assessment: _"the data
simply isn't of high enough quality to be useful for much at all"_ - unreliable key and BPM,
poor genre/mood classifiers, and **no confidence values**.

The API still returns 200 today, and CC0 dumps remain downloadable (29.4M submissions). But
MetaBrainz announced intent to shut the site in early 2023; that deadline is over three years
overdue. **It runs on goodwill.**

**Policy: mirror the dumps locally now while they exist. Never call the API at runtime.**

### Spotify - not usable as a metadata backend

Removed for all new apps as of 2024-11-27: audio-features, audio-analysis, recommendations,
related-artists, featured playlists, preview URLs in multi-get.

The **February 2026 changelog removed 16 more endpoints**, including every batch multi-get
(`/tracks`, `/artists`, `/albums`), `/artists/{id}/top-tracks`, and all `/browse/*`. Search
`limit` was cut from 50 to 10.

Spotify is now viable only as a playback/library surface for a signed-in user, not as a catalogue.

_Caveat: the Feb 2026 removals were read from the changelog, not confirmed with a live
authenticated token. Verify before designing around them._

---

## Audio features: no clean answer exists

There is no successor to AcousticBrainz and no replacement for Spotify's audio-features.

| Source               | Cost                 | Problem                                         |
| -------------------- | -------------------- | ----------------------------------------------- |
| Self-hosted Essentia | free (AGPL)          | **needs audio we are not licensed to download** |
| AcousticBrainz dumps | free (CC0)           | frozen 2022, self-declared low quality          |
| ReccoBeats           | free                 | anonymous operator, no SLA                      |
| Musicstax            | paid, by application | not self-serve                                  |
| TuneBat              | n/a                  | **no official public API**                      |

**Essentia licensing splits in a way that matters:** the C++ library and classic extractors
(tempo, key, loudness, danceability) are AGPL-3.0 and commercially usable with source
disclosure. The MTG **pretrained models** (arousal/valence, mood, genre) are **CC BY-NC-SA 4.0 -
non-commercial**. So `energy` and `valence` specifically require a UPF licence negotiation.

**The blocking problem:** Essentia needs audio files, and both preview sources forbid
downloading. Running feature extraction over scraped previews violates Apple's and Deezer's
terms regardless of Essentia's licence.

**Recommended architecture:**

```
1. Local Postgres feature table keyed on recording MBID   <- source of truth
2. Backfill from AcousticBrainz dumps (offline, flagged low-confidence)
3. Fill gaps from ReccoBeats, cached permanently on first fetch
4. Essentia only for audio we are legally entitled to process
5. Never call a third party on the hot path
```

# MetaBrainz terms review: ListenBrainz and MusicBrainz

**Reviewed 2026-07-28** against the live published pages on that date, plus the ListenBrainz
server source at `metabrainz/listenbrainz-server@master` where the live page could not be read
(see [Source retrieval log](#source-retrieval-log) - two pages could not be read and are
disclosed rather than reconstructed).

**This is not legal advice.** It is the operator's reading of published terms. Clause and page
content move; re-audit before launch and quarterly after.

**Convention used throughout:** text inside a blockquote marked **VERBATIM** is copied exactly
from the cited source. Everything else is the reviewer's paraphrase or judgement and is labelled
as such. Where a source is silent, this document says it is silent rather than filling the gap.

---

## The headline

Both projects are MetaBrainz Foundation properties and the terms are unusually permissive - far
more so than Last.fm, Deezer, Apple or SeatGeek. **There is no MetaBrainz analogue of SeatGeek
clause 7.13.** No MetaBrainz, MusicBrainz or ListenBrainz document reviewed contains any
prohibition on systematic storage, on exposing material to a search engine or directory, or on
feeding it to an AI or machine-learning application or model. For core data the published
position is the opposite:

> **VERBATIM** (musicbrainz.org/doc/About/Data_License): "The core data of the database is
> licensed under the CC0, which is effectively placing the data into the Public Domain. This
> means that anyone can download and use the core data in any way they see fit. No restrictions,
> no worries!"

Against that backdrop there is exactly **one** real problem in the current implementation, and it
is a self-inflicted one: `packages/upstream/src/musicbrainz/client.ts` requests `inc=tags`, which
pulls MusicBrainz **supplementary** data. Supplementary data is not CC0. It is CC BY-NC-SA 3.0,
and it drags attribution, NonCommercial and ShareAlike obligations onto everything downstream of
it. Nothing in the repository consumes those tags today. Deleting `inc=tags` returns the entire
MusicBrainz surface to pure CC0 and removes three obligations at once. That is the cheapest
compliance win available and it should be taken before there are users.

---

## Findings, prioritised

| #   | Finding                                                                         | Severity          | Status            |
| --- | ------------------------------------------------------------------------------- | ----------------- | ----------------- |
| F1  | `inc=tags` pulls CC BY-NC-SA 3.0 data into a CC0-only design                    | **P0**            | Needs changing    |
| F2  | No MusicBrainz attribution is emitted in the response envelope                  | **P0** (given F1) | Needs changing    |
| F3  | ListenBrainz rate limit is hard-coded, not header-driven                        | **P1**            | Needs changing    |
| F4  | `legal/attribution.md` section 6 is wrong about MetaBrainz                      | **P1**            | Needs changing    |
| F5  | A MusicBrainz mirror would be CC BY-NC-SA, not CC0                              | **P1**            | Design decision   |
| F6  | LB and MB responses are not actually cached yet                                 | **P1**            | Needs changing    |
| F7  | Non-commercial status holds today but the tier test is not purely revenue-based | **P2**            | Ask MetaBrainz    |
| F8  | MusicBrainz User-Agent format deviates from the suggested form                  | **P3**            | Acceptable, noted |
| F9  | ListenBrainz terms are defined by five external documents that can change       | **P2**            | Process change    |
| F10 | Cover Art Archive is a separate, unaudited provider                             | **P2**            | Watch item        |

### Already compliant - do not change these

| Area                                                | Why it is compliant                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MusicBrainz 1 req/s process-wide limiter            | Matches the published per-IP rule exactly. See [Q5](#q5-rate-limits). The 10,000-concurrent-request test is the right evidence to have kept.                                                  |
| Descriptive User-Agent, enforced at construction    | `USER_AGENT_RE` refusing to build a client without one satisfies the stated purpose of the requirement. See [F8](#f8-user-agent-format) for a cosmetic deviation.                             |
| Per-user ListenBrainz tokens                        | Each user supplies their own credential. Pull.fm acts as the user's agent, never as a bulk consumer of other people's data. This is what makes [Q4](#q4-the-personal-api-token-feature) easy. |
| No mirror, no bulk download, no dumps at runtime    | Keeps Pull.fm entirely outside the Live Data Feed licence, which is the stricter one. See [F5](#f5-a-mirror-is-not-cc0).                                                                      |
| Permanent MBID crosswalk                            | Explicitly permitted. MBIDs, artist names, recording and release titles are all core CC0 data. See [Q2](#q2-caching-and-storage).                                                             |
| No affiliate, subscription, ad or data-sale revenue | This is the single fact that keeps the non-commercial reading defensible. See [Q1](#q1-non-commercial-status).                                                                                |
| No cover art                                        | Verified by grep: nothing in `packages/upstream/src` or `apps/bff/src` touches cover art. Keeps the Cover Art Archive out of scope. See [F10](#f10-cover-art-archive).                        |

---

## Answers to the seven questions

### Q1. Non-commercial status

**Short answer: it holds today, but the test MetaBrainz publishes is not the test you would
expect, and the LLC is not what puts it at risk.**

MetaBrainz applies a revenue test, not an entity-type test:

> **VERBATIM** (metabrainz.org/supporters/account-type): "If you are a company with a current
> revenue stream or an expected revenue stream, please select a support tier below."

> **VERBATIM** (same page): "If you are a non-profit with more than 10 employees/contractors, or
> a pre-revenue start-up and expect to have revenue in the future, please sign up with a
> commercial account."

Pull.fm has no current revenue stream. The load-bearing question is the second clause: does
312.dev LLC **expect** revenue from Pull.fm in the future? `docs/PLAN.md` section 1a records
non-commercial as a locked decision and `legal/attribution.md` section 8 enforces it in three
places. **Reviewer's judgement: on the published revenue test, Pull.fm is non-commercial.** Being
an LLC is not disqualifying; the page says nothing about legal form.

The complication is that the free tiers are described by activity, not revenue, and two of them
almost fit while neither fits cleanly:

> **VERBATIM** (tier descriptions, metabrainz.org/supporters/account-type):
>
> - Non-commercial - $0.00/month and up - "Personal or university assignment user."
> - Non-profit Organizations - $0.00/month and up - "For universities and non-profits conducting
>   research, or authors of open-source software using our data."
> - Stealth Start-Up - $0.00/month and up - "For start-ups that are in early stealth mode, and
>   are not publicly offering their services."
> - Bronze - $100.00/month and up - "For popular mobile apps and for small to mid-size start-ups
>   with public products."

Pull.fm is an Apache-2.0 open-source project, which matches the _description_ of the free
Non-profit tier ("authors of open-source software using our data") but not its _name_ - 312.dev
is an LLC, not a non-profit. Meanwhile Bronze is described by product visibility ("popular mobile
apps... with public products"), not by revenue. A public GitHub-released app with users could be
read into Bronze by someone applying the tier descriptions literally rather than applying the
revenue test. **This is the ambiguity to put to MetaBrainz directly** - see
[Questions to ask MetaBrainz](#questions-to-ask-metabrainz).

**Is a supporter account required?** Not for what Pull.fm does today.

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_API, General FAQ): "Non-commercial use of this
> web service is free; please see our commercial plans or contact us if you would like to use
> this service commercially."

> **VERBATIM** (same page): "Do I need an API key? Currently, no. But you must have a meaningful
> user-agent string."

**The threshold at which one becomes required**, as best the reviewer can read it, is one of:

1. Revenue, current or expected, appears. Then a paid commercial tier is required.
2. The Live Data Feed or database dumps are used - i.e. the mirror. Then an access token is
   required even for free non-commercial use:
   > **VERBATIM** (musicbrainz.org/doc/Live_Data_Feed): "Non-commercial / personal users may sign
   > up and obtain a free access token for Live Data Feed"

Note what this means for the roadmap: **the mirror, not the user count, is what forces the
MetaBrainz signup.** `docs/UPSTREAM-TERMS.md` already flags the mirror as required at scale; this
is the administrative consequence of that, and it is free at the non-commercial tier.

### Q2. Caching and storage

**Short answer: retain whatever you like, indefinitely, provided it is core data. The permanent
MBID crosswalk is fine. `inc=tags` is not, and it is the only thing on this page that is not.**

MusicBrainz splits its database in two:

> **VERBATIM** (musicbrainz.org/doc/About/Data_License): "The core data of the database is
> licensed under the CC0, which is effectively placing the data into the Public Domain. This
> means that anyone can download and use the core data in any way they see fit. No restrictions,
> no worries!"

> **VERBATIM** (same page, "Supplementary data"): "The remaining portions of the database are
> released under the Creative Commons Attribution-NonCommercial-ShareAlike 3.0 license. This
> allows for non-commercial use of the data as long as MusicBrainz is given credit and that
> derivative works (works based on the CC licensed data) are also made available under the same
> license."

The split itself:

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_Database), core data: "Areas, Artists, Events,
> Genres, Instruments, Labels, Mediums, Places, Recordings, Release Groups, Releases, Series,
> Works, Relationships & URLs, CD Stubs"

> **VERBATIM** (same page): "Supplementary data includes: user submitted annotations, tags
> (including genre associations) and ratings, derived statistics, search indexes, edit history,
> non-personal user data"

Mapping that onto the fields Pull.fm actually requests
(`packages/upstream/src/musicbrainz/client.ts`):

| Call                    | `inc`                  | Fields parsed                                     | Licence                    | Verdict            |
| ----------------------- | ---------------------- | ------------------------------------------------- | -------------------------- | ------------------ |
| `GET /artist/{mbid}`    | `tags`                 | `name`, `sort-name`, `country`, `life-span.begin` | CC0                        | Fine               |
| `GET /artist/{mbid}`    | `tags`                 | **`tags[].name`**                                 | **CC BY-NC-SA 3.0**        | **F1 - see below** |
| `GET /recording/{mbid}` | `artist-credits`       | `title`, `length`, `artist-credit`                | CC0                        | Fine               |
| `GET /release/{mbid}`   | `artist-credits+media` | `title`, `date`, `country`, `media[].track-count` | CC0                        | Fine               |
| `GET /artist?query=`    | -                      | search hits                                       | CC0 entities, but see note | Fine in practice   |
| `GET /recording?query=` | -                      | search hits                                       | CC0 entities, but see note | Fine in practice   |

_Note on search:_ "search indexes" are listed as supplementary. The reviewer reads that as
covering the index artefact itself, not the CC0 entities returned through it - Pull.fm stores the
resulting MBID and name, not the index. Low risk, but it is an inference, not a quoted rule.

#### F1. `inc=tags` pulls CC BY-NC-SA 3.0 data into a CC0-only design

**Severity: P0. This is the most consequential finding in the review.**

`client.ts:224` sends `query: { fmt: "json", inc: "tags" }` and `parseArtist` (`client.ts:102`)
extracts `tags[].name` onto `MusicBrainzArtist.tags`. Tags are named in the verbatim
supplementary list above. Three obligations attach the moment that data is retained or served:

1. **BY** - MusicBrainz must be credited wherever it or a derivative appears. Currently it is
   not; see [F2](#f2-no-musicbrainz-attribution-is-emitted).
2. **NC** - non-commercial only. Core CC0 data would survive a future decision to monetise;
   anything downstream of tags would not. This quietly converts a reversible business decision
   into an irreversible one.
3. **SA** - derivative works must be released under the same licence. If tags ever feed the
   discovery ranking, the ranking is arguably an adaptation, and serving it through the personal
   API token is distribution of that adaptation. See [Q4](#q4-the-personal-api-token-feature).

**Nothing consumes these tags.** Grepping `packages/discovery/src` and `apps/bff/src` for `.tags`
returns no consumer. The field is fetched, parsed, and dropped.

**Recommendation: delete `inc=tags` and the `tags` field from `MusicBrainzArtist`.** It costs
nothing today, it removes all three obligations, and it keeps the entire MusicBrainz surface CC0

- which is the assumption the rest of the architecture is already built on. If genre or tag data
  is wanted later, take that as a deliberate decision with the BY-NC-SA consequences written down,
  not as a leftover `inc` parameter.

#### The permanent crosswalk is fine

`mbid_crosswalk` stores `entity_type`, `normalized_key` (a lowercased, unaccented artist or
recording name), `mbid`, `confidence`, `source`. Every one of those is either core CC0 data or
Pull.fm's own computation. CC0 is a rights waiver, not a licence with conditions, so there is no
term to breach by retaining it forever and no expiry to honour. **Permanent retention of the
crosswalk is explicitly within "use the core data in any way they see fit".**

`upstream_cache` is the same analysis, with one caveat: the `musicbrainz` rows will contain the
raw payload including tags for as long as `inc=tags` survives. Fixing F1 fixes the cache too.

There is **no** MusicBrainz or MetaBrainz cache cap, TTL requirement, or freshness obligation
anywhere in the reviewed sources. This is a genuine and notable contrast with Last.fm's 100 MB
cap in `docs/UPSTREAM-TERMS.md` L1 - do not let the Last.fm reflex propagate to MusicBrainz.
The only related guidance is operational, not contractual:

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting, "Checking for changes",
> paraphrasing the section heading): applications should "have your application make calls at
> random intervals throughout the day" and should not poll repeatedly for metadata changes.

**Design consequence:** a synchronised cron-style cache warm cycle is contrary to that guidance.
Jitter any scheduled MusicBrainz work.

### Q3. Attribution

**Short answer: for MusicBrainz, attribution is legally required only because of `inc=tags`. Fix
F1 and it becomes courtesy. For ListenBrainz, no attribution clause exists at all. Neither
imposes anything like SeatGeek's logo requirement.**

There is **no** MetaBrainz brand, logo, badge, or trademark requirement in any reviewed source.
Nothing resembling SeatGeek clause 3.1 exists. A text credit is sufficient; there is no asset to
obtain and no "every instance must link" rule.

#### F2. No MusicBrainz attribution is emitted

**Severity: P0 while F1 stands; P3 after F1 is fixed.**

`legal/attribution.md` check MB-2 asserts that a credit reading "Metadata from MusicBrainz" is
required. The code does not produce one. `packages/discovery/src/blend.ts` defines
`LISTENBRAINZ_ATTRIBUTION` (line 48) and `lastfmAttribution()` (line 58) and emits them
throughout; there is **no `MUSICBRAINZ_ATTRIBUTION` constant anywhere in the repository**, and
`collectAttribution()` can therefore never return one - even though `blend.ts:176` shows
MusicBrainz hydration is part of the blend.

Last.fm, Deezer, iTunes and SeatGeek each have an attribution constant. MusicBrainz is the only
provider with a documented obligation and no code to discharge it.

Note the doc and the code are wrong in _opposite_ directions, which is why this needs a decision
rather than a patch:

- `legal/attribution.md` MB-2 overstates the obligation for CC0 core data. **CC0 requires no
  attribution.** If Pull.fm used only core data, "Metadata from MusicBrainz" would be a courtesy.
- The code understates it for the tags actually being fetched, which **do** require credit.

**Two coherent end states. Pick one:**

**Option A (recommended) - drop `inc=tags`, keep the credit as courtesy.** No legal attribution
obligation to MusicBrainz at all. Retain "Metadata from MusicBrainz" anyway, and relabel MB-2 in
`legal/attribution.md` as courtesy rather than obligation, the way section 6 already does for
ListenBrainz.

**Option B - keep tags, implement BY-NC-SA properly.** Then the following is what a UI engineer
must build, and it is materially more than a footer:

| #   | Requirement                                                                                                                    | Source                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | A visible credit naming **MusicBrainz** in any view rendering tag or genre data, or anything derived from it.                  | CC BY-NC-SA 3.0 §4(c), attribution                          |
| 2   | The credit links to `https://musicbrainz.org`. A homepage link suffices - unlike Last.fm, no per-entity URL form is specified. | Reviewer's reading; no per-entity form is mandated anywhere |
| 3   | A statement of the licence, or a URI to it: `https://creativecommons.org/licenses/by-nc-sa/3.0/`.                              | CC BY-NC-SA 3.0 §4(c) - this is the part everyone forgets   |
| 4   | If the rendered output is an adaptation of the tag data, it must be identified as such and offered under the same licence.     | CC BY-NC-SA 3.0 §4(b), ShareAlike                           |

Requirement 3 is the one that makes Option B expensive: a bare "Metadata from MusicBrainz" string
does **not** satisfy CC BY-NC-SA. The licence URI has to be reachable from the same surface.

#### ListenBrainz attribution

None is required. `legal/attribution.md` section 6 correctly records the credit
("Recommendations powered by ListenBrainz") as courtesy - though its stated _reason_ is wrong;
see [F4](#f4-legalattributionmd-section-6-is-wrong-about-metabrainz). Note the code
(`blend.ts:50`) uses **"Recommendations by ListenBrainz"** while `legal/attribution.md` section 6
says **"Recommendations powered by ListenBrainz"**. Harmless, since neither is compelled, but
they should match so a reviewer does not go looking for which one is the licence-mandated string.

**MBID linking (MB-3 in `legal/attribution.md`)** - linking displayed MBIDs to
`https://musicbrainz.org/<entity>/<mbid>` is good practice and good citizenship. It is not
required by any reviewed source. Keep it; label it correctly.

### Q4. The personal API token feature

**This is the question you flagged as most important, so it gets the longest answer. Short answer:
there is no MetaBrainz clause comparable to SeatGeek 7.13, and the feature is permissible. The
only constraint on it is `inc=tags`, which is a second independent reason to delete that
parameter.**

#### Is there a SeatGeek 7.13 analogue?

**No.** The reviewer searched every source listed in the retrieval log for language restricting
systematic storage, search engines, directories, indexing, AI, machine learning, or model
training. **None of the five MetaBrainz documents that constitute the ListenBrainz terms, nor the
MusicBrainz API, rate limiting, data licence or database pages, contains any such restriction.**
For core data the published position is the direct opposite ("No restrictions, no worries!").

This is a genuine structural difference from SeatGeek and it should be recorded as such: the
constraint that shaped SG-7 in `legal/attribution.md` has **no MetaBrainz counterpart**. Do not
let SG-7's design pressure propagate to the MetaBrainz surface by analogy.

#### Redistribution and sublicensing, layer by layer

**ListenBrainz-derived data - no exposure.** The recommendations are computed from the user's own
listening history, fetched with the user's own token, and returned to that same user. No reviewed
document restricts what a user or their agent may do with their own data. The social contract
addresses charging, not access:

> **VERBATIM** (metabrainz.org/social-contract): "We won't object to commercial use of our
> content, companies can use the work of our volunteers without any charge, but charging for the
> content itself is forbidden."

The personal API token is free to the user, so even the one prohibition in the social contract is
not engaged. **Reviewer's judgement: serving a user their own ListenBrainz-derived
recommendations is not redistribution, and there is no sublicensing chain to break.**

**MusicBrainz core data - no exposure.** CC0 is a waiver of rights, not a licence grant with
downstream conditions. There is no sublicensing problem because there is nothing to sublicense:
redistribution of CC0 material through the personal API token is unconditionally permitted, in
any volume, to anyone, with or without attribution.

**MusicBrainz tags - the only exposure, and it is real.** Serving tag data, or rankings computed
from it, through the personal API token is distribution of the material or an adaptation of it.
CC BY-NC-SA 3.0 then requires attribution (§4(c)) and, for adaptations, ShareAlike licensing
(§4(b)) on the distributed result. That is not a bar on the feature. It is a licensing obligation
attached to an API response, which is an awkward thing to discharge - you would be asserting a
CC BY-NC-SA licence over part of your own API output.

**Delete `inc=tags` and this entire paragraph stops applying.** That is the second independent
argument for F1, and together the two make the change close to unarguable.

#### What still constrains the feature

Nothing from MetaBrainz. Two things from elsewhere, both already handled, both worth restating so
this section is a complete answer:

- **Scope discipline.** `docs/api/personal-api-tokens.md` limits tokens to `read:me`,
  `read:wishlist`, `read:recommendations`, `read:connections`, all read-only, and 403s them on
  every session route. That is what keeps "their own data" literally true, which is the premise
  the ListenBrainz analysis above depends on. If a scope were ever added that let token A read
  user B's data, the analysis changes and this review must be redone.
- **Other providers in the same envelope.** A `/v1/recommendations` response can carry Last.fm
  and SeatGeek-derived material. **SeatGeek 7.13 does apply to that**, and it applies at the API
  boundary, not just in the UI. `legal/attribution.md` SG-7 covers the client; a machine-readable
  API that returns event data to a script is exactly the exposure 7.13 describes. **The
  `read:recommendations` scope currently grants `GET /v1/feed`, `/v1/recommendations` and
  `/v1/stations`** - confirm none of those can return SeatGeek material, or the personal API
  token becomes a SeatGeek problem even though it is not a MetaBrainz one. Flagged for the
  SeatGeek owner; out of scope for this review.

### Q5. Rate limits

**MusicBrainz: 1 req/s is current, and it is enforced per-IP. It is one of three checks.**

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_API): "All users of the API must ensure that each
> of their client applications never make more than ONE call per second. Making more than one
> call per second drives up the load on the servers and prevents others from using the
> MusicBrainz API. If you impact the server by making more than one call per second, your IP
> address may be blocked preventing all further access to MusicBrainz."

The rate limiting page is more precise, and it answers the per-IP versus per-User-Agent question
directly: **it is both, checked in sequence, plus a global check.**

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting): "When a request reaches our
> servers we check three conditions, in the following order: User-Agent string: are we receiving
> too many requests from this application? Source IP address: are we receiving too many requests
> from this particular IP address? Global: are the MusicBrainz servers as a whole too busy to
> handle this request? If the answer to any one of those questions is "yes", then the request is
> denied with a 503 Service Unavailable error, and processing stops."

> **VERBATIM** (same page, "Source IP address"): "Unless you have agreed otherwise with
> MusicBrainz, the rule is as follows: The rate at which your IP address is making requests is
> measured. If that rate is too high, all your requests will be declined (http 503) until the
> rate drops again. Currently that rate is (on average) 1 request per second. For example: if
> your requests are coming in at 4 requests per second, we don't honour 25% of them and decline
> the other 75% - we decline 100% of them, until the rate drops to 1 per second or lower."

> **VERBATIM** (same page, "User-Agent"): "For "anonymous" user-agents (see below): we allow
> through (on average) 50 requests per second, and decline (http 503) the rest. For other
> user-agents: allow through."

> **VERBATIM** (same page, "Global"): "We allow through 300 requests each second (on average),
> and decline (http 503) the rest."

**Three consequences worth designing around:**

1. **The binding constraint for Pull.fm is the per-IP 1 req/s.** The per-UA check does not
   throttle named agents at all ("For other user-agents: allow through"), so the descriptive
   User-Agent buys exemption from the 50/s anonymous bucket, not a higher personal quota. The
   process-wide limiter is correct and should not be relaxed on the theory that a good UA earns
   headroom. It does not.
2. **Per-IP means a shared egress IP is a shared fate.** If Pull.fm shares an outbound IP with
   any other MusicBrainz consumer, that consumer's traffic counts against Pull.fm's 1 req/s and
   produces 503s Pull.fm did not cause and cannot see the source of. Worth confirming the egress
   IP is dedicated, and worth a runbook note so an incident is not misdiagnosed as a limiter bug.
3. **The failure mode is total, not partial.** Their own worked example is explicit: at 4 req/s
   they decline 100%, not 75%. There is no graceful degradation to design against - only a cliff.

> **VERBATIM** (same page): "We may change the blocking/throttling rules at any time in order to
> protect the overall site health. As of 2012-01-08 our rules are as follows:"

The rules are dated 2012-01-08 and are still what the page publishes on 2026-07-28, so 1 req/s is
long-standing. But the reservation is explicit, which is a reason to keep the limiter's interval
configurable rather than compiled in as a constant. `MUSICBRAINZ_MIN_INTERVAL_MS = 1000` is
currently an exported const.

**ListenBrainz: there is no documented number. There is a documented _mechanism_, and Pull.fm is
not using it.**

> **VERBATIM** (metabrainz/listenbrainz-server, `docs/users/api/index.rst`, "Rate limiting"): "The
> ListenBrainz API is rate limited via the use of rate limiting headers that are sent as part of
> the HTTP response headers. Each call will include the following headers: **X-RateLimit-Limit**:
> Number of requests allowed in given time window - **X-RateLimit-Remaining**: Number of requests
> remaining in current time window - **X-RateLimit-Reset-In**: Number of seconds when current time
> window expires (_recommended_: this header is resilient against clients with incorrect clocks) -
> **X-RateLimit-Reset**: UNIX epoch number of seconds (without timezone) when current time window
> expires"

> **VERBATIM** (same): "Rate limiting is automatic and the client must use these headers to
> determine the rate to make API calls. If the client exceeds the number of requests allowed, the
> server will respond with error code `429: Too Many Requests`. Requests that provide the
> _Authorization_ header with a valid user token may receive higher rate limits than those without
> valid user tokens."

That last sentence is the entire published answer on authenticated versus unauthenticated: **a
token _may_ get a higher limit. No number is published for either case.**

#### F3. ListenBrainz rate limit is hard-coded, not header-driven

**Severity: P1.**

`packages/upstream/src/listenbrainz/client.ts:43` declares
`LISTENBRAINZ_QUOTA = { limit: 30, windowMs: 10_000 }`, sourced from an observed
`x-ratelimit-limit: 30` during the 2026-07-28 audit. Observing 30/10s and hard-coding it is not
what the documentation asks for. The documented requirement is verbatim that "the client **must**
use these headers to determine the rate to make API calls" - the numbers are server-controlled
and per-response, and the header set exists precisely so clients do not bake in a constant.

Today the constant is conservative and nothing breaks. It breaks silently if ListenBrainz ever
_lowers_ the limit for some endpoint or token class, because Pull.fm would keep pacing at 30/10s
into a smaller window and collect 429s with no adaptive backoff.

**Recommendation:** read `X-RateLimit-Remaining` and `X-RateLimit-Reset-In` from each response and
drive the quota from them, keeping the 30/10s constant only as the pre-first-response default.
`X-RateLimit-Reset-In` is the one to use - their docs recommend it explicitly over
`X-RateLimit-Reset` for clock-skew resilience.

Also worth noting: `labs.api.listenbrainz.org` is a separate host. No rate limit is published for
it anywhere the reviewer could find. Treating it as best-effort with its own circuit breaker,
which `client.ts` already does, is the right posture in the absence of a documented limit.

### Q6. AI and machine learning

**Short answer: no restriction exists. Nothing to comply with. Recording it as you asked.**

No reviewed MetaBrainz, MusicBrainz or ListenBrainz document contains any restriction on using
their data to train, fine-tune, or feed a model. For core data the CC0 waiver forecloses the
question: "anyone can download and use the core data in any way they see fit."

MetaBrainz is aware of the issue and has an **open, unresolved discussion** rather than a policy.
From the community thread "Next AI discussion: AI and our data"
(community.metabrainz.org/t/next-ai-discussion-ai-and-our-data/635782), a MetaBrainz director's
stated position:

> **VERBATIM** (attributed to "Rob" in that thread, as reported by the fetch tool - the reviewer
> did not read the raw thread HTML directly): "I really don't - I have no problems with our data
> being used in AI as long as we generally agree that it isn't going to destroy the world."

**Reviewer's judgement: treat this as favourable context, not as a grant.** A forum post by a
director is not a licence term, and a foundation-level AI policy is plausible within the life of
this product. The load-bearing protection is that core data is CC0, which no future policy can
retroactively revoke for data already obtained.

**The one place a restriction would bite:** CC BY-NC-SA 3.0 supplementary data. Training a model
on it is arguably preparing an adaptation, which engages ShareAlike, and any commercial training
engages NonCommercial. Pull.fm's discovery blend is deterministic ranking, not ML, so there is no
exposure today - but this is a third reason `inc=tags` is worth deleting: it keeps the answer to
"can we ever put this data near a model?" as an unqualified yes.

**For the record, as requested:** as of 2026-07-28, Pull.fm's discovery blend
(`packages/discovery/src/blend.ts`) performs deterministic scoring and merging. No MetaBrainz
data is used to train, fine-tune, or evaluate any model, and no such restriction would apply if
it were.

### Q7. Anything else that would change a design decision

#### F5. A mirror is not CC0

**Severity: P1. This changes the mirror decision already recorded in `docs/UPSTREAM-TERMS.md`.**

> **VERBATIM** (musicbrainz.org/doc/About/Data_License, "Live Data Feed"): "The Live Data Feed
> replication packets are licensed under the Creative Commons Attribution-NonCommercial-ShareAlike
> 3.0 license."

`docs/UPSTREAM-TERMS.md` records "Mirror required at scale" as a scaling and cost issue. It is
also a **licensing** issue, and a much larger one than the summary table implies: taking the Live
Data Feed brings the whole replicated database in under BY-NC-SA rather than CC0, because the
packets themselves carry that licence regardless of the CC0 status of the core rows they contain.
A mirror therefore converts Pull.fm's cleanest licence position into its most encumbered one, and
would foreclose commercial use of the local database permanently.

**Design consequence:** the mirror is not the obvious win the current doc implies. If the goal is
purely to escape 1 req/s, the alternatives (a deeper crosswalk, the CC0 canonical data dumps,
higher cache hit rates) preserve the CC0 position and the mirror does not. Whoever owns the
scaling decision should read this before choosing. This warrants a correction to
`docs/UPSTREAM-TERMS.md` - not made here, since that file is owned by another work stream.

#### F6. LB and MB responses are not actually cached

**Severity: P1. Reported because the audit brief states caching as fact and the code does not
support that.**

The brief describes ListenBrainz and MusicBrainz responses as "cached in our Postgres
(`upstream_cache` table) with TTLs". As of this review:

- `CachedUpstream` (`packages/upstream/src/cache/cache-first.ts`) is referenced by exactly one
  provider: `packages/upstream/src/events/seatgeek-provider.ts`. Grep finds no other non-test
  consumer.
- `MusicBrainzClient` and `ListenBrainzClient` call `requestJson` directly. Neither takes a cache.
- `new MusicBrainzClient(` does not appear anywhere in `apps/` - the client is not wired into the
  running service yet.

This is consistent with a pre-alpha repository and is not a breach of anything. It matters
because **at 1 req/s the cache is not an optimisation, it is the mechanism that makes the rate
limit survivable.** The `mbid_crosswalk` permanence argument and the Gate 2 warm-hit-rate target
both assume a cache that does not exist yet. Nothing in this review's conclusions depends on the
cache being present, but the compliance posture the brief describes is not yet the posture the
code implements, and the gap should close before there are users.

#### F4. `legal/attribution.md` section 6 is wrong about MetaBrainz

**Severity: P1, documentation.**

Section 6 currently states that no attribution clause is recorded as binding for ListenBrainz and
MetaBrainz, and frames the credit as pure courtesy. The conclusion is right; the reasoning is
wrong in two ways that will mislead the next reader:

1. It treats "not recorded in `UPSTREAM-TERMS.md`" as equivalent to "no obligation exists". The
   MusicBrainz supplementary-data obligation was never recorded there, and it is real
   (see F1, F2).
2. It implies ListenBrainz has no terms. **ListenBrainz has terms - it incorporates five
   MetaBrainz documents by reference.** See F9.

#### F9. ListenBrainz terms are five external documents, and they can change

**Severity: P2, process.**

There is no standalone ListenBrainz terms of service. The page delegates entirely:

> **VERBATIM** (`frontend/js/src/about/terms-of-service/TermsOfService.tsx`,
> metabrainz/listenbrainz-server@master - see the retrieval log for why this is the source rather
> than the rendered page): "As one of the projects of the MetaBrainz Foundation, ListenBrainz'
> terms of service are defined by the social contract and privacy policies of the Foundation. You
> will find these detailed on the MetaBrainz website:" followed by links to Social Contract,
> Privacy Policy, GDPR Compliance, Code of Conduct, and Conflict Resolution Policy.

The same page also covers third-party playback SDKs (Spotify, YouTube, SoundCloud) that
ListenBrainz itself loads. **Those bind ListenBrainz's own website users, not Pull.fm** - Pull.fm
consumes the ListenBrainz API server-side and loads none of those SDKs. Not applicable, noted so
nobody re-derives it.

**Design consequence:** Pull.fm's ListenBrainz obligations are defined by documents that
MetaBrainz can revise without touching anything on listenbrainz.org, and without any versioning
or changelog that the reviewer could find. **Add all five MetaBrainz documents to the quarterly
re-audit list**, not just the ListenBrainz page - watching the ListenBrainz ToS page for changes
would detect nothing, because the page contains no terms.

This also confirms the foundation-level premise in the audit brief: **MetaBrainz foundation terms
do apply to both projects**, and for ListenBrainz they are the _only_ terms.

#### F8. User-Agent format

**Severity: P3. Acceptable as-is; recorded so it is not re-litigated.**

> **VERBATIM** (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting): "Each request sent to
> MusicBrainz needs to include a User-Agent header, with enough information in the User-Agent for
> us (MusicBrainz) to contact the application maintainers. We strongly suggest including your
> application's version number in the User-Agent string too. This is so that if there's a problem
> we can contact you. We suggest that your User-Agent string should look like: Application
> name/<version> ( contact-url )"

Pull.fm sends `PullFM/0.1.0 (ope@312.dev)`. Differences from the suggested form: a contact
**email** rather than a URL, and no spaces inside the parentheses. **Reviewer's judgement:
compliant.** The stated requirement is functional - "enough information... to contact the
application maintainers" - and an email address satisfies it more directly than a URL. The
suggested form is introduced with "We suggest", not "must". Name and version are both present.
`USER_AGENT_RE` in `client.ts:88` enforces the shape at construction, which is the right place.

**One operational condition attaches to this and it is easy to miss:** the User-Agent is the
channel MusicBrainz uses to reach you, and their stated escalation path is to contact maintainers
before throttling an application. **`ope@312.dev` must be a monitored mailbox.** An unmonitored
contact address converts a courtesy warning into an unexplained block.

#### F10. Cover Art Archive

**Severity: P2, watch item.**

> **VERBATIM** (musicbrainz.org/doc/About/Data_License, "Cover art"): "The MusicBrainz dataset
> does not contain cover art. Cover art is provided by the Cover Art Archive."

Verified by grep: nothing in `packages/upstream/src` or `apps/bff/src` references cover art, the
Cover Art Archive, or `coverartarchive.org`. **Correct today.** Flagged because a music discovery
UI almost certainly wants album artwork, and the moment it does, that is a **fourth-party provider
with its own terms, its own rate limits, and its own per-image rights position** - artwork
copyright is not MetaBrainz's to license. It is not covered by this review and must be audited
separately before any client renders an image.

---

## Questions to ask MetaBrainz

Two are worth an actual email; the rest of this review is settled enough not to need one.
MetaBrainz are responsive and the contact route is the supporters signup or `support@metabrainz.org`.

**1. Tier classification (F7).** The material question. Suggested framing:

> Pull.fm is a non-commercial, Apache-2.0, open-source music discovery backend built by 312.dev
> LLC. It has no ads, subscriptions, affiliate revenue, or data sales, and no expected revenue
> stream; non-commercial operation is a locked design constraint enforced in our codebase. We use
> the MusicBrainz web service at 1 req/s and the ListenBrainz API with per-user tokens supplied by
> each user. We run no mirror and take no dumps.
>
> Your account-type page applies a revenue test, under which we read ourselves as non-commercial.
> But the Bronze tier is described by product visibility ("popular mobile apps and... public
> products") rather than revenue, and the free Non-profit tier is described as covering "authors
> of open-source software using our data" while being named for non-profits, which we are not
> (we are an LLC). Which tier applies to us, and does the answer change if the app becomes
> popular while remaining revenue-free?

**2. Live Data Feed licence scope (F5).** Worth asking before the mirror is built, not after:

> The data licence page states the Live Data Feed replication packets are CC BY-NC-SA 3.0. If we
> run a mirror from the Live Data Feed, does the BY-NC-SA licence attach to the whole replicated
> database, or do the core-data rows within it retain their CC0 status once loaded? This
> determines whether running a mirror is compatible with our CC0-only data posture.

**Not worth asking:** whether AI/ML use is permitted (CC0 answers it, and the foundation has no
policy to cite); whether caching is capped (no cap exists in any published source); whether
attribution is required for core data (CC0 answers it).

---

## Recommended actions

Ordered by ratio of risk removed to effort. None are made by this review - it is a read-only
audit and `apps/`, `packages/`, `infra/`, `docs/` and `security/` are owned by other work streams.

| #   | Action                                                                                                                                                                                                                                                                      | Owner                | Removes                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| 1   | Delete `inc=tags` from `getArtist` and the `tags` field from `MusicBrainzArtist` (`packages/upstream/src/musicbrainz/client.ts:224`, `:50`, `:102`). No consumer exists.                                                                                                    | upstream             | F1, and the only parts of F2, Q4 and Q6 that have teeth |
| 2   | After (1): relabel MB-2/MB-3 in `legal/attribution.md` as courtesy, matching how section 6 treats ListenBrainz. If (1) is rejected, instead add a `MUSICBRAINZ_ATTRIBUTION` constant **including the CC BY-NC-SA 3.0 licence URI** and emit it from `collectAttribution()`. | legal + discovery    | F2                                                      |
| 3   | Drive the ListenBrainz quota from `X-RateLimit-Remaining` / `X-RateLimit-Reset-In`, keeping 30/10s as the pre-first-response default only.                                                                                                                                  | upstream             | F3                                                      |
| 4   | Correct `legal/attribution.md` section 6: ListenBrainz **does** have terms, by reference to five MetaBrainz documents. Add those five to the quarterly re-audit list.                                                                                                       | legal                | F4, F9                                                  |
| 5   | Add to `docs/UPSTREAM-TERMS.md` that Live Data Feed packets are CC BY-NC-SA 3.0, so the mirror decision is made with the licence consequence visible.                                                                                                                       | docs                 | F5                                                      |
| 6   | Wire `CachedUpstream` into the MusicBrainz and ListenBrainz clients before either is exposed to real traffic.                                                                                                                                                               | upstream             | F6                                                      |
| 7   | Confirm `ope@312.dev` is a monitored mailbox and record it in the runbook as the MusicBrainz escalation contact.                                                                                                                                                            | ops                  | F8 operational risk                                     |
| 8   | Confirm the production egress IP is not shared with another MusicBrainz consumer; add a runbook note that MusicBrainz 503s may originate off-box.                                                                                                                           | infra                | Q5 consequence 2                                        |
| 9   | Confirm no `read:recommendations` route can return SeatGeek material through a personal API token.                                                                                                                                                                          | bff + SeatGeek owner | Q4 residual                                             |
| 10  | Email MetaBrainz with the two questions above.                                                                                                                                                                                                                              | operator             | F7, F5                                                  |

---

## Source retrieval log

Recorded so a future reader can tell what was read from the source versus inferred. **Two pages
could not be retrieved and were not reconstructed from memory.**

| Source                                                           | Method                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `musicbrainz.org/doc/MusicBrainz_API`                            | curl, server-rendered HTML                | **HTTP 200, full text read**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting`              | curl, server-rendered HTML                | **HTTP 200, full text read**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `musicbrainz.org/doc/About/Data_License`                         | curl, server-rendered HTML                | **HTTP 200, full text read**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `musicbrainz.org/doc/MusicBrainz_Database`                       | WebFetch                                  | HTTP 200, core/supplementary lists extracted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `musicbrainz.org/doc/Live_Data_Feed`                             | WebFetch                                  | HTTP 200, licence and access-token statements extracted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `metabrainz.org/social-contract`                                 | WebFetch                                  | HTTP 200, extracted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `metabrainz.org/supporters/account-type`                         | WebFetch                                  | HTTP 200, all seven tiers and both qualifying sentences extracted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `metabrainz.org/supporters`                                      | WebFetch                                  | HTTP 200, extracted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `metabrainz.org/privacy`                                         | WebFetch                                  | HTTP 200. **Contains no third-party developer obligations** - confirmed by targeted query, not assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `metabrainz.org/datasets`                                        | WebFetch                                  | HTTP 200, but **states no per-dataset licences**; not relied on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `community.metabrainz.org/t/.../635782`                          | WebFetch                                  | HTTP 200. Forum thread, **not a term**; used only for the AI-policy status in Q6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`listenbrainz.org/terms-of-service/`**                         | WebFetch, then curl, then r.jina.ai proxy | **COULD NOT READ THE RENDERED PAGE.** HTTP 200 but the response is a 3,777-byte React shell; `page-react-props` is empty and the ToS component is a lazy-loaded chunk not present in `indexPage.js` (grepped, zero matches). The r.jina.ai text proxy returned **HTTP 401** ("blocked from performing anonymous queries due to bad network reputation"). **Substituted:** `frontend/js/src/about/terms-of-service/TermsOfService.tsx` from `metabrainz/listenbrainz-server@master` via raw.githubusercontent.com, HTTP 200. **Caveat: this is the master branch, not verified to match what is deployed.** The F9 conclusion rests on this file. If it matters to a decision, open the page in a real browser and confirm. |
| **`listenbrainz.readthedocs.io/en/latest/users/api/index.html`** | WebFetch, then curl with browser UA       | **HTTP 429 both times**, hard rate-limited. **Substituted:** `docs/users/api/index.rst` from `metabrainz/listenbrainz-server@master`, HTTP 200 - the reStructuredText source the published docs are built from. Same master-branch caveat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Not reviewed, out of scope:** Cover Art Archive terms (F10); MusicBrainz Copyright and DMCA
Compliance; MetaBrainz GDPR, Code of Conduct and Conflict Resolution policies (referenced by the
ListenBrainz ToS but containing no data-use terms relevant to an API consumer, on the reviewer's
reading of their titles and the social contract - **not read in full**); the ListenBrainz listen
data dump licence (Pull.fm takes no dumps).

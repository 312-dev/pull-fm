# Attribution obligations: a build checklist for the frontend

> **Status: normative for any Pull.fm client.** This is not a style guide. Every
> item below is a term of a licence Pull.fm relies on, and the providers that
> impose them (Last.fm, MusicBrainz) revoke access without appeal or SLA. See
> [`../docs/UPSTREAM-TERMS.md`](../docs/UPSTREAM-TERMS.md) and
> [`../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md).
>
> **This is not legal advice.** The clause references are the operator's reading
> of the published terms as recorded in this repository on 2026-07-28. Re-read
> the terms before launch and quarterly after; clause numbers move.

The backend cannot discharge any obligation on this page. It can only refuse to
hand back a shape that lets a client think it has. What it does hand back is
described in "What the API gives you" at the bottom, so each check below can be
wired to a field rather than to a memory.

---

## 1. Last.fm

**Binding clauses:** ToS 2.7 and 4.2.2 (attribution), 3.1-3.2 (non-commercial),
4.3.4 (100 MB cache cap).

| #   | Check                                                                                                                                                                                                         | Done |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| L-1 | Wherever Last.fm-derived data is rendered, a visible credit reading **"Data provided by Last.fm"** appears in the same view.                                                                                  | [ ]  |
| L-2 | That credit is a **link**, and the link target is the Last.fm URL the API returned for the entity, in the `https://www.last.fm/music/[artist]` form. Do not construct this URL client-side; use `url`.        | [ ]  |
| L-3 | Every artist name sourced from Last.fm links to that artist's `last.fm/music/[artist]` page. Per-entity, not one blanket footer credit.                                                                       | [ ]  |
| L-4 | The credit is not hidden behind a tap, an "about" screen, a tooltip, or an overflow menu. It is rendered in the view where the data is.                                                                       | [ ]  |
| L-5 | No purchase, listen, or outbound link derived from a Last.fm entity carries an affiliate parameter, referral tag, or tracking identifier of ours. Any of them is a **material breach** of 3.1-3.2.            | [ ]  |
| L-6 | The client does not build its own local mirror of Last.fm payloads. The 100 MB cap in 4.3.4 is measured server-side (`cache_size_by_provider`); a client-side cache is outside that accounting and breaks it. | [ ]  |

**Why L-2 is written that way.** The link format is the attribution, not
decoration. A credit that reads "Last.fm" and links to `last.fm` homepage does
not satisfy the clause as it is recorded here, because the clause names the
per-artist form. The API returns the exact URL so the client never has to
slugify an artist name, which is where this goes wrong (accents, `/`, `&`).

**Approved badge.** Clause 4.2.2 also references an approved badge asset. The
badge asset and its current usage rules have **not** been retrieved and verified
by the operator. Treat this as an open item: before a public client ships, get
the badge from Last.fm's own materials and confirm whether it is required in
addition to the text credit or as an alternative to it.

---

## 2. MusicBrainz

**Binding condition:** a descriptive `User-Agent` naming the application and a
contact address, on every request. Generic agents are throttled harder, and the
identity is a licence condition rather than a nicety.

| #    | Check                                                                                                                                                                                 | Done |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| MB-1 | **The client never calls MusicBrainz directly.** All MusicBrainz access goes through the Pull.fm backend, which sends `PullFM/<version> (ope@312.dev)` and paces at 1 req/s globally. | [ ]  |
| MB-2 | Where MusicBrainz metadata is shown, a credit reading **"Metadata from MusicBrainz"** linking to `https://musicbrainz.org` appears in the same view.                                  | [ ]  |
| MB-3 | MBIDs shown to a user (for example in a debug or "about this track" panel) link to `https://musicbrainz.org/<entity>/<mbid>` rather than being rendered as bare identifiers.          | [ ]  |

MB-1 is the one that actually matters. The 1 req/s ceiling is **per IP and
global to the entire service**, so a client that fetches MusicBrainz from the
user's own device does not relieve the limit, it moves the traffic somewhere the
backend's rate limiter cannot see, and the first sign of trouble is a block.
`MusicBrainzClient` refuses to construct without a descriptive `User-Agent`
(`packages/upstream/src/musicbrainz/client.ts`), which is the server-side half of
this; there is no client-side half, because there is no client-side call.

**Whether MB-2 is an obligation or a courtesy depends on which data we take, and
that is currently unresolved.** MusicBrainz **core** data (MBIDs, artist names,
recording and release titles) is **CC0**, which imposes no attribution
requirement at all. MusicBrainz **supplementary** data - tags in particular - is
**CC BY-NC-SA 3.0**, which requires credit and drags ShareAlike onto anything
derived from it. [`../docs/compliance/metabrainz-terms-review.md`](../docs/compliance/metabrainz-terms-review.md)
records that the client currently requests `inc=tags`, which pulls the licensed
data into an otherwise CC0-only design (its findings F1 and F2), and recommends
dropping it.

**Render MB-2 either way.** If the `inc=tags` finding is closed, the credit is
courtesy and costs nothing. If it is not, the credit is a licence condition and
omitting it is a breach. There is no version of this where rendering the credit
is wrong, so it stays on the checklist as required.

---

## 3. Apple / iTunes previews

**Binding terms:** previews may be used only to promote store content, not for
"independent entertainment value"; previews must be **streamed only, and not
downloaded, saved, cached, or synchronized**.

| #   | Check                                                                                                                                                                          | Done |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| A-1 | Wherever an iTunes preview can be played, the string **"Preview provided courtesy of iTunes"** is visible in the same view. This is the exact `ITUNES_ATTRIBUTION` value.      | [ ]  |
| A-2 | The credit is visible **before or during** playback, not only in a settings screen.                                                                                            | [ ]  |
| A-3 | The client **streams** the preview from the returned URL. It does not download it to disk, does not populate an offline cache with it, and does not add it to a media library. | [ ]  |
| A-4 | No service worker, HTTP cache directive, or media-caching library is configured to persist preview audio. Check the platform default: several media players cache by default.  | [ ]  |
| A-5 | A preview is presented as a preview, next to a way to acquire the track. Not as a standalone listening experience, a queue, a playlist, or a background player.                | [ ]  |
| A-6 | No purchase link carries an affiliate token. Pull.fm takes no affiliate revenue anywhere, and Apple's terms are one of three that this would breach at once.                   | [ ]  |

A-3 and A-4 are the ones an implementation fails by accident. A-5 is the one it
fails by product drift: the "independent entertainment value" clause is the risk
recorded as L2 in `UPSTREAM-TERMS.md`, and the mitigation is a UI that keeps
previews attached to the acquisition path.

---

## 4. Deezer previews

**Binding terms:** non-commercial only; preview URLs are signed and expire.

| #   | Check                                                                                                                                                                        | Done |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D-1 | Wherever a Deezer preview plays, the credit **"Preview provided by Deezer"** is visible in the same view (the `DEEZER_ATTRIBUTION` value).                                   | [ ]  |
| D-2 | The client **never stores a Deezer preview URL**, in local storage, a state cache, an offline queue, or an analytics event. It requests the URL immediately before playback. | [ ]  |
| D-3 | A stale Deezer URL producing a 403 is handled as "re-resolve and retry", not surfaced as a playback error. Expiry is normal, not a fault.                                    | [ ]  |
| D-4 | No affiliate or referral parameter on any Deezer-derived link.                                                                                                               | [ ]  |

D-2 has a server-side counterpart: the `track_previews` schema **refuses** a
Deezer row without an expiry (`track_previews_deezer_expiry_chk`). The client
side has no such constraint, so it is a review item.

---

## 5. SeatGeek (live events)

**Binding clauses:** 3.1 (logo attribution), 7.13 (no systematic storage, no
exposure to search engines, directories, or AI/ML systems), 7.15 (no competitive
use, no secondary marketplace).

This is the strictest attribution obligation in the product, and the only one
where **a text credit is a breach**.

| #    | Check                                                                                                                                                                                                        | Done |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| SG-1 | The **SeatGeek logo** is rendered wherever event data appears. Not the word "SeatGeek". A text credit does not satisfy clause 3.1.                                                                           | [ ]  |
| SG-2 | The logo asset was obtained from **<https://seatgeek.com/press>** and the Brand Guidelines at that page were read before use. Do not hotlink their CDN; their terms do not grant it.                         | [ ]  |
| SG-3 | **Every instance** of the logo links to **<https://seatgeek.com>**. Every one, not the first, not one per screen.                                                                                            | [ ]  |
| SG-4 | The logo is modified **only** by proportional resizing. No recolouring, cropping, rotation, opacity change, drop shadow, mask, or tinting - including whatever a dark-mode filter would do to it.            | [ ]  |
| SG-5 | The client renders **no price** for an event, and does not invent, estimate, or infer one. SeatGeek returns none, and the interface has no price field by design.                                            | [ ]  |
| SG-6 | No price comparison, no aggregation of SeatGeek events against another ticket source, no resale surface. Clause 7.15.                                                                                        | [ ]  |
| SG-7 | Event data is not written to any client-side persistent store beyond an in-memory session cache, and is not included in any crash report, analytics payload, or shared/exported artifact.                    | [ ]  |
| SG-8 | The event view sends **no coordinate and no postal code** to Pull.fm's events route. A city name only. Clause 4.4 forbids Personal Data reaching their API, and the backend rejects coordinate-shaped input. | [ ]  |

**SG-4 is the dark-mode trap.** A CSS `filter: invert()` applied to a theme, or
an `opacity` on a footer, is a modification of the mark. If the logo is
illegible on the dark background, use whichever variant SeatGeek publish for
that case, not a filter.

**SG-7 restates a backend rule at the client.** Clause 7.13 prohibits making
SeatGeek Materials available to "a search engine, directory, or AI or machine
learning application or model". A client that ships event data into an analytics
pipeline or an LLM-backed feature reaches exactly that prohibition, by a path the
backend cannot see.

---

## 6. ListenBrainz and MetaBrainz

| #    | Check                                                                                                                        | Done |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| LB-1 | Credit **"Recommendations powered by ListenBrainz"**, linking to <https://listenbrainz.org>, wherever recommendations appear | [ ]  |

**Corrected 2026-07-28.** An earlier revision of this section said no obligation
exists because none was recorded in
[`../docs/UPSTREAM-TERMS.md`](../docs/UPSTREAM-TERMS.md). The conclusion happened
to be right and the reasoning was wrong, in a way that would mislead the next
reader:

1. **"Not recorded in our audit" is not "no obligation exists".** The MusicBrainz
   supplementary-data attribution requirement was never in `UPSTREAM-TERMS.md`
   either, and it is real. See section 2.
2. **ListenBrainz does have terms.** There is no standalone ListenBrainz ToS; the
   page **incorporates five MetaBrainz documents by reference** (Social Contract,
   Privacy Policy, GDPR Compliance, Code of Conduct, Conflict Resolution Policy),
   any of which MetaBrainz can revise without touching listenbrainz.org and
   without versioning.

So LB-1 is a **courtesy today**, on the strength of an actual review rather than
an absence of notes, and the review is
[`../docs/compliance/metabrainz-terms-review.md`](../docs/compliance/metabrainz-terms-review.md).
Re-check it when that document is re-audited, because "courtesy" here rests on
five external documents that can change silently.

Render it regardless. The data is a gift from a non-profit and the product is
built on it.

---

## 7. What the API gives you

Attribution is a **required** property of the product response envelope, not an
optional courtesy field, so a client cannot omit it by not knowing about it.

```jsonc
// GET /v1/feed, /v1/recommendations, /v1/stations
{
  "sections": [/* ... */],
  "cursor": null,
  "degraded": false,
  "unavailableProviders": [],
  "attribution": [
    {
      "source": "lastfm",
      "text": "Data provided by Last.fm",
      "url": "https://www.last.fm/music/Bjork",
    },
    {
      "source": "musicbrainz",
      "text": "Metadata from MusicBrainz",
      "url": "https://musicbrainz.org",
    },
  ],
}
```

Events use a **different and richer** shape, because `{ source, text }` cannot
express "render this logo, link every instance, resize proportionally only":

```ts
// packages/upstream/src/events/types.ts
interface ProviderAttribution {
  source: string; // "seatgeek"
  text: string; // alt text for the logo, NOT a substitute for it
  logoRequired: boolean; // true => a text credit alone is a breach
  logoAssetPage: string | undefined; // "https://seatgeek.com/press"
  linkUrl: string; // every instance links here
  logoModification: "proportional-resize-only" | "unrestricted";
}
```

**Render rule:** if `logoRequired` is true and the component is about to render
`text` as a string, the component is wrong. Fail the build on it if the
component library allows; a lint rule beats a checklist item that is ticked once.

---

## 8. The rule that outranks all of the above

**No affiliate parameters, referral tags, or revenue-bearing links, anywhere,
ever.** Pull.fm is non-commercial by locked decision
([`../docs/PLAN.md`](../docs/PLAN.md) section 1a), and that single fact is what
makes Last.fm, Deezer, and Apple usable at all. An affiliate tag added to a buy
link would breach all three **simultaneously and retroactively**, which is why it
is enforced server-side in three places (a lint rule, an integration test, and
the wishlist acquire route) rather than trusted to anybody's memory.

If a future client adds monetisation of any kind, stop and re-read
`docs/PLAN.md` section 1a before writing the code. It is the blocker, and it is
not negotiable at the level of an individual link.

---

## Sign-off

A client is not shippable until every box above is ticked by a person who looked
at the running UI, not at the code. The failure mode this page exists to prevent
is a credit that is present in the component and absent on screen, which is the
same outcome as never having written it.

| Section      | Checked by | Date | Build/commit |
| ------------ | ---------- | ---- | ------------ |
| Last.fm      |            |      |              |
| MusicBrainz  |            |      |              |
| Apple/iTunes |            |      |              |
| Deezer       |            |      |              |
| SeatGeek     |            |      |              |
| ListenBrainz |            |      |              |
| No-affiliate |            |      |              |

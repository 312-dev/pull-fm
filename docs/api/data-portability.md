# What this API serves, and what it deliberately does not

Two questions get conflated when a public read API is added to a service built on other people's
data, and they have different answers:

1. **May a user read their own data through a token?** Yes. A person reading data about themselves,
   through a credential they created, is not redistribution by any reading of any upstream term.
2. **May that token be used to pull the upstream data in bulk?** No. Pull.fm has a licence to _use_
   Last.fm and MusicBrainz data, not to _redistribute_ it, and an API that returns raw upstream
   payloads is redistribution regardless of who is asking.

Everything below is the second answer, written down so the endpoint nobody should build does not get
built by someone who only remembers the first.

## The constraint

`docs/UPSTREAM-TERMS.md` and `docs/PLAN.md` section 1a are the source. The short version:

| Provider    | What binds us                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last.fm     | Non-commercial only. **100 MB cache cap** (ToS 4.3.4). Attribution in their specified `last.fm/music/[artist]` link format. Any affiliate revenue is "a material breach". |
| MusicBrainz | 1 request per second **globally per IP**. A descriptive `User-Agent` with a contact address is a licence condition, not a nicety.                                         |
| Apple       | Previews are streamed, never cached as audio. "Provided courtesy of iTunes" attribution. No "independent entertainment value".                                            |
| Deezer      | Non-commercial only. Preview URLs are signed and expire, so they are never stored at all.                                                                                 |

None of these providers licences their catalogue for republication. A Pull.fm endpoint that returned
their payloads verbatim would be a republication service with our name on the rate limit, and
`UPSTREAM-TERMS.md` records that Last.fm and MusicBrainz revoke **without appeal or SLA**. That is
not a fine, it is the end of the product: there is no second supplier of MBIDs.

## The rule

**No endpoint returns raw Last.fm or MusicBrainz payloads, in bulk or otherwise.** There is no
`GET /v1/upstream/...`, no passthrough proxy, no "give me everything you have cached about this
artist" route, and no bulk catalogue export. The personal API token cannot reach one because none
exists.

What the token serves instead is **Pull.fm's own derived output**: the recommendations, the feed, the
stations, the wishlist. Those are our rankings over our own database, and they carry the attribution
the upstream terms require.

That is not a downgrade for the user. Somebody who wants raw Last.fm data can get it from Last.fm,
with their own key, under their own agreement. What they cannot get from Last.fm is the thing this
API actually offers, which is what Pull.fm concluded from it.

## Attribution is part of the contract

The `sections` envelope carries a mandatory `attribution` array:

```jsonc
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

It is a **required** property of the response schema rather than an optional courtesy, because a
client that cannot see the attribution cannot render it, and a product that does not render it is in
breach. Making it structural means a future client author cannot omit it by not knowing about it.

## No affiliate parameters, anywhere

`docs/PLAN.md` section 1a.1 makes this a hard rule: purchase links from `GET /v1/wishlist/{id}/acquire`
are plain search links. An affiliate tag would retroactively breach the Last.fm, Deezer, and Apple
terms **simultaneously**, because the non-commercial status is the single decision that unblocked all
three.

Enforced in three places, because this one is worth catching more than once: a lint rule, an
integration test (`apps/bff/test/integration/platform.test.ts`), and this document.

## The export excludes credentials, and why that is not a portability failure

`GET /v1/me/export` implements GDPR Article 20. It contains the user's profile, wishlist, connection
metadata, and API token metadata. It does **not** contain:

- Third-party access tokens or refresh tokens
- Last.fm session keys
- API token secrets, or their digests
- Envelope encryption material: wrapped DEKs, KEK ids, ciphertext columns

Article 20 gives a person the right to receive the personal data they provided, in a structured,
commonly used, machine-readable format. A ListenBrainz token is not personal data about the user in
any meaningful sense: it is a bearer credential for someone else's system, which the user can
regenerate at that system in under a minute.

Including it would convert every session takeover into a third-party credential theft with one
request, which is `THREAT-MODEL.md` AT-1 branch 2a. Last.fm session keys **do not expire**, so the
resulting compromise would be permanent and invisible to us.

The user loses nothing they cannot recover at the source. They would risk a permanent third-party
compromise by the alternative. The export says so in a `notice` field, so the exclusion is visible
to the person receiving the file rather than only to whoever reads this repository.

## Rate limits exist to protect somebody else's quota

`THREAT-MODEL.md` AT-5 states the uncomfortable version: **the cheapest catastrophic attack on
Pull.fm is not stealing anything, it is spending our upstream quota.** No credential is compromised,
no data leaks, and the product is dead.

So the cache-first architecture in `docs/PLAN.md` section 3 is a security control, not only a
performance one. No request path calls a third party synchronously. Scraping this API therefore
cannot produce a burst of upstream traffic; it produces queued jobs, which are rate-shaped by
construction. The per-token limit exists on top of that, because a scraper needs an account and a
per-account budget is the limit that survives an attacker rotating IP addresses.

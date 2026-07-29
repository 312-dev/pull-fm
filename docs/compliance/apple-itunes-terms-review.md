# Apple iTunes Search API and preview terms: compliance review

**Reviewed 2026-07-28** against the live published pages on that date, plus one live request to
`itunes.apple.com/search` and one `HEAD` against the returned preview asset (see
[Source retrieval log](#source-retrieval-log)). Every document cited here was retrieved
successfully; nothing in this review is reconstructed from memory.

**This is not legal advice.** It is the operator's reading of published terms. Clause text and
page content move; re-audit before launch and quarterly after.

**Convention used throughout:** text inside a blockquote marked **VERBATIM** is copied exactly
from the cited source, character for character. Everything else is the reviewer's paraphrase or
judgement and is labelled as such. Where a source is silent, this document says it is silent
rather than filling the gap.

**Why this review is load-bearing.** Deezer was dropped because its terms bar receiving money
related to the service, which is incompatible with donation funding. iTunes is now the _only_
preview source in the product. Apple is therefore simultaneously a single point of technical
failure and a single point of legal risk, and Apple's grant is revocable at will with no notice
period, no appeal, and no SLA.

---

## The headline

**The controlling document is one paragraph.** Not the Performance Partners programme terms, not
the Partnerize agreement, not the Apple Media Services Terms. It is the block headed "Legal" at
the bottom of <https://performance-partners.apple.com/search-api>, addressed to "Developers",
reachable with no login and no affiliate enrolment. It grants a licence subject to **six
conjunctive conditions**, numbered (i) through (vi). Failing any one of them puts the use outside
the grant.

**Pull.fm currently fails condition (ii), and has never considered it.** Condition (ii) is not
about attribution text and it is not the "entertainment value" question everyone worries about.
It requires the preview to be _proximate to an Apple-approved store badge that links directly into
Apple's store where the content can be purchased_. There is no badge in the design, no badge
requirement in `legal/attribution.md` section 3, no store-link field in the `track_previews`
table, and no way to express "render a badge" in the `Attribution` envelope shape. The API already
receives the store URL it would need (`trackViewUrl`) and throws it away before persistence.

This matters more than it sounds, because condition (ii) is the **objective** condition. Q1's
"independent entertainment value" question (condition (v)) is genuinely ambiguous and will stay
ambiguous no matter how much it is argued. Condition (ii) is a bright line, it is currently on the
wrong side of it, and it is cheap to fix. A reviewer at Apple looking for a reason to send a
takedown does not need to win the philosophical argument about condition (v) if condition (ii) is
visibly unmet.

**A separate, non-legal risk surfaced during the review and is worse than the licence question in
the short run.** Apple's rejection path is an opaque HTTP 403 with an empty body and no
`Retry-After`, served at the CDN edge and keyed to **source IP reputation** rather than to our call
rate. A production service on shared cloud egress has been documented as blocked for days while
calling at roughly half Apple's stated limit. Pull.fm's carefully conservative 15/min budget does
not protect against that, because the reputation is not ours alone. Combined with the fact that
Apple's own documented overflow path - the Enterprise Partner Feed - stopped carrying music data in
March 2025, the practical position is: **there is no higher-volume option, and good behaviour does
not guarantee access.** See [A14](#a14-the-real-risk-is-not-our-call-rate-it-is-our-egress-ip) and
[A15](#a15-the-documented-escape-hatch-no-longer-exists-for-music).

**The good news, and it is real.** The grant contains **no revenue restriction of any kind**.
There is no Deezer-style "non-commercial purpose" clause, no bar on receiving money, no bar on
being a company. Donation funding via Open Collective is not touched by anything in this
paragraph. Apple is, on this specific axis, materially more permissive than Deezer was, and the
funding decision that forced Deezer out does not force Apple out.

---

## Findings, prioritised

| #   | Finding                                                                                     | Severity | Status                   |
| --- | ------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| A1  | Condition (ii) store badge is entirely absent from design, docs and data model              | **P0**   | Needs changing           |
| A2  | `trackViewUrl` is fetched but never persisted, so the badge link cannot be built            | **P0**   | Needs changing           |
| A3  | `Attribution` envelope cannot express a badge requirement; only SeatGeek's shape can        | **P0**   | Needs changing           |
| A4  | Condition (vi) vs. Qobuz/Bandcamp link-out is a real, unresolvable-by-us risk               | **P1**   | Design decision          |
| A5  | Condition (v) "independent entertainment value" is ambiguous and only mitigable             | **P1**   | Design decision          |
| A6  | Preview URLs persisted indefinitely with no revalidation or purge path                      | **P1**   | Needs changing           |
| A7  | "per IP" is asserted in 6 places in the repo; Apple never says it                           | **P2**   | Correct the comment      |
| A8  | No "Download on iTunes" badge asset exists; the clause names artwork Apple stopped shipping | **P2**   | Ask Apple / use "Buy on" |
| A9  | `trackViewUrl` now returns `music.apple.com`, not an iTunes Store URL                       | **P2**   | Ask Apple                |
| A10 | No documented procedure for Apple's "remove immediately upon request" right                 | **P2**   | Process change           |
| A11 | Album art (`artworkUrl100`) is Promo Content under the same six conditions                  | **P2**   | Scope note               |
| A12 | Storefront hard-coded to `US`; store links will be wrong for non-US users                   | **P3**   | Design note              |
| A13 | Apple's own "Caching Architecture" cross-reference is dangling; guidance is missing         | **P3**   | Disclosed gap            |
| A14 | 403 blocks are keyed to egress IP reputation; a compliant 15/min budget does not protect us | **P1**   | Design + runbook         |
| A15 | Apple's EPF no longer carries music data; no higher-volume path exists for a non-partner    | **P1**   | Constraint to accept     |

### Already compliant - do not change these

| Area                                         | Why it is compliant                                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No audio is downloaded, proxied or stored    | Condition (iv) forbids downloading/saving/syncing the preview. Only the URL is stored. See [Q3](#q3-caching).                                                                                                                             |
| No audio analysis over previews              | The same clause independently forbids pulling preview audio to run feature extraction. `audio_features` is populated from other sources. Correct, and worth keeping.                                                                      |
| Attribution string contains the exact phrase | `ITUNES_ATTRIBUTION = "Preview provided courtesy of iTunes"` carries the phrase condition (iii) names. See [Q4](#q4-attribution).                                                                                                         |
| No affiliate token anywhere                  | Not required by this grant, but it keeps Pull.fm out of the Performance Partners contract entirely, which simplifies [Q2](#q2-which-terms-actually-bind-us) enormously.                                                                   |
| 15/min budget under the stated 20/min        | Conservative against the only figure Apple publishes, and the only available strategy now that the EPF no longer serves music. Necessary but **not sufficient** - see [A14](#a14-the-real-risk-is-not-our-call-rate-it-is-our-egress-ip). |
| No interactive search surface                | `ItunesClient` deliberately exposes no candidate list. Right call on rate-limit grounds, and it also keeps the product from looking like a competing catalogue search.                                                                    |
| iTunes is in the kill-switch provider list   | `packages/upstream/src/kill-switch.ts` can disable the provider. This is half of what [A10](#a10-no-takedown-procedure) needs.                                                                                                            |

---

## Q1. The central question: is a discovery app inside or outside the grant?

### The exact words at issue

There are two statements, in two places on the same page, and they are not identical in force.

The **Overview**, which is descriptive prose:

> **VERBATIM** (<https://performance-partners.apple.com/search-api>, Overview): "Developers may
> use promotional content in the API, including previews of songs, music videos, album art and App
> icons only to promote store content and not for entertainment purposes. Use of sound samples and
> other assets from the API must be proximate to a store badge. See below for terms and
> conditions."

The **Legal** block, which is the operative grant. Reproduced in full because every clause of it
matters somewhere in this review:

> **VERBATIM** (<https://performance-partners.apple.com/search-api>, "Legal"): "Developers may use
> certain promotional content as may be provided by Apple, including previews of songs and music
> videos, and album art, for the purposes of promoting the subject of the Promo Content; provided
> such Promo Content: (i) is placed only on pages that promote the content on which the Promo
> Content is based; (ii) is proximate to a "Download on iTunes" or "Download on App Store" badge
> (as approved by Apple) that acts as a link directly to pages within iTunes where consumers can
> purchase the promoted content; (iii) includes attribution indicating the Promo Content was
> "provided courtesy of iTunes" if such Promo Content includes song or music video previews; (iv)
> is streamed only, and not downloaded, saved, cached, or synchronized with video, if such Promo
> Content includes song or music video previews; (v) is not used for independent entertainment
> value apart from its promotional purpose; and (vi) is not used to promote any other goods or
> services. Developer acknowledges that Apple provides the Promo Content "as is," and disclaims any
> and all representations or warranties, including, but not limited to, non-infringement. Developer
> shall forward any claims received in connection with the Promo Content to Apple immediately upon
> receipt, and will remove any Promo Content immediately upon request from Apple."
>
> "This agreement and your use of Promo Content are governed by California law."

The structure is a grant with a purpose clause ("for the purposes of promoting the subject of the
Promo Content") followed by six conditions joined by "and". They are **conjunctive**. This is not a
balancing test where a strong showing on (i) offsets a failure on (ii).

### The reading under which Pull.fm is inside the grant

1. **The purpose clause fits almost perfectly.** The grant's stated purpose is "promoting the
   subject of the Promo Content" - that is, promoting _the song_. Pull.fm's preview exists for
   exactly one reason: to help a user decide whether to acquire that song. Every preview in the
   product is attached to a wishlist action and an acquisition link for the same track. Under the
   purpose clause as written, this is a textbook use.
2. **Condition (i) is satisfied.** A feed card that contains track X's title, artist, artwork,
   preview, wishlist button and buy link is "a page that promotes the content on which the Promo
   Content is based". A personalised feed is a sequence of such pages, not a single non-promotional
   page with music bolted on.
3. **"Entertainment purposes" most plausibly means using previews _as_ the product's content.**
   The mischief the clause is aimed at is legible: ringtone apps, free-music apps, games using
   previews as a soundtrack, sites that string previews together into a listening service. The
   distinguishing feature of all of those is that the preview is the payload. In Pull.fm the
   preview is an evaluation instrument and the payload is the recommendation.
4. **A 30-second, unseekable, un-queueable, un-repeatable clip is a poor entertainment product and
   a good evaluation instrument.** The format itself constrains the use.
5. **Apple does the same thing.** Preview-in-a-browse-surface is exactly how Apple's own retail
   UI works. It is difficult to argue the pattern is per se outside a grant Apple wrote to enable
   the pattern.

### The reading under which Pull.fm is outside the grant

This reading is stronger than it is comfortable to admit, and it is not disposed of by any of the
five points above.

1. **Condition (v) is written to catch exactly the thing the product is good at.** "Independent
   entertainment value apart from its promotional purpose" is not a purpose test, it is a _value_
   test. It asks whether the content delivers entertainment value that stands on its own. A user in
   a personalised discovery feed is, by the product's own description, listening to music they are
   likely to enjoy, one clip after another, for as long as they want to. Most of those plays end in
   no acquisition at all. The honest characterisation of a typical session is: mostly listening,
   occasionally wishlisting. The subjective experience is entertainment; the promotional purpose is
   real but is not the dominant one measured by time spent.
2. **"Promote store content" means Apple's store.** The Overview says previews may be used "only to
   promote store content". "Store" in this document, everywhere it appears, is Apple's. Condition
   (ii) makes the intended conversion path explicit: a badge linking "directly to pages within
   iTunes where consumers can purchase the promoted content". Pull.fm's conversion path currently
   terminates at Qobuz or Bandcamp. On this reading the preview is not promoting store content at
   all; it is promoting a purchase elsewhere. See [Q7](#q7-the-link-out).
3. **An endless algorithmic stream of music clips is structurally a radio product.** The feed is
   generated, personalised, and unbounded. That is the shape of a listening service. The fact that
   each item carries a buy link does not change the shape; a lot of things that were plainly
   entertainment products also carried buy links.
4. **Conditions (ii) and (vi) fail on the current design regardless of how (v) resolves.** This is
   the point that actually decides the question today. Even the most favourable reading of (v)
   does not help, because the conditions are conjunctive and (ii) is unmet as a matter of observable
   fact.

### The reviewer's judgement

**Condition (v), taken alone, is genuinely ambiguous and cannot be resolved from the text.** Both
readings are available on the words Apple wrote. Anyone who tells you this is clearly fine is
reading the purpose clause and ignoring the word "independent"; anyone who tells you it is clearly
prohibited is reading condition (v) and ignoring that Apple built this grant to enable
preview-in-a-catalogue.

**But the current implementation is outside the grant, and not because of (v).** It is outside
because condition (ii) is unmet, and arguably because of (vi). Those are not judgement calls.

The practical significance: **(ii) is fixable this week; (v) is not fixable, only mitigable.** The
mitigation for (v) is the same set of design constraints that also fixes (ii) - keep the preview
visually and functionally welded to the acquisition path, cap the listening affordances, never
build a queue or a continuous player, never let a preview play without a purchase route in the same
view. Those constraints do not make (v) go away. They make the promotional purpose the _evident_
one to a person looking at a screenshot, which is the only forum in which this question is ever
likely to be adjudicated.

**What would make (v) fail outright, from here:** background playback, a play-all or autoplay-next
behaviour, a preview queue or playlist, lock-screen media controls, gapless or crossfaded
transitions, a "shuffle my feed" affordance, or any surface where previews play without an
acquisition route visible. Each of those converts the audition into a listening session, and each
one is a normal, tempting product decision. This is the drift risk, and it deserves a written line
in the product docs rather than a paragraph in a compliance review nobody re-reads.

---

## Q2. Which terms actually bind us?

Four candidate instruments were examined. Only one binds.

### The one that binds: the Search API page's "Legal" block

Quoted in full in [Q1](#the-exact-words-at-issue). Reasons for concluding this is the operative
instrument for a non-affiliate:

- It is addressed to **"Developers"**, not to "Partner" or "Program participants". Every other
  Apple document reviewed here uses "Partner" as its defined term.
- The page is **publicly reachable with no authentication** (verified: HTTP 200, anonymous curl,
  no cookie).
- The API is **keyless** (verified: an anonymous `GET /search` returned HTTP 200 and a full result
  set with no credential of any kind).
- It carries its **own choice of law** - "governed by California law" - which is the signature of a
  standalone agreement, not a section of a larger one.
- **Substantively identical text is published in a second place**, Apple's archived developer
  documentation, which corroborates that this is a stable Apple instrument rather than a stray
  paragraph. The archived version differs only in also naming the iBooks Store:

  > **VERBATIM** (<https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html>):
  > "(ii) is proximate to a "Download on iTunes", "Download on App Store" or "Download on iBooks
  > Store" badge (as approved by Apple) that acts as a link directly to pages within iTunes or the
  > App Store where consumers can purchase the promoted content"

  All six conditions are otherwise word-for-word the same, including (iii), (iv), (v) and (vi).

**Does the API permit non-affiliate use, and under what terms?** On the evidence: yes, under the
"Legal" block and nothing else. Apple publishes an unauthenticated endpoint, documents it on a page
with no gate, addresses the terms to "Developers", and attaches a self-contained licence with its
own governing law. That is an offer to the public.

**The honest counter-argument, which should be recorded rather than buried.** The page lives on
`performance-partners.apple.com`, an affiliate-programme site, and the affiliate contract describes
the Search API as a gated programme tool:

> **VERBATIM** (Partnerize Partner Terms and Conditions, Schedule, "Apple Services Advertiser
> terms", section 3): "Upon Partner's request and upon Apple's approval, Partnerize may provide
> access to certain tools for Partner use in connection with links to the Stores, including the
> Enterprise Partner Feed ("EPF") and the Search API (collectively, the "Advanced Linking Tools")."

And the same Schedule restricts programmatic access:

> **VERBATIM** (same document, section 4.3): "Other than by way of permitted use of the Advanced
> Linking Tools, Partner may not employ any mechanical means to pull content from any Store or
> Apple site, including, but not limited to, programmatic crawling, downloading, viewing, or
> scraping."

Read together, those two clauses describe a world in which the Search API is a partner-only tool.
**They bind partners, not us** - section 4.3's subject is "Partner", a term defined by the act of
ticking the acceptance box on the Partnerize agreement, which Pull.fm has not done. But they are
evidence about Apple's _intent_ for the API, and that intent is not "an open public data source".
A reasonable person could conclude Apple tolerates non-affiliate use rather than licensing it
enthusiastically. That does not change the analysis - the public grant is what it is - but it
should temper any assumption that Apple owes this project stability.

### The one that does not bind: Performance Partners / Partnerize

Retrieved in full. The FAQ's "terms and conditions" link resolves, via `apple.co/pp-partnerizetc`,
to `docs.partnerize.com/terms_and_conditions/apple_services/2.0/UK/EN.pdf` - the **Partnerize
Partner Terms and Conditions**, an agreement between Performance Horizon Group Limited (trading as
Partnerize) and "Partner", with Apple named as a third-party beneficiary. Its Schedule contains
the "Apple Services Advertiser terms", which is the affiliate-programme sibling of our clause.

**Pull.fm is not a party.** The agreement is entered "By ticking the box below"; participation is
by application and acceptance ("Currently, we are only accepting a limited number of partners who
can drive volume and quality that meet Apple guidelines"). No application has been made.

It is worth reading anyway, because the affiliate version of our clause is the closest thing that
exists to an Apple gloss on our clause, and it differs in four instructive ways:

> **VERBATIM** (Partnerize T&Cs, Schedule, Apple Services Advertiser terms, section 2.1): "Partner
> may use certain promotional content as may be provided through the Program, including previews of
> songs and music videos, album art, and app icons ("Promo Content"), for the purposes of promoting
> the subject of the Promo Content or that subject's inclusion in a related service; provided such
> Promo Content: (i) is placed only on pages that promote the content on which the Promo Content is
> based; (ii) is proximate to the appropriate Apple-approved web badge provided through the Program
> ("Badge") that acts as a link directly to pages within the applicable country-specific store
> (each, a "Store," and collectively, the "Stores") where consumers can access the promoted content;
> (iii) includes attribution indicating the Promo Content was "provided courtesy of Apple" if such
> Promo Content includes song or music video previews; (iv) is streamed only, and not downloaded,
> saved, cached, or synchronized with video, if such Promo Content includes song or music video
> previews; (v) is not used for independent entertainment value apart from its promotional purpose;
> (vi) is not used to promote any other goods or services; and (vii) and Partner's use of such
> content complies with all applicable laws [...]"

The differences, and why each matters:

| Difference                                                                      | Significance                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose clause adds "or that subject's inclusion in a related service"          | Apple **widened** the purpose for partners. Our version is the narrower one. This cuts against any argument that our grant should be read expansively.   |
| (ii) says "where consumers can **access**", ours says "**purchase**"            | Ours is narrower again: our badge must point somewhere a purchase is possible, not merely somewhere the track can be reached.                            |
| (iii) says "provided courtesy of **Apple**", ours says "courtesy of **iTunes**" | Two live Apple attribution strings exist. Ours is the iTunes one. Do not "modernise" the string to "Apple" - see [Q4](#q4-attribution).                  |
| (iv), (v) and (vi) are **identical** in both                                    | The caching, entertainment-value and other-goods conditions are stable across both Apple instruments. They are not vestigial boilerplate in our version. |

That (v) and (vi) survive verbatim into a contract Apple negotiated and maintains for its
commercial partners is the strongest available evidence that Apple means them.

### The one that does not bind: Apple Media Services Terms and Conditions

Retrieved (<https://www.apple.com/legal/internet-services/itunes/us/terms.html>). This is the
**consumer** contract governing an Apple Account holder's use of Apple Media Services. It contains
provisions that would be fatal if they applied:

> **VERBATIM**: "You may use the Services and Content only for personal, noncommercial purposes
> (except as set forth in the App Store Content section below or as otherwise specified by Apple)."

> **VERBATIM**: "You may not use any software, device, automated process, or any similar or
> equivalent manual process to scrape, copy, or perform measurement, analysis, or monitoring of,
> any portion of the Content or Services."

**Assessment: does not apply, but the reasoning should be stated rather than assumed.** These terms
bind a person who has agreed to them in order to use Apple Media Services with an Apple Account.
Pull.fm accesses no Apple Account, agrees to no such terms, and uses an endpoint Apple offers under
a _different_ instrument with a _different_ express permission. The "as otherwise specified by
Apple" carve-out in the first clause is the textual hook: the Search API "Legal" block is Apple
specifying otherwise. A grant that expressly permits a use cannot be nullified by a consumer
contract the developer is not party to.

**Residual risk, disclosed:** an end user streaming an Apple-hosted preview through a third-party
client is in an undefined position under these terms. Nothing here suggests Apple has ever taken
that position, and the preview asset is served with `access-control-allow-origin: *` and no
credential requirement, which is not the behaviour of an asset Apple intends to restrict to
account holders.

### The one that partially applies: Apple Website Terms of Use

Linked from the footer of every Performance Partners page, including the Search API page.

> **VERBATIM** (<https://www.apple.com/legal/internet-services/terms/site.html>): "These Terms and
> Conditions of Use (the "Terms of Use") apply to the Apple web site located at www.apple.com, and
> all associated sites linked to www.apple.com by Apple, its subsidiaries and affiliates, including
> Apple sites around the world (collectively, the "Site")."

> **VERBATIM** (same): "You may not use any "deep-link", "page-scrape", "robot", "spider" or other
> automatic device, program, algorithm or methodology, or any similar or equivalent manual process,
> to access, acquire, copy or monitor any portion of the Site or any Content, or in any way
> reproduce or circumvent the navigational structure or presentation of the Site or any Content, to
> obtain or attempt to obtain any materials, documents or information through any means not
> purposely made available through the Site. Apple reserves the right to bar any such activity."

**Assessment.** The prohibition is qualified by its own final clause: it targets obtaining material
"through any means **not purposely made available**". A documented, keyless, publicly announced JSON
API is the definition of purposely made available. Programmatic use of `/search` and `/lookup` is
therefore outside this prohibition.

**What is inside it:** scraping `music.apple.com` or `itunes.apple.com` HTML pages, or harvesting
any Apple field not returned by the API. Pull.fm does neither. **Keep it that way** - the moment
anyone reaches for an HTML page to fill a gap the API leaves, this clause activates, and unlike the
Promo Content grant it has no offsetting permission.

### Nothing is incorporated by reference

Checked directly: the Search API page contains exactly three outbound links in its body - to
Wikipedia's ISO 3166-1 list, to `json.org`, and to Apple's own EPF documentation page. **It links to
no other terms document.** There is no "subject to the Program Terms", no "see also", no
incorporation clause. The "Legal" block is self-contained. The only other legal text touching the
page is the site-wide footer (Privacy Policy / Terms of Use / Sales and Refunds / Legal), which is
Apple's standard corporate footer and is present on every apple.com page.

### The instrument that does not exist

There is **no separate "iTunes Affiliate Resources" terms document** still published. The historic
home of those terms, `affiliate.itunes.apple.com`, does not resolve (connection failure, curl exit
code 000 - not a 404, the host is gone). Anything citing that URL is citing a dead source. If a
prior note in this repository or elsewhere relies on iTunes Affiliate Resources terms, that
citation is stale.

---

## Q3. Caching

**The question:** does storing the `previewUrl` string in Postgres, indefinitely, violate "streamed
only, and not downloaded, saved, cached, or synchronized"?

**Answer: no.** The URL is not the Promo Content. Three independent lines of evidence, in
increasing order of strength.

### 1. The clause's grammar

"Promo Content" is a defined term. The definition is in the grant's first sentence: "certain
promotional content as may be provided by Apple, including previews of songs and music videos, and
album art". It denotes the _media_ - the audio, the images. Condition (iv)'s verbs ("downloaded,
saved, cached, or synchronized with video") all take that media as their object, and the trailing
qualifier "if such Promo Content includes song or music video previews" confirms the clause is
scoped to the audio itself. "Synchronized with video" is unambiguously an operation on audio, not
on a string.

A URL is a pointer to the Promo Content. Storing it stores no part of the work. This is the same
distinction that makes hotlinking legally different from rehosting.

### 2. Apple instructs us to cache the responses that contain it

On the same page, four paragraphs above the Legal block:

> **VERBATIM** (<https://performance-partners.apple.com/search-api>, Notes): "Large websites should
> set up caching logic for the search and lookup requests sent to the Search API. For an
> illustration, see Caching Architecture later in this document."

`previewUrl` is a field of a `/search` response. Caching the search response - which Apple
affirmatively directs - necessarily means retaining `previewUrl`. Apple cannot be read as
simultaneously instructing developers to cache search responses and prohibiting retention of a
field inside them.

**Disclosed gap (A13):** the "Caching Architecture" section that sentence points to **does not
exist on the live page**. The page ends at the Legal block; there is no such heading anywhere in
the retrieved HTML. The one piece of Apple guidance that would have told us what caching Apple
expects, how long, and of what, is a dangling cross-reference. This is stated rather than
guessed at.

### 3. Apple's own HTTP headers mandate caching, including of the audio

Verified by direct request on 2026-07-28:

- The `/search` response carries `cache-control: max-age=86400`. Apple instructs clients to cache
  the metadata - `previewUrl` included - for 24 hours.
- The preview asset at `audio-ssl.itunes.apple.com` carries `cache-control: public, max-age=25105736`
  - approximately **290 days** - plus `accept-ranges: bytes` and `access-control-allow-origin: *`.

The second one is the interesting one. Apple's CDN explicitly instructs every HTTP client, including
every browser `<audio>` element, to cache the preview audio for the better part of a year. A user
agent that obeys `Cache-Control` will write those bytes to disk. Under a literal reading of
condition (iv), **it is impossible to play an Apple preview in a standards-compliant web client
without violating the clause**, because Apple's own response headers cause the caching.

A clause cannot sensibly be read to prohibit the behaviour the counterparty's own infrastructure
compels. The only coherent construction is that condition (iv) prohibits **making and retaining a
copy of the audio as an asset under your control** - downloading it to a server, rehosting it,
adding it to a media library, syncing it to a device, muxing it with video - and does not reach HTTP
cache behaviour Apple itself directs.

### What is still a real problem: indefinite retention with no revalidation (A6)

The reading above protects storing the URL. It does not protect storing it _forever with no way to
let go of it_.

`track_previews` stores `url_expires_at` as NULL for iTunes rows, documented as "NULL means the URL
is stable (Apple)". True as to signing - the URL carries no HMAC and no expiry parameter, verified.
But "not signed" is not "valid forever":

- Apple removes tracks from the catalogue. Territory rights lapse. Labels pull recordings.
- The grant gives Apple an unconditional recall right: "will remove any Promo Content immediately
  upon request from Apple". A row with no TTL, no revalidation and no purge path makes that right
  operationally hard to honour, which is [A10](#a10-no-takedown-procedure).
- A stale row serves a dead URL to a user and looks like a Pull.fm bug.

**Recommendation:** add a `revalidate_after` timestamp for iTunes rows, distinct from
`url_expires_at`. The distinction matters and the schema should carry it: `url_expires_at` means
"this URL is cryptographically dead after this instant" (Deezer); `revalidate_after` means "this URL
is probably fine but has not been confirmed since this instant" (Apple). Setting the latter to 30-90
days costs almost nothing against a 15/min budget for a catalogue that changes slowly, and it turns
"forever" into "bounded", which is what a recall request needs.

**Do not** shorten it to Apple's 24-hour `max-age`. That figure governs HTTP caches, and honouring it
literally would mean re-resolving every previewed track daily, which the rate limit cannot support
and which no reading of the terms requires.

---

## Q4. Attribution

This question has **two** answers, because Apple imposes two separate requirements and the repo has
only implemented one of them.

### Requirement 1 - the text credit, condition (iii). Implemented, correct.

> **VERBATIM** (condition (iii)): "includes attribution indicating the Promo Content was "provided
> courtesy of iTunes" if such Promo Content includes song or music video previews"

**This is a text string, not a badge and not a logo.** Apple quotes the exact phrase and requires
attribution "indicating" it. Unlike SeatGeek clause 3.1 - which requires a logo and where a text
credit is a breach - there is no artwork requirement here, and no Apple-published artwork exists
that renders this phrase.

For a UI engineer, precisely:

| Item | Requirement                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1  | The visible string must contain **"provided courtesy of iTunes"**. `ITUNES_ATTRIBUTION` is `"Preview provided courtesy of iTunes"`, which contains it. Use that constant; do not retype it. |
| A-2  | Render it in the same view as the preview, visible before or during playback. Not in a settings screen, not behind a disclosure triangle.                                                   |
| A-3  | Do **not** change "iTunes" to "Apple" or "Apple Music". The affiliate contract uses "courtesy of Apple"; our grant says "courtesy of iTunes". We are under the iTunes instrument.           |
| A-4  | No link is required on this string. Apple specifies none.                                                                                                                                   |

### Requirement 2 - the store badge, condition (ii). NOT implemented. This is A1.

> **VERBATIM** (condition (ii)): "is proximate to a "Download on iTunes" or "Download on App Store"
> badge (as approved by Apple) that acts as a link directly to pages within iTunes where consumers
> can purchase the promoted content"

And the Overview restates it in plainer language:

> **VERBATIM** (Overview): "Use of sound samples and other assets from the API must be proximate to
> a store badge."

**This is the SeatGeek-shaped obligation, and it is currently invisible in the codebase.**
`legal/attribution.md` section 3 lists six checks (A-1 to A-6) and **none of them is the badge**.
The `Attribution` interface in `packages/discovery/src/envelope.ts` is `{ source, text, url? }`,
which cannot express "render this artwork, link it here, do not restyle it" - the repo already
recognised this problem for SeatGeek and built `ProviderAttribution` with `logoRequired`,
`logoAssetPage`, `linkUrl` and `logoModification` to solve it. **Apple needs the same treatment,
and for a stronger reason: SeatGeek's logo is an attribution requirement, Apple's badge is a
condition of the licence.** Failing SeatGeek's means an unattributed credit. Failing Apple's means
the preview is unlicensed.

`track_previews` also has no column for the store URL (A2), so even a client that wanted to render
the badge could not build its link on a cache hit. `ItunesClient` already parses `trackViewUrl` into
`ItunesPreview`; it is simply dropped before persistence.

#### Badge specifics, from the iTunes Store Identity Guidelines

Source: <https://www.apple.com/itunes/marketing-on-itunes/identity-guidelines.html>, retrieved in
full, no login required. Asset packs are publicly downloadable (verified: HTTP 200, 5.7 MB zip,
anonymous).

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Guideline clause |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| "Use only Apple-approved badge artwork. Never create your own iTunes Store badge or change the artwork in any way." **(VERBATIM)**                                                                                                                                                                                                                                                                                                                                                                          | 1.1              |
| Use the **SVG** artwork for web/onscreen. (EPS is for print.)                                                                                                                                                                                                                                                                                                                                                                                                                                               | 1.1              |
| "If you use the badge online, you must include a link to the iTunes Store wherever the badge is used." **(VERBATIM)**                                                                                                                                                                                                                                                                                                                                                                                       | 1.3              |
| Use **only one** badge per layout. Place it **below, or to the right of**, the images and copy promoting the content.                                                                                                                                                                                                                                                                                                                                                                                       | 1.4              |
| Keep the badge **smaller than** your other images and copy. "Don't make it the dominant artwork." **(VERBATIM)**                                                                                                                                                                                                                                                                                                                                                                                            | 1.4              |
| **If badges for other content services appear, the iTunes Store badge goes first in the lineup.** Directly relevant to [Q7](#q7-the-link-out).                                                                                                                                                                                                                                                                                                                                                              | 1.4              |
| Minimum clear space: at least **one-tenth the height of the badge**. Nothing inside that space.                                                                                                                                                                                                                                                                                                                                                                                                             | 1.5.1            |
| Minimum size: **30 pixels** for digital use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 1.5.1            |
| "Do not alter the Apple-provided badge artwork in any way. The gray border around the badge is part of the badge artwork and must not be left out." **(VERBATIM)**                                                                                                                                                                                                                                                                                                                                          | 1.5.3            |
| Permitted backgrounds: black or white, solid colour, or an image that does not affect readability.                                                                                                                                                                                                                                                                                                                                                                                                          | 1.5.3            |
| "Don't modify, angle, animate, rotate, or tilt the iTunes Store badge." **(VERBATIM)** Don't use the Apple logo alone. Don't use icons or graphics taken from Apple's website or apps.                                                                                                                                                                                                                                                                                                                      | 1.6              |
| A **lockup** (icon + "Get it on"/"Buy on" type) is an alternative for cramped layouts, but two rules rule it out here. **VERBATIM:** "A lockup cannot be combined with an iTunes Store badge. Use either a lockup or a badge, not both." And **VERBATIM:** "Do not use the iTunes Store lockup along with badges for other music services. Instead, use the iTunes Store badge and place the badge first in the lineup of badges." Pull.fm shows Qobuz and Bandcamp, so: **use the badge, not the lockup.** | 2.3              |

**The dark-mode trap applies here exactly as it does to SeatGeek.** A CSS `filter: invert()`, an
opacity change, or a theme-driven recolour is a modification of the artwork under 1.5.3 and 1.6. The
grey border is part of the asset. If the badge is illegible on a dark background, place it on an
approved background per 1.5.3 - do not filter it.

**A8 - the named badge does not exist.** Condition (ii) names a "Download on iTunes" badge. No such
asset ships. The current Apple-published US/UK pack (verified by downloading and listing it)
contains exactly these SVG variants:

```
US_UK/iTunes_Store_Badge/Buy_on/SVG/US_UK_iTunes_Store_Buy_Badge_RGB_011818.svg
US_UK/iTunes_Store_Badge/Get_it_on/SVG/US_UK_iTunes_Store_Get_Badge_RGB_012618.svg
US_UK/iTunes_Store_Badge/Pre_order_on/...
US_UK/Small_Badge/iTunes_Store_Small_Badge_RGB_012318.svg
```

The guidelines confirm the call-to-action set has moved on:

> **VERBATIM** (1.2): "Apple offers the iTunes Store badge artwork translated into many languages
> for "Buy on," "Pre-order on," and "Get it on.""

So the licence names artwork Apple stopped shipping, and the assets are dated 2018. **Use "Buy on
iTunes"** - it is the closest to the clause's intent, since condition (ii) requires a link to where
consumers can _purchase_. Record the substitution; it is a deviation from the literal words of the
clause forced by Apple's own asset catalogue, and it is one of the things worth asking Apple about.

**A9 - the link target has moved to a different Apple property.** Condition (ii) requires the badge
to link "directly to pages within iTunes". The field the API returns for that purpose no longer
points at iTunes. Verified on 2026-07-28, `trackViewUrl` for a song result:

```
https://music.apple.com/us/album/xtal/1668862636?i=1668862649&uo=4
```

That is an **Apple Music** URL, not an `itunes.apple.com` one. So the literal instruction - iTunes
badge, iTunes link - is not constructible from the API's own output. Options, none perfect:

1. Render the **"Buy on iTunes" badge** linking to `trackViewUrl` as returned. Follows the clause's
   structure; the badge wordmark and the destination host disagree.
2. Render an **Apple Music badge** (from the Apple Music Identity Guidelines / the public toolboxes
   at `tools.applemediaservices.com`) linking to `trackViewUrl`. Internally consistent and matches
   what the user will actually see on arrival; departs from the wording of condition (ii), which
   names an iTunes badge.

**Recommendation: option 1, and ask Apple.** Condition (ii) is the clause we are being judged
against, and following its structure while noting the host drift is the more defensible posture than
substituting a badge from a different guidelines document. Do not use both.

**Also required, and currently missing: the trademark credit line.**

> **VERBATIM** (7.1): "Use the appropriate credit lines in all communications worldwide, listing all
> the Apple trademarks used in your communication. [...] When the iTunes Store badge or lockup is
> used, credit iTunes Store."

> **VERBATIM** (7.1): "Include the credit lines only once in your communication or website."

So: **once** per client - a footer, an about screen, a legal page - a line of the form "iTunes Store
is a trademark of Apple Inc., registered in the U.S. and other countries." This is once per app, not
once per card, and it is separate from the per-preview courtesy string. Clause 7.2 additionally
requires a ™/® symbol on the first mention of an Apple trademark in body copy for
US-only communications, and expressly forbids adding symbols to the badge artwork itself.

---

## Q5. Rate limit

### What Apple actually publishes

One sentence, in one place:

> **VERBATIM** (<https://performance-partners.apple.com/search-api>, Notes): "The Search API is
> limited to approximately 20 calls per minute (subject to change). If you require heavier usage, we
> suggest you consider using our Enterprise Partner Feed (EPF)."

Three things about that sentence deserve attention because the repo's comments go beyond it:

1. **"approximately"** - Apple declines to state a hard number.
2. **"subject to change"** - Apple reserves the right to move it without notice. There is no
   changelog and no versioning on this page; its footer reads "Copyright © 2022 Apple Inc."
3. **It states no scope.** Not per IP, not per application, not per token. **Apple does not say what
   the limit is per.**

**Is the figure current and authoritative, or folklore?** It is authoritative - it is the only thing
Apple has ever published - but it is also **stale and unelaborated**. A dedicated research pass
(see [Research method](#research-method-for-this-section)) found the identical sentence at every
Apple-controlled URL that carries this document, including Apple's Documentation Archive copy marked
**"Updated: 2017-09-19"**. Apple has not revised the number, qualified it, or commented on it
publicly in the nine years since. It is a genuine Apple statement that has been left to rot -
including its onward links: the archived copy still points at `affiliate.itunes.apple.com` for EPF
information, and that host **no longer resolves** (verified: NXDOMAIN).

**Also worth striking from the record: no affiliate token is required to call this endpoint.**
Several third-party API directories state that a Performance Partners account and an `at=` token are
prerequisites for using the Search API. They are not. The `at=` parameter governs commission
attribution on links; Apple's own documentation imposes no authentication requirement on the
endpoint, and an anonymous request succeeds (verified). This corroborates the
[Q2](#q2-which-terms-actually-bind-us) conclusion from a second direction.

### A7: the repo asserts a scope Apple never stated

"per IP" appears in at least six places in the repository as though it were quoted from Apple:

- `packages/upstream/src/itunes/client.ts` - "Apple documents "approximately 20 calls per minute"
  per IP"
- `packages/upstream/src/index.ts`, `packages/upstream/src/cache/store.ts`,
  `packages/upstream/src/quota.test.ts`, `packages/upstream/src/itunes/client.test.ts`
- `docs/UPSTREAM-TERMS.md` L2 - "**per IP**" in bold

**Apple documents no such thing.** The number is correctly quoted; the attribution of scope to Apple
is not. On the research, no Apple employee has ever answered a public question about this API's
enforcement scope - a December 2016 Apple Developer Forums thread asking exactly that
("per device or per app?") has **1,600 views and zero replies**.

**However, the per-IP belief is not baseless - it is well-supported empirically, just not by
Apple.** Multiple independent developer reports describe IP-keyed behaviour: identical queries
succeeding from one host and 403ing from another; a whole office losing access, including from
Safari, after automated traffic from the shared egress. So the correct correction is not "delete
per IP", it is **"stop attributing it to Apple"**:

> Apple states approximately 20 calls per minute, subject to change, and states no scope.
> Independent reports consistently suggest enforcement is keyed to source IP, but Apple has never
> confirmed this and returns no signal that would let a client verify it.

The distinction is load-bearing in one specific direction. If "per IP" is read as an Apple-sanctioned
rule, the obvious optimisation is to spread calls across more egress IPs. That would be
**deliberately structuring around a rate limit**, which is a materially worse posture than
accidentally exceeding one; and on the evidence below it would also expose more shared IPs to
collateral damage. **Do not do it.**

**The existing 15/min budget is correct and should not change.**

### Observed behaviour, and the failure mode

Verified directly on 2026-07-28 with a single anonymous request:

- Keyless access works. HTTP 200, full JSON, no credential of any kind.
- **Apple returns no rate-limit headers.** No `X-RateLimit-*`, no `RateLimit-*`, no `Retry-After`.
  The response carries only Apple internal tracing headers (`x-apple-request-uuid`,
  `x-apple-jingle-correlation-key`, `x-daiquiri-instance`), Akamai cache headers, and
  `cache-control: max-age=86400`.

From the research pass, on the rejection path (developer-empirical, **not** Apple-official):

- **The failure status is HTTP 403, not 429.** The best artifact is a full raw response dump in a
  2023 GitHub issue against `facundoolano/app-store-scraper`: `statusCode: 403`, **empty body**,
  `content-length: 0`, no `Retry-After`, no rate-limit headers, served from an Akamai edge node.
- **429 for this API appears to be folklore.** Every primary artifact the research could verify
  shows 403. The 429 claims trace to (a) content-farm and AI-generated API-guide pages with no
  bibliography, (b) LLM-authored GitHub PR bodies where the status code may be inferred rather than
  observed, and (c) **conflation with two different Apple APIs** - the App Store Connect API, where
  an Apple engineer did document `X-Rate-Limit` and HTTP 429 on a rolling hour, and the
  authenticated Apple Music/MusicKit API. Neither is this endpoint.
- A 403 has been observed arriving **alongside an empty `results` array rather than an error**,
  which will silently poison a naive cache. Worth a specific guard.
- **`/lookup` is rate limited too.** A persistent claim that only `/search` is throttled traces to a
  2016 forum thread and is still repeated in current library documentation. The best primary
  artifact - the 2023 header dump above - is a **`/lookup` 403**. `ItunesClient.lookupTrack` must
  share the same budget and the same backoff as `resolvePreview`; it currently does, via the shared
  `ProviderClient`, and that should stay true.
- **A caveat on the evidence itself, so it is not over-read.** Some widely cited iTunes 403 reports
  come from `search.itunes.apple.com/WebObjects/MZStore.woa/wa/search`, an **undocumented endpoint
  with `X-Apple-Store-Front` headers** that some scraping libraries use. That is a different surface
  from `itunes.apple.com/search`, and its behaviour should not be attributed to ours. The artifacts
  relied on here are from the documented host.
- Block duration is not reliably known. The one dated case ran **3-4 days and self-recovered**; a
  second ran at least 3 days and was never observed to lift because the team gave up. No evidence
  of a permanent ban, and no published reset window.
- Real production consumers converge on treating 403 and 429 as the same signal with a **60-second
  minimum backoff** and a 2-5 second floor between calls.

**Two design consequences.**

1. **The ListenBrainz pattern of driving a limiter from response headers is impossible here.** A
   static local budget is the only available mechanism, which is what `ITUNES_QUOTA` implements.
   That is the right design and the reason should be recorded next to it.
2. **`ProviderClient` must treat a 403 from iTunes as rate limiting, not as an auth failure.** This
   is a real trap: 403 conventionally means "forbidden, do not retry, your credentials are wrong",
   and a client that classifies it that way will either mark iTunes permanently dead or retry it as
   a transient error. Neither is right. The correct handling is: back off hard (60s minimum), do
   not retry within the window, surface `itunes` in `unavailableProviders`, and **never** treat a
   403 with an empty results array as a successful cache-fill. This should be verified against the
   provider client's current status-code classification.

### A14: the real risk is not our call rate, it is our egress IP

This is the finding that changes an operational decision, and it is worse than the rate limit
itself.

The reported thresholds do not describe a clean per-minute token bucket. They scatter in both
directions: one report finds ~20/min works and ~30/min 403s; others push **hundreds of successful
concurrent lookups**; and several report **constant 403s well below the documented limit** - one at
4-6 calls per minute, one at a single call every five minutes. That pattern is consistent with
burst/concurrency shaping plus **source-IP reputation**, not with a published quota.

The best-documented case is directly analogous to Pull.fm's deployment. In **May 2026**, a US
college radio station running a production metadata service on **Railway** logged 11 of 11 outbound
Search API calls returning 403, zero 200s, zero 429s, while operating at roughly **9 calls per
minute - well under Apple's stated 20**. Their leading hypothesis was that Railway shares egress IPs
across tenants and a neighbour had been abusive. It was never confirmed. They abandoned the endpoint
and migrated to the authenticated Apple Music API.

**Pull.fm will run from a hosting provider.** The implication is direct: **a perfectly compliant
15/min budget does not protect against this.** Reputation attaches to the IP, not to our behaviour,
and on shared-egress infrastructure the IP is not solely ours.

What follows from that:

- **Do not treat iTunes unavailability as an incident to escalate.** It may be a neighbour's fault
  and may clear on its own in days. The runbook should say so, or someone will spend a weekend on it.
- **Prefer a dedicated egress IP** for outbound provider traffic where the infrastructure allows it.
  This is the one legitimate IP-related change, and note it is the _opposite_ of the "more IPs for
  more budget" inference in A7 - one stable IP whose reputation is entirely ours.
- **The product must degrade gracefully to no previews at all**, for days, without looking broken.
  Given iTunes is now the only preview source, this is a product-design requirement, not a nicety.
- No AWS/GCP/Azure/Hetzner-specific report was found, and no published Apple blocklist exists. The
  Railway case is one dated, credible datapoint, not a general rule.

**An open question nobody has tested:** the affected team hypothesised that their default
`python-httpx/x.y` User-Agent contributed to the block, but migrated away without testing it. This
cuts against the recommendation in [Q8](#no-identifying-user-agent) to send a descriptive
`PullFM/...` User-Agent, since that is also not a browser string. **Both** positions are unverified.
The reviewer's judgement is still to send the descriptive agent - being identifiable to a human at
Apple is worth more than speculatively imitating a browser, and imitating a browser to evade
traffic shaping is exactly the kind of thing that reads badly in a dispute.

### A15: the documented escape hatch no longer exists for music

Apple's own sentence directs heavy users to the Enterprise Partner Feed. **For music, the EPF is
gone.** Apple moved music metadata to the Apple Music Feed on 2024-07-16 and stated that music data
would no longer be included in the EPF as of **2025-03-17**; the EPF page now states that Apple
Music and iTunes Music data is not available from it. The replacement, Apple Music Feed, **requires
a media services identifier and JWT signing** - it is an authenticated, gated product.

So the Search API documentation points, for our exact use case, at a product that no longer serves
it. There is **no supported higher-volume path for music metadata** available to a non-partner. The
15/min budget behind a persistent cache is not a conservative choice among several; it is the only
option. Design accordingly, and do not plan any feature on the assumption that more Apple throughput
can be bought or applied for.

### Research method for this section

The empirical claims above come from a dedicated research pass over Apple's published documentation
and archive, Apple Developer Forums, GitHub issues and production code in open-source consumers.
Every such claim is labelled developer-empirical rather than Apple-official, and the two are not
mixed. **No requests were made to `itunes.apple.com` in order to test the limit.** Deliberately
breaching a published term in order to document it is not a defensible audit method, and the
resulting gap - we do not know first-hand what our own traffic would trigger - is disclosed rather
than closed.

**What remains genuinely unknown:**

- The enforcement scope. Apple has never stated it; the per-IP reading is inference from consistent
  third-party observation.
- The reset window. No documented figure; 60s is a working heuristic, multi-day blocks are attested.
- Whether a descriptive non-browser User-Agent helps or hurts. Untested by anyone.
- Whether Apple is quietly tightening access to unauthenticated callers. One affected team believes
  so; that is a hypothesis from a single incident, not evidence. But the direction of travel across
  Apple's other music products - EPF retired for music, Apple Music Feed authenticated, MusicKit
  authenticated - is consistently toward gated access, and a prudent architecture treats the keyless
  Search API as something that may not exist in three years.

---

## Q6. Non-commercial status and donations

**There is no Deezer-equivalent clause. This is the clean answer in the review.**

The complete text of the grant is reproduced in [Q1](#the-exact-words-at-issue). It contains:

- no "non-commercial" requirement
- no restriction on receiving money, revenue or compensation
- no restriction on the developer's legal form
- no requirement to be a person rather than a company
- no revenue-sharing, reporting or accounting obligation

Compare what forced Deezer out (`docs/UPSTREAM-TERMS.md` L3): "The Developer agrees that the use of
the Services is strictly limited for a non-commercial purpose and in a non-commercial environment."
Apple wrote nothing of the sort.

**Donations via Open Collective: not restricted by this grant.** A transparent ledger with no donor
benefits is not touched by any of the six conditions. Nothing in the grant conditions the licence on
how the developer is funded.

**Being a 312.dev LLC: irrelevant under this grant.** The word "Developer" is not qualified by legal
form. (This is a materially better position than MetaBrainz, where the supporter-tier test is not
purely revenue-based - see `metabrainz-terms-review.md` F7.)

**Three caveats, none of them blocking:**

1. **Condition (vi) is about the surface, not the funding.** "Not used to promote any other goods or
   services" constrains what appears next to the preview. It says nothing about where operating
   costs come from. Do not conflate the two - the link-out risk in [Q7](#q7-the-link-out) is real
   but it is not a commerciality problem.
2. **The Apple Website Terms of Use restrict Site Content "for any commercial enterprise".** That
   restriction is on copying content _from the Site_, and is displaced for the API by the express
   grant. Not a live issue while Pull.fm takes only what the API returns.
3. **The compliant path and the no-affiliate rule are compatible.** Condition (ii) requires a link
   into Apple's store. It does **not** require an affiliate token - a plain, untagged
   `music.apple.com` link satisfies it completely. There is therefore no tension between fixing A1
   and `docs/PLAN.md`'s locked non-commercial decision. This is worth stating explicitly because the
   instinct on reading "add an Apple store link" is that it must be a monetised one, and it must
   not be.

**The corollary is that the affiliate route is closed, permanently.** The one path to an unambiguous
licence is enrolling in the Performance Partners programme, whose whole mechanism is affiliate-tagged
links. `legal/attribution.md` section 8 forbids affiliate parameters anywhere, ever. So the safest
available legal posture is structurally unavailable to this project by its own constitution. That is
a defensible trade, but it should be a recorded one: **Pull.fm has chosen the ambiguous licence over
the clear one, on purpose, for non-commerciality.**

---

## Q7. The link-out

**Correctly identified as the second-biggest problem. It may be the biggest.**

> **VERBATIM** (condition (vi)): "is not used to promote any other goods or services"

Pull.fm's design places an Apple-supplied preview in the same card as buttons to buy the track at
Qobuz and Bandcamp. Two readings, both available on the text.

### The narrow reading - Pull.fm is fine

"Other goods or services" means goods or services **other than the subject of the Promo Content**.
The grant's purpose clause permits use "for the purposes of promoting the subject of the Promo
Content" - the song. A Qobuz link for the same song promotes the same subject; only the retailer
differs. On this reading (vi) is an anti-piggybacking clause: don't put an Apple preview next to an
advertisement for your VPN, your merch, or an unrelated app.

Apple's own Identity Guidelines supply the strongest support for this reading, and it is stronger
than it first appears:

> **VERBATIM** (iTunes Store Identity Guidelines, 1.4): "If you include the iTunes Store badge along
> with badges for other online content services, place the iTunes Store badge first in the lineup of
> badges."

> **VERBATIM** (2.3): "Do not use the iTunes Store lockup along with badges for other music
> services. Instead, use the iTunes Store badge and place the badge first in the lineup of badges."

Apple wrote **placement rules for competitors' badges appearing alongside theirs**. You do not draft
an ordering rule for a configuration you prohibit. Apple's baseline expectation is a multi-retailer
layout in which Apple comes first.

### The broad reading - Pull.fm is outside the grant

"Other goods or services" means anything other than the promoted content **as sold by Apple**.
Condition (ii) fixes the intended conversion path in the licence itself: a badge linking "directly to
pages within iTunes **where consumers can purchase** the promoted content". The grant's economic
logic is plain - Apple provides a free 30-second sample of a copyrighted work, and in exchange the
sample sits next to a path into Apple's store. Using that sample to route the resulting purchase to
Qobuz inverts the bargain. If (vi) does not cover a competing retailer, it is hard to say what it
covers that (i) does not already cover.

The Overview reinforces it: previews may be used "**only to promote store content**". Not "only to
promote music". Store content.

### The reviewer's judgement

**The narrow reading is more likely correct as a matter of construction, but the broad reading is
what an Apple reviewer looking at a screenshot would see**, and the Identity Guidelines defence has
a weakness worth naming: those guidelines are written for **rights holders promoting their own
content** ("whenever else you promote music that you offer on the iTunes Store", "your music"). A
label deciding which stores to list for its own record is not in the same position as a third party
using Apple's sample to route traffic to Apple's competitors. The guidelines are evidence about
Apple's tolerance for multi-store layouts; they are not a licence term and they do not amend
condition (vi).

**The material fact is that the current design has no Apple link at all.** Under either reading,
"Apple's preview, no Apple link, two competitor buy buttons" is the worst available configuration.
It fails (ii) outright and presents (vi) in its least sympathetic form.

### The mitigation, which is cheap and mostly fixes both

In any view where an iTunes preview can play:

1. Render the **"Buy on iTunes" badge**, linking to the track's `trackViewUrl`, **untagged**.
2. Place it **first** in the acquisition lineup, ahead of Qobuz and Bandcamp - which is Apple's own
   stated ordering rule (IDG 1.4), so following it is affirmative compliance rather than mere
   avoidance.
3. Keep the badge **proximate** to the preview control - same card, same visual group. "Proximate"
   is the word the clause uses; a link three screens away in a "where to buy" modal is not proximate.
4. Respect IDG 1.4's sizing rule: the badge must not be the dominant graphic. Note the mild tension
   with point 2 - "first in the lineup" and "not dominant" are both required, so first in order,
   not largest in size.

After that change, condition (ii) is satisfied literally, and condition (vi) is presented in its
most defensible posture: Apple's badge, first, next to Apple's preview, with alternatives offered
after it. It does not _eliminate_ the (vi) risk - only removing the competitor links would do that,
and that would gut the product's purpose - but it converts "we used their asset to send business
elsewhere" into "we listed Apple first and offered alternatives", which is the configuration Apple's
own guidelines describe.

**Recommendation: make the change, and record the residual risk rather than pretending it is
closed.**

---

## Q8. Anything else that would change a design decision

### A10. No takedown procedure

> **VERBATIM** (grant, final sentence): "Developer shall forward any claims received in connection
> with the Promo Content to Apple immediately upon receipt, and will remove any Promo Content
> immediately upon request from Apple."

Two obligations, neither with a documented owner or path:

- **Forward claims to Apple immediately.** Requires a monitored inbox, a named human, and a route to
  Apple. Apple's only published contact for this material is the Performance Partners support desk,
  which is aimed at enrolled partners. Establishing this route **before** it is needed is the whole
  point.
- **Remove Promo Content immediately on request.** Half-built: `KillSwitch` already lists `itunes`,
  so playback can be disabled globally. What is missing is the ability to purge or suppress a
  **single** track's Promo Content, which is what a real request will ask for. `track_previews` is
  keyed on `(recording_mbid, provider)`, so a single-row delete is trivial - it just needs to be a
  documented, tested runbook step rather than an ad-hoc `DELETE`.

This should be a short section in `RUNBOOK-INCIDENT.md`. It is cheap now and impossible to improvise
under a deadline set by Apple's lawyers.

### A11. Album art is Promo Content too

The grant's definition is "previews of songs and music videos, and album art". `ItunesPreview`
carries `artworkUrl`, populated from `artworkUrl100`. **If any Apple-sourced artwork is rendered,
all six conditions apply to it**, including (ii)'s badge requirement and (i)'s
promotional-page requirement. Condition (iii)'s courtesy string and (iv)'s streaming rule are
expressly limited to song and music-video previews ("if such Promo Content includes song or music
video previews") and so do **not** attach to artwork - but (i), (ii), (v) and (vi) carry no such
limiter and do.

Practical consequence: the badge fix must be scoped to "any view rendering Apple-sourced preview
**or artwork**", not "any view with a play button". Grep showed no current artwork rendering outside
the iTunes and Deezer clients, so this is a scope note to get right now rather than a live breach.

### A12. Storefront is hard-coded to US

`ItunesClient` defaults `country` to `"US"` and nothing overrides it. Two consequences:

- The preview and the store link are US-storefront. A non-US user following a `music.apple.com/us/...`
  link may be redirected, may see different pricing, or may find the content unavailable in their
  territory. Condition (ii) requires the link go to a page "where consumers can purchase the promoted
  content" - for a user outside the US, it may not be.
- Apple's expectation for partners is explicit on this point, and while it does not bind us it
  signals what Apple considers correct:

  > **VERBATIM** (Partnerize T&Cs, Schedule, section 2.1): "With respect to any country at which
  > Partner Property is targeted or from which the Partner Property is accessible (collectively, the
  > "Target Country"), Partner shall select and use only the Promo Content made available through
  > the Program for such Target Country."

Not blocking for a US-first launch. It should be a known limitation with a plan, not a surprise.

### No identifying User-Agent

`ItunesClient` sends only `Accept: application/json`. MusicBrainz gets `PullFM/<version> (ope@312.dev)`
because MusicBrainz requires it; Apple does not. But the asymmetry has a practical cost: an
anonymous client that trips a threshold gets blocked silently, whereas an identifiable one at least
_could_ be contacted. Against an API with no appeals process and no rate-limit headers, being
identifiable is cheap insurance. **Recommendation: send the same descriptive User-Agent to Apple.**

**One disclosed counter-consideration.** The team in the [A14](#a14-the-real-risk-is-not-our-call-rate-it-is-our-egress-ip)
incident suspected their default library User-Agent contributed to being blocked, which would imply
a browser-like string is safer. They never tested it, and nobody else appears to have either, so
both positions are unverified. The recommendation stands anyway: a descriptive agent makes us
contactable, whereas imitating a browser to slip past traffic shaping is the kind of thing that
reads badly if this is ever disputed.

### Terms can change silently

The Search API page carries no version, no changelog and no effective date; its footer says
"Copyright © 2022 Apple Inc." The rate limit is expressly "subject to change". The badge assets are
dated 2018 while the guidelines page carries a 2023 copyright. **This is the same structural risk as
`metabrainz-terms-review.md` F9** - terms defined by pages that can be edited without notice. The
mitigation is the same: put the Search API page and the iTunes Store Identity Guidelines into
whatever quarterly re-read process covers the MetaBrainz documents, and diff them.

### Single point of failure, now with no fallback

Worth stating plainly since Deezer's removal changed the risk profile and no document in the repo
records it yet: Apple can withdraw this at any time, for any reason, with no notice, no appeal and
no SLA, and there is now **no second preview source**. Under the grant Apple can require removal of
Promo Content unilaterally. The product's core interaction has a hard dependency on a revocable
licence from a company that has not been asked and does not know Pull.fm exists.

That is not a reason to stop. It is a reason for the kill-switch path to be tested rather than
merely present, and for someone to have thought in advance about what the product looks like with no
previews at all.

---

## Answers to the three closing questions

### (a) Is our core use case licensed? **Ambiguous, and currently unlicensed as implemented.**

Two findings, and conflating them is the mistake to avoid.

**On the question actually asked - does a discovery app fall within a grant that bars "independent
entertainment value"? - the answer is genuinely ambiguous** and cannot be resolved from Apple's
text. The purpose clause ("for the purposes of promoting the subject of the Promo Content") fits
Pull.fm well. Condition (v) ("not used for independent entertainment value apart from its
promotional purpose") fits it badly. Both are in the same sentence. Apple has not published guidance
reconciling them, and the affiliate contract - where Apple had the opportunity to soften (v) for its
own commercial partners and instead reproduced it verbatim - suggests the clause is meant seriously.
No amount of further reading resolves this; only Apple can.

**On the question of whether the current implementation is inside the grant, the answer is no, and
that is not ambiguous.** The six conditions are conjunctive. Condition (ii) requires an
Apple-approved store badge, proximate to the preview, linking into Apple's store. There is no badge,
no store link in the data model, and no way to express the requirement in the response envelope.
That failure is objective, observable from a screenshot, and independent of how (v) resolves.

The useful framing for a decision-maker: **the ambiguous risk (v) is the one you cannot fix, and the
concrete failure (ii) is the one you can.** Fixing (ii) also materially improves the posture on both
(v) and (vi), because the same change - badge, first, proximate, linked into Apple's store - is the
visible evidence that the preview serves a promotional purpose. It is the single highest-leverage
change available.

### (b) What we must change

**Before any client ships:**

| #   | Change                                                                                                                                                                                                                                                                                          | Finding |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Persist the iTunes store URL. Add a column to `track_previews` for `trackViewUrl`; stop discarding it in the resolver.                                                                                                                                                                          | A2      |
| 2   | Give Apple the richer attribution shape. Extend the envelope so an Apple preview carries badge-required, badge-asset, link-URL and modification-constraint fields, as `ProviderAttribution` already does for SeatGeek.                                                                          | A3      |
| 3   | Render the **"Buy on iTunes"** badge (Apple SVG, unmodified, min 30 px, one-tenth clear space, not dominant) proximate to every preview control, linking untagged to the track's store URL, **first** in the acquisition lineup.                                                                | A1, A4  |
| 4   | Add the badge checks to `legal/attribution.md` section 3. Six checks currently exist there and the badge is in none of them; that section reads as complete and is not.                                                                                                                         | A1      |
| 5   | Add the one-per-client trademark credit line: "iTunes Store is a trademark of Apple Inc., registered in the U.S. and other countries."                                                                                                                                                          | Q4      |
| 6   | Add a `revalidate_after` for iTunes preview rows (30-90 days) and a documented single-track purge path.                                                                                                                                                                                         | A6, A10 |
| 7   | Correct "per IP" in the six code and doc locations. Apple states no scope. Keep the 15/min budget.                                                                                                                                                                                              | A7      |
| 8   | Write the Apple takedown/claim-forwarding procedure into `RUNBOOK-INCIDENT.md`, with a named owner.                                                                                                                                                                                             | A10     |
| 9   | Classify a **403 from iTunes as rate limiting, not auth failure**: 60s minimum backoff, no retry inside the window, surface in `unavailableProviders`, and never cache a 403's empty `results` array as a genuine miss.                                                                         | A14     |
| 10  | Make "iTunes unavailable for days" a supported product state rather than an incident. Previews are now single-sourced, so the feed must degrade to no-preview gracefully, and the runbook must record that a multi-day block may be a shared-egress neighbour's fault and may clear on its own. | A14     |

**Product constraints to write down and hold, for condition (v):**

- No background playback, no lock-screen controls, no autoplay-next, no queue, no playlist of
  previews, no shuffle, no crossfade.
- No view where a preview plays without an acquisition route visible in the same view.
- Any future feature that makes previews more listenable is a compliance decision, not a UX one.

**Cheap and worth doing:** send a descriptive User-Agent to Apple (with the caveat in
[A14](#a14-the-real-risk-is-not-our-call-rate-it-is-our-egress-ip)); add the Search API page and the
iTunes Store Identity Guidelines to the quarterly terms re-read; prefer a dedicated egress IP for
provider traffic if the infrastructure allows it.

**Do not do:** add an affiliate token to the Apple link (breaks `legal/attribution.md` section 8 and
the locked decision in `docs/PLAN.md`); change the courtesy string from "iTunes" to "Apple"; apply
any CSS filter, opacity or recolour to the badge in dark mode; scrape `music.apple.com` or
`itunes.apple.com` HTML for anything the API does not return; add egress IPs to increase iTunes
throughput.

### (c) What warrants asking Apple, and through which channel

Three questions are worth asking, and one is worth asking first.

**Ask 1 (the one that matters).** Does a non-commercial music discovery application, in which users
play a 30-second preview to decide whether to acquire a track and are then offered purchase links
including a "Buy on iTunes" badge linking into the Apple Store, fall within the Promo Content grant
published at performance-partners.apple.com/search-api - specifically condition (v) "independent
entertainment value" and condition (vi) "any other goods or services", given that purchase links to
non-Apple retailers are also offered? Describe the product accurately, including the competitor
links. A favourable answer that was obtained by omitting the Qobuz button is worth nothing.

**Ask 2.** Condition (ii) names a "Download on iTunes" badge, which is no longer in Apple's published
asset set (current variants: "Buy on", "Get it on", "Pre-order on"). Which badge should be used?
And since `trackViewUrl` now returns a `music.apple.com` URL rather than an `itunes.apple.com` one,
should the iTunes Store badge or the Apple Music badge be used with it?

**Ask 3.** Is the "approximately 20 calls per minute" limit enforced per source IP, per application,
or otherwise; and what is the intended behaviour on exceeding it?

**Channel.** There is a real problem here and it should be stated rather than glossed: **Apple
publishes no support channel for non-affiliate Search API users.** Every contact route found leads
into the Performance Partners programme, which requires an accepted application, and Apple states it
is "only accepting a limited number of partners who can drive volume and quality that meet Apple
guidelines" - which Pull.fm, pre-launch and non-commercial, does not.

Options, in order of expected usefulness:

1. **`performance-partners.apple.com/contact-us`** - the programme's contact form. Nominally for
   partners, but it is the only published route to the humans who own this documentation. Ask as a
   developer using the public Search API under its published terms; do not apply to the programme.
   Lowest effort, most likely to reach the right team.
2. **Apple Developer Forums**, in the relevant services topic. Public, searchable, occasionally
   answered by Apple staff. The answer is not authoritative and should not be relied on as consent,
   but the _question_ being public and unanswered is itself a useful record of good faith.
3. **Written legal enquiry to Apple Legal.** Proportionate only if the product is about to launch
   publicly and the (v)/(vi) exposure is judged material. Expect no answer; Apple does not generally
   issue interpretive guidance on this grant.

**Expect silence.** The realistic outcome is no response, and the decision has to be made without
Apple's view. In that case the recommendation stands: make the changes in (b), which move the
product from "objectively outside condition (ii)" to "inside every objective condition, with a
documented and mitigated ambiguity on (v) and (vi)". That is a defensible position to launch from,
and it is a considerably better one than the product is in today.

---

## Source retrieval log

Recorded so a future reader can tell what was read from the source versus inferred. **Every source
listed was retrieved successfully. Nothing in this review is reconstructed from memory or training
data.**

| Source                                                                                                | Method                                 | Result                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `performance-partners.apple.com/search-api`                                                           | curl, browser UA, anonymous            | **HTTP 200, full text read**, including the complete "Legal" block. No login required. This is the controlling document.                                              |
| `developer.apple.com/library/archive/.../iTuneSearchAPI/index.html`                                   | curl, browser UA                       | **HTTP 200, full text read.** Corroborating second Apple copy of the Promo Content clause; differs only by naming the iBooks Store.                                   |
| `performance-partners.apple.com/program-overview`, `/faq`, `/linking`, `/linking-policies`, `/home`   | curl, browser UA                       | **HTTP 200, all five read in full.** Source of the "terms and conditions" link and the affiliate programme's stated entry requirements.                               |
| `apple.co/pp-partnerizetc` -> `docs.partnerize.com/terms_and_conditions/apple_services/2.0/UK/EN.pdf` | curl, redirect followed, `pdftotext`   | **HTTP 200, 854 lines extracted.** Contains the Partnerize Partner T&Cs and, in its Schedule, the "Apple Services Advertiser terms".                                  |
| `docs.partnerize.com/.../2.0/US/EN.pdf`                                                               | curl                                   | Returned `content-type: text/html`, not a PDF. **A US-specific version was not located**; the UK/EN document is the one Apple's own FAQ links to. Disclosed as a gap. |
| `www.apple.com/itunes/marketing-on-itunes/identity-guidelines.html`                                   | curl, browser UA                       | **HTTP 200, full text read**, including sections 1.1-1.6, 2.1-2.7 and 7.1-7.4. No login required.                                                                     |
| iTunes Store badge asset pack (`.../itunes-store-badges/us_uk.zip`)                                   | curl + `unzip -l`                      | **HTTP 200, 5.7 MB, listed.** Confirms the shipped variants are Buy on / Get it on / Pre-order on / Small. **No "Download on" asset exists.**                         |
| `www.apple.com/working-with-apple-services/`                                                          | curl, browser UA                       | **HTTP 200, read.** This is where the affiliate contract's Partner Identity Guidelines URL (`apple.com/itunes/link/`) now redirects.                                  |
| `www.apple.com/legal/internet-services/terms/site.html`                                               | curl, browser UA                       | **HTTP 200, full text read.** Apple Website Terms of Use; scope and anti-scraping clauses quoted.                                                                     |
| `www.apple.com/legal/internet-services/itunes/us/terms.html`                                          | curl, browser UA                       | **HTTP 200, full text read.** Apple Media Services T&Cs; assessed and excluded with reasons.                                                                          |
| `tools.applemediaservices.com`                                                                        | curl, browser UA                       | **HTTP 200, read.** Public, no login. Offers badges and widgets; noted as the alternative asset source for the Apple Music badge option in Q4.                        |
| `affiliate.itunes.apple.com/resources/documentation/...`                                              | curl                                   | **CONNECTION FAILED (curl exit 000).** Host does not resolve. The historic iTunes Affiliate Resources site is gone; any citation to it is stale.                      |
| `itunes.apple.com/search?term=...` (one request)                                                      | curl, anonymous, full response headers | **HTTP 200.** Confirmed keyless access, `cache-control: max-age=86400`, **no rate-limit headers of any kind**, and `trackViewUrl` returning a `music.apple.com` URL.  |
| `audio-ssl.itunes.apple.com/...m4a` (one HEAD)                                                        | curl `-I`, no auth, no referer         | **HTTP 200.** `audio/x-m4p`, 1.2 MB, `accept-ranges: bytes`, `access-control-allow-origin: *`, **`cache-control: public, max-age=25105736`** (~290 days).             |

**Requests made to Apple during this review: two** (one `/search`, one asset `HEAD`), well inside the
15/min budget. No attempt was made to probe the rate limit by exceeding it; deliberately breaching a
term in order to document it is not a defensible audit method.

### The rate-limit evidence in Q5

The empirical claims in [Q5](#q5-rate-limit) come from a separate, dedicated research pass over
Apple's live and archived documentation, the Apple Developer Forums, GitHub issues, and the source
of open-source projects that consume this API in production. Its sourcing rules were the same as
this document's: every claim tagged as Apple-official, developer-empirical, or folklore, with the
URL recorded, and no requests made to `itunes.apple.com`.

Load-bearing artifacts, so a future reader can re-check them without repeating the search:

| Artifact                                                                                               | What it establishes                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `developer.apple.com/library/archive/.../iTuneSearchAPI/Searching.html`, marked **Updated 2017-09-19** | The 20/min sentence is unchanged since 2017 and appears verbatim wherever this document is published.                                                                                |
| `facundoolano/app-store-scraper` issue #194 (2023-07-25)                                               | Full raw response dump of a rejected **`/lookup`** call: HTTP 403, empty body, Akamai edge, **no `Retry-After`, no rate-limit headers**.                                             |
| `WXYC/library-metadata-lookup` issues #443 and #488 (May 2026)                                         | A production service on shared cloud egress, blocked 100% for days at ~9 calls/min - **below** Apple's stated limit.                                                                 |
| Apple Developer Forums threads 66399, 68923, 69955, 90888, 120959, 649165                              | A decade of developer reports of IP-keyed 403s, and **zero Apple-staff replies** on enforcement scope.                                                                               |
| Apple Developer Forums thread 110457 (Nov 2018)                                                        | The Apple-engineer statement documenting `X-Rate-Limit` and HTTP 429 - **for the App Store Connect API**, a different service. This is the likely origin of the 429/header folklore. |
| `performance-partners.apple.com/epf`                                                                   | Music data left the EPF as of 2025-03-17 for the authenticated Apple Music Feed. Basis for [A15](#a15-the-documented-escape-hatch-no-longer-exists-for-music).                       |

**Explicitly rejected as unsourced** and recorded here so they are not re-adopted later: that the
documented failure status is 429; that Apple sends `X-RateLimit-*` or `Retry-After` on this
endpoint; that the real threshold is 300-350 requests per minute; and that an affiliate token is
required to call the API. Each traces to AI-generated or bibliography-free API-directory pages, or
to conflation with the App Store Connect and Apple Music APIs.

**Gaps in the rate-limit research, disclosed:** Reddit, Hacker News and the Wayback Machine were not
reachable from the research tooling, so the historical wording of the page could not be diffed and
community discussion on those platforms is unchecked. No Stack Overflow item from 2023 or later was
surfaced. The block-duration figures rest on a single incident tracker. Nothing was independently
reproduced, by design.

**Not reviewed, out of scope:** the Enterprise Partner Feed licence (partner-gated, not available to
Pull.fm); the Apple Music API and MusicKit terms (not used - MusicKit requires an Apple Developer
Program membership and a paid Apple Music subscription for the end user, and is a different product
from preview playback); the App Store Identity Guidelines (no app icons are used); Apple Podcasts,
Books, TV and News guidelines (no such content is used); Apple's trademark list page (referenced by
clause 7.2 but not needed for the two marks in use).

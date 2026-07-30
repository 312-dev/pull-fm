# Pull.fm Terms of Service and Application End User Licence Agreement

> # THE VOID CLAUSE IS FIXED.
>
> **Section 16 now selects a law and a forum.** 312.dev LLC is organised in
> **Illinois**, supplied by the operator on 2026-07-29, so the governing-law and
> venue placeholders are filled and the dispute framework that the warranty
> disclaimer (11), the liability cap (13) and the indemnity (14) rest on is no
> longer resting on nothing. Section 1 carries the same fact.
>
> **Section 2 now claims a territorial refusal, and the claim was checked before
> it was written.** `apps/bff/src/lib/registration-geo.ts` holds the country
> list, three authentication routes enforce it before the identity provider is
> contacted, and two test suites cover it. Section 2 says what the control does
> and, just as deliberately, what it does not: it refuses account creation rather
> than blocking access, and it is address-based geolocation rather than proof of
> residence. A terms document that said "United States residents only" while
> European sign-ups succeeded would be a false statement in a binding agreement,
> which is worse than the gap it was meant to cover, so the sentence was written
> only after the code was read.
>
> **Before publishing, run:**
>
> ```bash
> node legal/check-publication-blockers.mjs   # or: make legal
> ```
>
> It exits non-zero while any placeholder remains and prints each one with a
> file and line.

> # DRAFT - NOT LEGAL ADVICE, REQUIRES REVIEW
>
> This document was drafted by the operator against the actual behaviour of the
> code in this repository and against the upstream terms recorded in
> [`../docs/UPSTREAM-TERMS.md`](../docs/UPSTREAM-TERMS.md) and
> [`../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md).
> **It has not been reviewed by a lawyer.** It must be before it is published at
> a stable URL or presented to any user, and in particular sections 3, 11, 12,
> 13, and 16 are the ones where a non-lawyer draft is most likely to be wrong or
> unenforceable.
>
> **Placeholders marked `[CONFIRM]` require an operator or counsel decision** and
> must not survive into a published version.
>
> **Why this document is a hard blocker rather than paperwork:** SeatGeek's API
> Terms of Use clause 4.3 requires
>
> > an Application EULA that the Application displays and that each End User must
> > accept before using it, containing terms - expressly including warranty
> > disclaimers and limitations of liability - **at least as protective of the
> > SeatGeek Entities as SeatGeek's own API Terms**, complying with any
> > third-party app-store requirements, and **expressly designating the SeatGeek
> > Entities as third-party beneficiaries entitled to enforce it against End
> > Users directly**; plus (i) all reasonable efforts to enforce it and (ii) no
> > action on behalf of, collection of information from or regarding, or device
> > access for any End User without that End User's affirmative authorisation.
>
> Until that exists, Pull.fm may not ship live event data at all. Sections 8, 9,
> 11, 13 and 14 are that clause discharged, and the third bullet of section 13 is
> where "at least as protective" became a specific number rather than an
> aspiration.
>
> **That wording is quoted, not summarised, and it must stay identical wherever
> it appears.** The full verbatim clause is at
> [`../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md),
> which also records why: until 2026-07-29 this repository rendered the same
> requirement three different ways in three documents, and the one being relied on
> was the shortest of the three, which had dropped the protectiveness standard
> entirely.

**Version:** DRAFT-1 (unpublished)
**Last updated:** 2026-07-30
**Effective:** not yet effective

---

## 1. Who we are and what this covers

Pull.fm ("**Pull.fm**", "**we**", "**us**") is a music discovery service operated
by **312.dev LLC**, a limited liability company organised under the laws of the
**State of Illinois**, United States.

These Terms are a binding agreement between you and 312.dev LLC. They cover:

- the Pull.fm backend API at `api.pull.fm`;
- the Pull.fm client applications distributed as signed GitHub Release assets;
- any personal API token you create.

By creating an account, installing a Pull.fm client, or using the API, you agree
to these Terms. If you do not agree, do not use Pull.fm.

`[OPEN]` **That sentence is still a claim rather than a mechanism, but the gap is
now half the size it was, and the half that remains is named precisely rather
than left as "build a consent gate".** Distribution is a sideloaded app file from
GitHub Releases, so there is no store flow and no installer dialogue in which a
user is shown terms and acts on them.

**What now exists, server-side, and can be relied on:** these documents carry
machine-readable versions and a content digest; the API records who accepted
which version of which document, when, from which session and on which client
build, in an append-only table an UPDATE cannot rewrite; a **material** revision
raises a consent epoch and every user must accept again, while a corrected typo
does not; the API reports what an authenticated user still owes at
`GET /v1/me/consent` and records an acceptance at `POST /v1/me/consent`; and an
authenticated user who has accepted **nothing** is refused every route except
signing out, reading their own account, the consent endpoints themselves, and the
data-subject rights in sections 15 and 19 (export and deletion), which are never
conditioned on accepting these Terms. A user who has accepted an earlier epoch
keeps their read access and is refused writes until they accept the current one.
The record is held server-side rather than in app storage, so it survives a
reinstall.

**What still does not exist, and is what keeps this marker open:** no client
presents the documents. Nothing above obtains assent by itself - a server that
records an acceptance it was told about cannot know that a human was shown
anything - and under Illinois law the interface is the whole question. Two
further things are outstanding and both are prerequisites for the client half:
these documents are not yet published at a stable URL, and the client must fetch
the **canonical document bytes** and echo their digest when it accepts, because
the API refuses to record an acceptance whose digest does not match the version it
publishes. Publishing a rendered page whose bytes differ from the canonical source
would make acceptance impossible rather than merely inconsistent.

Under Illinois law that matters more than the wording of any individual clause.
In `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016), no contract was
formed even where the user completed a **paid** purchase on a page that displayed
the terms, because the interface did not communicate that proceeding was assent.
A sideloaded application with no consent step has a weaker record than that, not
a stronger one.

**If no contract forms, nothing here binds.** Not the limitation of liability in
section 13, not the Illinois governing-law and venue selection in section 16, not
the third-party beneficiary grant in section 9, and not the US-only offering in
section 2. The careful drafting of each is contingent on assent that the product
does not currently obtain.

The remedy is a first-launch consent gate in the client: present these Terms and
the privacy policy, require an affirmative action, and record what was accepted
and when. **The recording half is built** (`packages/db/migrations/0008_legal_consent.sql`,
`apps/bff/src/lib/legal-documents.ts`, `apps/bff/src/routes/v1/consent.ts`). The
**presenting** half is one screen in a client application that does not exist yet,
and it is worth more than any clause in this document, so it is recorded here
rather than left to be discovered after launch. Editing either of these documents
without deciding whether the change is material is a build failure, not a silent
drift, so the versions this marker relies on cannot rot.

**There is now a second, independent, contractual reason for the same screen, and
it was found on 2026-07-29 when SeatGeek's terms were read in full rather than in
paraphrase.** Their clause 4.3 does not merely require that an Application EULA
exist. It requires that the Application **displays** it and that each End User be
**required to accept it before using the Application**, and it separately obliges
us to "use all reasonable efforts to enforce" it and to ensure the Application
"collects any information from or regarding any End User" only where that End User
has "affirmatively authorized or directed" it. So the missing screen is not only a
contract-formation weakness under Illinois law; on the day live events are enabled
it is a **breach of the SeatGeek agreement in three places at once**, and one of
those places (the affirmative-authorisation duty) is not limited to SeatGeek data
at all. Enabling events without it would be worse than leaving events disabled.

**The recording half described above is what makes 4.3(i) dischargeable at all.**
"Use all reasonable efforts to enforce the Application EULA" is not something a
document can do; it needs a system that knows who accepted which version and that
refuses service to someone who has accepted nothing. That system now exists. What
it cannot do is manufacture the acceptance it records, which is the whole of the
remaining gap and the reason this marker stays open.

**Pull.fm is free and non-commercial.** We charge nothing, we sell nothing, we
run no advertising, we take no affiliate or referral revenue, and we do not sell
or share your personal information. This is a locked product constraint recorded
in [`../docs/PLAN.md`](../docs/PLAN.md) section 1a, not a launch promotion. It is
also a condition of several of the upstream licences Pull.fm depends on, so it
cannot change without those licences being renegotiated first.

**Pull.fm is operated by one person.** Section 12 states what that means for
availability in terms we can actually keep.

---

## 2. Eligibility, where Pull.fm is offered, and your account

**Pull.fm is offered to residents of the United States.** We **refuse to create
an account** for anyone who appears to be in the **European Economic Area** (the
27 EU member states plus Iceland, Liechtenstein and Norway), the **United
Kingdom**, or **Switzerland**. Those three are named separately because they are
three separate legal regimes rather than one: the UK has had its own data
protection law since Brexit, and Switzerland was never in the EEA. The refusal
also covers **European Union territory that is reported under its own country
code** rather than its member state's, which is why a sign-up from Reunion or the
Aland Islands is refused as well. `privacy-policy.md` section 9 sets out why this
matters and what it means for which law applies to you.

Four things about that refusal, stated precisely because each of them is a place
this kind of clause usually overstates itself:

- **It refuses registration, not access.** Pull.fm is not switched off in those
  places. If you already have an account it keeps working, your session still
  refreshes, you can still sign out, nothing was deleted, and the rest of the API
  answers normally. What is refused is the creation of a new account.
- **A refused attempt creates nothing and sends nothing.** The check runs before
  we contact our identity provider, so no account is created, no record of your
  address is created at that provider, and no sign-in email is sent to you. You
  get an immediate explanation instead.
- **It is decided from the network address your request arrives from**, as
  reported by our content delivery network. That is the ordinary way this is
  done and it is what we can offer, but it is not perfect: a virtual private
  network or a mis-located address can defeat it in either direction. **We do not
  claim that no resident of those regions can hold an account.** We claim that we
  do not knowingly open one, that we take reasonable measures not to, and that
  this is our stated intent.
- **If we cannot determine where a request comes from, we refuse it.** That
  includes requests over Tor. It is deliberate, because the alternative would
  make the whole thing optional.

You must be at least **16 years old** to use Pull.fm. We do not knowingly
provide the service to anyone younger. If we learn that an account belongs to
someone under 16, we will delete it. **Pull.fm never asks your age**, so this is
a term you agree to rather than something we check;
[`privacy-policy.md`](privacy-policy.md) section 11 states that plainly and says
what follows from it.

Accounts are created through **WorkOS AuthKit**, using an emailed one-time code
("magic link"). That is the whole sign-in surface: social sign-in, passkeys and
passwords are not enabled. **Pull.fm issues no passwords and stores no password
hashes**, by design. `legal/privacy-policy.md` section 3.1 describes the same
surface and the constraints that keep it that way.

You are responsible for the security of the identity provider account you sign
in with, and for any personal API token you create. A personal API token is a
bearer credential: anyone holding it can read your Pull.fm data within its
scopes until it expires or you revoke it.

---

## 3. The software, and the service, are licensed differently

**The software is Apache-2.0. We do not license it to you here, and we cannot
take it back.**

The Pull.fm source code and the compiled client applications we publish are both
licensed under the **Apache License 2.0**. That licence is perpetual,
irrevocable, worldwide, royalty-free, and transferable, and it permits
commercial use. Nothing in these Terms limits it, and nothing in these Terms
should be read as an attempt to. You may keep, copy, modify, redistribute and
sell the application under Apache-2.0, including a version pointed at a server
that is not ours.

An earlier draft of this section granted a "non-transferable, revocable licence"
covering "the hosted service and the compiled client binaries, which the Apache
licence does not". That was wrong on the facts: the binaries **are** distributed
under Apache-2.0. A revocable licence to something already granted irrevocably
is not a restriction, it is a contradiction, and publishing it would have told
you that you had fewer rights than you do.

**What these Terms actually govern is access to the hosted service:** the Pull.fm
API, the accounts it holds, and the data it returns. That access is personal,
non-transferable and revocable, and it is offered to residents of the United
States (see section 2).

The distinction is not academic, so here is the practical shape of it:

- We can suspend or terminate your **account and API access**, and this section
  is the basis on which we do.
- We cannot, and do not claim to, stop you **running the app**. If we terminate
  your access, your copy of the application remains yours under Apache-2.0; it
  simply has no Pull.fm server to talk to.

The conditions below are therefore conditions of using **the hosted service**,
not conditions of your licence to the software. The consequence of breaching one
is losing service access. Several of them exist because our upstream data
providers impose them on us, and we cannot pass on rights we do not hold
(see section 8 and [`attribution.md`](attribution.md)).

When using the hosted service, you may not:

- use the hosted service, or data obtained from it, for any commercial purpose.
  Note the boundary: Apache-2.0 permits commercial use of the **software** and
  this does not restrict that. What is restricted is commercial use of **our
  service and the data it returns**, because our upstream providers licence that
  data to us for non-commercial use and we cannot sublicense more than we hold;
- resell, sublicense, or provide Pull.fm's output as a service to others;
- remove, obscure, alter, or fail to render any attribution, credit, logo, or
  link that Pull.fm supplies with data (see section 8 and
  [`attribution.md`](attribution.md));
- circumvent rate limits, quotas, or access controls;
- scrape, bulk-download, or systematically extract data from Pull.fm;
- use Pull.fm to build or train a machine learning model, or to populate a
  search engine, directory, dataset, or index;
- probe, scan, or test the security of the service other than as permitted by
  our [security policy](../SECURITY.md), which includes a safe harbour for good
  faith research.

Resolved 2026-07-29: the owner confirmed the compiled client binaries **are**
distributed under Apache-2.0, so this section was rewritten to govern the hosted
service alone.

---

## 4. Personal API tokens

You may create read-only personal API tokens to access **your own** data.

- Tokens are read-only and scoped. They cannot delete your account, export your
  personal data, create or list other tokens, modify your wishlist, or touch
  your connected third-party accounts.
- Every token expires (default 90 days, maximum 365). You may revoke or rotate
  one at any time; revocation takes effect on the next request.
- You are limited to 10 live tokens.
- We store only a SHA-256 digest of the token, so we cannot recover or re-display
  it. If you lose it, rotate it.

**Tokens do not grant a data licence.** The rules in sections 3, 7, and 8 apply
in full to anything you retrieve with a token. In particular, feeding
token-retrieved data into a machine learning system, a public dataset, or a
search index is prohibited.

**Live event data is not available through a personal API token**, and this is a
contractual restriction rather than a product choice. See section 8.

---

## 5. Connecting third-party accounts

Pull.fm can connect to your **ListenBrainz** and **Last.fm** accounts to produce
recommendations. When you connect one, you authorise us to store a credential
for that service and to use it on your behalf for that purpose.

- Those credentials are encrypted at rest (AES-256-GCM envelope encryption) and
  are never included in a data export, a log, an error message, or a support
  transcript. [`privacy-policy.md`](privacy-policy.md) section 5 explains why the
  export excludes them.
- You may disconnect a service at any time, which deletes our stored credential.
- Your relationship with ListenBrainz and Last.fm is governed by **their** terms,
  not ours. We are not responsible for their services, their availability, or
  what they do with your data on their side.
- **Revoke at the source too.** Disconnecting at Pull.fm deletes our copy of the
  credential. If you also want the credential itself invalidated, revoke it in
  your account settings at that provider. Last.fm session keys in particular do
  not expire on their own.

---

## 6. Your content

You own what you put into Pull.fm (wishlist entries, notes, display name). You
grant us only the licence needed to operate the service for you: to store,
process, and display that content back to you.

We do not publish your data, sell it, share it with advertisers, or use it to
train models. There is no public profile, no social feed, and no sharing surface.

---

## 7. Data from third-party sources

Pull.fm assembles data from **ListenBrainz, MusicBrainz, Last.fm, Apple/iTunes,
Deezer, and SeatGeek**. That data belongs to those providers, is licensed to us
on limited terms, and is provided to you subject to the same limits.

You agree that:

- you will not copy, redistribute, republish, sell, or systematically store data
  obtained from Pull.fm that originates with any of those providers;
- you will not use it to build a competing catalogue, dataset, index, or
  directory;
- you will not use it to train, fine-tune, ground, or evaluate a machine
  learning model;
- you will render every attribution, credit, logo, and link that Pull.fm
  supplies alongside the data, unmodified except as expressly permitted;
- **you will not add affiliate, referral, or tracking parameters** to any
  outbound link Pull.fm provides. Doing so breaches the Last.fm, Deezer, and
  Apple terms simultaneously and would end Pull.fm's access to all three.

Music previews are provided by **Apple/iTunes** and **Deezer** and are for
preview purposes only. You may not download, record, save, cache, or
redistribute preview audio.

If a provider terminates or restricts our access, the corresponding part of
Pull.fm stops working. We have no control over that and no obligation to
replace it.

---

## 8. Live event data and SeatGeek

**This section is required by SeatGeek's API Terms of Use clause 4.3 and its
restrictions bind you directly.**

**Current status, stated so this section is not read as a description of a
feature that exists.** Live event data is **not served today**:
`GET /v1/artists/{mbid}/events` returns HTTP 501 and no events provider is
enabled on this deployment. This section exists because SeatGeek clause 4.3
makes an Application EULA containing these terms a **precondition of enabling it
at all**, and because the terms must be in force before the first event is
served rather than after.

When enabled, live event information in Pull.fm is supplied by **SeatGeek**
("**SeatGeek Materials**"). In addition to everything in section 7, you specifically agree
that you will **not**:

1. **systematically download, scrape, harvest, or store** SeatGeek Materials, in
   whole or in part, whether manually or by automated means;
2. make SeatGeek Materials available to, or use them in connection with, **any
   search engine, directory, dataset, index, or any artificial intelligence or
   machine learning application or model**, including by pasting them into or
   retrieving them for such a system;
3. use SeatGeek Materials for any **competitive purpose**, including price
   comparison, ticket aggregation, market analysis, or operating or supporting a
   **secondary ticket marketplace**;
4. remove, obscure, alter, crop, recolour, or otherwise modify the **SeatGeek
   logo** or its link, or display SeatGeek Materials anywhere the logo is not
   displayed and linked to <https://seatgeek.com>. Proportional resizing of the
   logo is the only modification permitted;
5. display, invent, estimate, or infer **ticket prices** in connection with
   SeatGeek Materials. SeatGeek supplies none;
6. use SeatGeek Materials for any **commercial purpose**, or in any way that
   generates revenue for you;
7. submit **personal data** (including precise location coordinates, postal
   codes, email addresses, or names of other people) through any Pull.fm feature
   that queries live events. Pull.fm's events interface accepts a city name only,
   and the backend rejects coordinate-shaped input;
8. use SeatGeek Materials in any way that would breach SeatGeek's own published
   terms if you were their direct licensee.

**Access restrictions we enforce.** SeatGeek-derived data is not exposed through
personal API tokens, is not included in a data export, is not served on any
unauthenticated or public route, and is not included in any feed cached or
indexable by a crawler. If you find a way to reach it through one of those paths,
that is a bug and we ask you to report it under our
[security policy](../SECURITY.md).

**No warranty on events.** Event data is provided by SeatGeek "as is". Times,
venues, line-ups, and availability change. Confirm with the venue or SeatGeek
before relying on anything. Our own agreement with SeatGeek caps their total
liability to us at **fifty United States dollars**, so nothing in Pull.fm is
designed to depend on their availability, and neither should anything you do.
Section 13 applies the same figure to any claim you might have against them
through us.

---

## 9. Third-party beneficiaries

**SeatGeek, Inc. and its affiliates, subsidiaries, parents, successors, and
assigns (collectively, the "SeatGeek Entities") are express third-party
beneficiaries of these Terms.**

The SeatGeek Entities are entitled to **enforce these Terms directly against
you**, in their own name, with respect to any provision that concerns SeatGeek
Materials, including without limitation section 7, section 8, section 11
(disclaimer of warranties), section 13 (limitation of liability), and section 14
(indemnity). No consent from the SeatGeek Entities is required for any amendment
of these Terms, but no amendment may reduce the protections these Terms afford
the SeatGeek Entities below those in SeatGeek's own API Terms of Use.

<!--
CORRECTED 2026-07-29, and the correction is not cosmetic.

This enumeration read "section 12 (limitation of liability)". Section 12 is
"Availability, and the honest service level"; limitation of liability is section
13. So the clause that EXTENDS protection to the SeatGeek Entities pointed at the
wrong section, and pointed away from the cap.

Two reasons it mattered more than a typo.

First, it contradicted this document's own theory of compliance. The CONFIRM note
below asks counsel to confirm that the combination of sections 7, 8, 9, 11, 13
and 14 satisfies SeatGeek's "at least as protective" requirement, while section 9
itself enumerated 12 rather than 13.

Second, it is the species of defect that decided Sosa v. Onfido, 8 F.4th 631 (7th
Cir. 2021), where a vendor could not enforce an app operator's terms because the
limitation-of-liability clause protected "OfferUp providers", defined as
"affiliates [and] licensors", and the court held Onfido was neither. Illinois
demands that third-party benefit be practically an express declaration, so a
mislabelled cross-reference in the clause doing the extending is exactly the wrong
place to be imprecise.

The protection probably survived anyway, because section 13 independently extends
the same limitations to the SeatGeek Entities by name. That is a reason to fix the
reference, not a reason to have relied on it. Section 14 is added because it
already names the SeatGeek Entities and was missing from this list.
-->

Except as stated in this section, these Terms create no rights in any person who
is not a party to them.

`[CONFIRM with counsel: that this clause is drafted so as to be effective under Illinois law, which section 16 now selects, and that "at least as protective of the SeatGeek Entities as the terms hereof" under SeatGeek clause 4.3 is satisfied by the combination of sections 7, 8, 9, 11, 13, and 14. Three specific questions, now that the SeatGeek terms have been read rather than paraphrased. First, whether the USD 50 cap in the third bullet of section 13 discharges 4.3's express reference to "limitations of liability" given that SeatGeek's own clause 8.2 caps them at exactly USD 50, so we match rather than better it. Second, whether "at least as protective" reaches CONSPICUOUSNESS as well as substance: their 8.2 is in capitals, ours now is too for the SeatGeek bullet only, and under Illinois law a limitation of liability must be conspicuous to be enforceable at all. Third, whether section 9 plus section 13 together survive Sosa v. Onfido, 8 F.4th 631, which turned on a third party falling outside the defined class the limitation protected. This is the specific judgement a non-lawyer cannot make and it is the whole point of the clause.]`

---

## 10. Acceptable use

Do not:

- access another person's account or data, or attempt to;
- interfere with, overload, or degrade the service or its infrastructure;
- use Pull.fm to violate any law, or any third party's rights;
- misrepresent yourself, or use Pull.fm to impersonate anyone;
- automate the service beyond your own personal use, or run it as a shared
  backend for other people.

We may suspend or terminate access for a breach of this section, immediately and
without notice where the breach threatens the service, other users, or our
upstream licences.

---

## 11. Disclaimer of warranties

**Pull.fm is provided "as is" and "as available", with no warranty of any kind.**
To the maximum extent permitted by law, we and our suppliers (including the
SeatGeek Entities and every other upstream provider named in section 7) disclaim
all warranties, express, implied, or statutory, including any implied warranty of
merchantability, fitness for a particular purpose, title, accuracy, and
non-infringement.

We do not warrant that Pull.fm will be available, uninterrupted, timely, secure,
or error-free, or that any data it shows you is accurate or complete. Metadata,
recommendations, previews, and event listings come from third parties and are
frequently wrong in ordinary ways.

Some jurisdictions do not allow the exclusion of implied warranties, so parts of
this section may not apply to you.

---

## 12. Availability, and the honest service level

**Pull.fm makes no availability commitment.** There is no SLA, no uptime
guarantee, no support commitment, and no 24/7 response.

Stated plainly, because a promise nobody can keep is worse than no promise:

- Pull.fm is operated by **one person**, with no on-call rotation.
- Alerts do not page a human. The system is designed to **degrade automatically**
  rather than to summon someone: restart policies, an external health check that
  can enable a maintenance mode, and a read-only degraded mode.
- Outages may last hours or, during a "vacation mode" freeze, longer.
- Security reports are triaged on the timetable published in
  [`../SECURITY.md`](../SECURITY.md), which is measured in business days.
- We may change, suspend, or discontinue any part of Pull.fm, including the whole
  of it, at any time and without notice. If we shut Pull.fm down, we will make a
  reasonable effort to give notice and time to export your data, but we do not
  promise it.

Because Pull.fm is free, you are not paying for availability and we are not
selling it.

---

## 13. Limitation of liability

To the maximum extent permitted by law:

- We are **not liable** for any indirect, incidental, special, consequential,
  exemplary, or punitive damages, or for lost profits, lost data, or loss of
  goodwill, arising out of or relating to Pull.fm, on any theory of liability,
  even if we have been advised of the possibility.
- Our **total aggregate liability** to you for all claims relating to Pull.fm is
  limited to **one hundred United States dollars (USD 100)**.
- The same limitations apply, to the same extent, for the benefit of the
  **SeatGeek Entities** and every other upstream provider named in section 7.
- **THE MAXIMUM AGGREGATE LIABILITY OF THE SEATGEEK ENTITIES FOR ALL DAMAGES,
  LOSSES, AND CAUSES OF ACTION IN CONNECTION WITH SEATGEEK MATERIALS, WHETHER IN
  CONTRACT, TORT (INCLUDING NEGLIGENCE), OR OTHERWISE, IS FIFTY UNITED STATES
  DOLLARS (USD 50.00).** This is lower than our own cap, deliberately, and it is
  the figure SeatGeek's own API Terms of Use set for themselves.

Some jurisdictions do not allow these limitations, so parts of this section may
not apply to you. Nothing in these Terms limits liability that cannot lawfully be
limited, including for fraud, or for death or personal injury caused by
negligence.

<!--
THE SEATGEEK CAP WAS USD 100 UNTIL 2026-07-29 AND THAT WAS A BREACH OF THE
CLAUSE THIS WHOLE DOCUMENT EXISTS TO SATISFY.

WHAT WAS WRONG. This section capped our liability at USD 100 and then extended
"the same limitations" to the SeatGeek Entities by name. So the number protecting
them was USD 100.

SeatGeek's API Terms of Use clause 8.2 caps THEIR OWN maximum aggregate liability
at USD 50, verbatim and in capitals. Clause 4.3 requires our Application EULA to
contain terms "at least as protective of the SeatGeek Entities as the terms
hereof" and names "limitations of liability" as an express example of what it
means by that. A USD 100 exposure is twice the USD 50 exposure their own terms
permit, so the clause extending our protection to them left them LESS protected
than the contract requires, in the one respect 4.3 calls out by name.

WHY THIS WAS INVISIBLE FOR SO LONG. Nobody had read clause 8.2. Every prior
analysis in this repository worked from a paraphrase of the terms in which 4.3
was not marked verbatim and 8.2 was mis-numbered as "9.2" and reduced to "SeatGeek's
total liability is capped at fifty dollars" - a sentence read as a fact about
THEIR risk appetite rather than as a ceiling on OURS. The connection between
"their cap is 50" and "so our cap for them cannot be 100" needs both clauses on
the same page, and until 2026-07-29 they never were. The full text is now
transcribed at packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md.

WHY THIS SHAPE, and not the three alternatives that were considered.

  Lowering OUR cap to 50 as well. Rejected: nothing requires it, it reduces what
  a user of a free service can recover from us, and it would have been a silent
  change to the operator's own risk position made as a side effect of a vendor
  compliance fix.

  Capping "our suppliers" generally at 50. Rejected: the other upstream providers
  impose no such number, and inventing one for them makes this document assert a
  contractual position that no contract supports.

  Making the SeatGeek figure "the lesser of USD 50 or the amount permitted by
  law". Rejected as drafting theatre: the trailing paragraph of this section
  already says that limitations that cannot lawfully be applied do not apply.

  So the shape is a THIRD bullet that is specific to the SeatGeek Entities and
  strictly lower, leaving the general rule intact. Capitals because SeatGeek's own
  8.2 is in capitals and conspicuousness is plausibly part of what "at least as
  protective" buys; the CONFIRM in section 9 now asks counsel about exactly that.

DO NOT "TIDY" THIS INTO THE BULLET ABOVE. A single bullet that reads "USD 100,
or USD 50 for the SeatGeek Entities" is the same sentence and a worse one: the
protection this clause extends to a third-party beneficiary should be findable by
searching for that beneficiary's name.

IF SEATGEEK CHANGE 8.2, THIS NUMBER MOVES WITH IT, DOWNWARD ONLY. Section 1 of
their terms lets them change the terms at any time with continued use as
acceptance, and if their cap on themselves ever drops below 50 this bullet is
immediately non-compliant with no notice to us. That is one of the reasons the
vendor-spec file says to re-audit quarterly.
-->

---

## 14. Indemnity

You will indemnify and hold harmless 312.dev LLC, its members and personnel, and
**the SeatGeek Entities**, against any claim, demand, loss, or expense (including
reasonable legal fees) arising out of your breach of these Terms, your misuse of
Pull.fm, or your use of data obtained through Pull.fm in a way sections 3, 7, or
8 prohibit.

---

## 15. Termination

You may stop using Pull.fm at any time and delete your account with
`DELETE /v1/me`, or from the account screen in a client. Deletion is
irreversible; see [`privacy-policy.md`](privacy-policy.md) section 7 for exactly
what it removes and what remains in backups.

We may suspend or terminate your access at any time for breach of these Terms,
to protect the service or its users, or if an upstream provider requires it.

Sections 6 (your content licence, as to content already lawfully processed), 7,
8, 9, 11, 13, 14, and 16 survive termination.

---

## 16. Governing law and disputes

> ### This section is no longer void, and one thing about it is deliberate
>
> Both placeholders are filled: **312.dev LLC is organised in Illinois**, so
> Illinois law governs and the Illinois courts are the forum. The warranty
> disclaimer (11), the liability cap (13) and the indemnity (14) now rest on a
> choice of law that chose something.
>
> **No county is named, on purpose.** A venue clause is enforceable when it fixes
> a state and a court system, and naming a county would have meant guessing the
> LLC's principal place of business, which nobody has confirmed. Note also that
> Illinois has **two** federal judicial districts, Northern and Southern, so
> "the Northern District" would have been a guess as well. If the operator wants
> a specific county and district, this clause can be narrowed later without
> reopening anything.

These Terms are governed by the laws of the **State of Illinois**, United States,
without regard to its conflict-of-laws rules. The exclusive venue for any dispute
arising out of or relating to these Terms or to Pull.fm is the **state and
federal courts located in the State of Illinois**, and you and we each consent to
personal jurisdiction and venue in those courts and waive any objection to them
on grounds of inconvenient forum.

If you are a consumer resident in a jurisdiction whose law gives you a
non-waivable right to the protection of your local law or to bring proceedings in
your local courts, nothing in this section removes that right.

**Decided 2026-07-29 by the controller: no arbitration clause and no
class-action waiver.** This section stays as drafted. The reasoning is recorded
here because the decision should be re-examined on its premises rather than
re-argued from scratch:

- **The forum costs more than the liability it would protect.** The cap in
  section 13 is USD 100. Business-side arbitration fees exceed that by roughly
  12x to 35x at every scale, and there is no number of claimants at which
  arbitrating is cheaper than simply paying each claimant the cap. AAA also
  charges an annual consumer-clause registry fee in perpetuity whether or not
  anyone ever files, which for a service with no revenue is a subscription
  bought to obtain a worse outcome.
- **The Illinois-specific reason to want one does not apply.** BIPA
  (740 ILCS 14) carries a private right of action, and a class-action waiver is
  the standard defence against it. But BIPA's section 10 definition is a closed
  list of biometric identifiers that expressly excludes photographs, and every
  section 15 duty is conditioned on collecting or possessing one. This service
  collects none, verified against the schema and the auth flow, so there is no
  duty and nothing to waive.
- **The external pressure is absent, and this is now checked rather than
  assumed.** SeatGeek clause 4.3 requires terms "at least as protective" as
  theirs, so if their API terms compelled arbitration this section might have had
  to match. They do not. Their clause 12.2 selects New York law and the exclusive
  venue of the state and federal courts of New York County, and contains **no
  arbitration clause and no class-action waiver**. So the requirement we are
  matching does not include one, and our omission cannot fall short of it.

  **An earlier version of this bullet said their terms "could not be read", and
  that was true when it was written.** Every automated fetch of `seatgeek.com`
  returns 403, including its public press page, so this was recorded as an input
  that was absent rather than satisfied. It turned out to be blanket bot-blocking
  rather than a login wall: the operator opened the page in an ordinary browser
  on 2026-07-29 and transcribed the clauses, which is why the verbatim text now
  sits in
  [`../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md).
  Leaving the old sentence would have had this document assert its own source was
  unreadable in the same revision that quotes it.

**RE-OPEN THIS IF EITHER PREMISE CHANGES**, and both are foreseeable. If a
feature ever touches voice, face or fingerprint data, BIPA attaches and this
calculation inverts. If the service ever charges money, the cap and the
cost-benefit both move. Note that adding a clause later binds only users who
accept the amended terms, so this is cheap now and expensive to reverse.

If one is ever added: name **JAMS** and expressly invoke its Mass Arbitration
Procedures, which charge a flat filing fee regardless of case count, rather than
AAA, which charges per case and scales linearly against the defendant. Include an
express bar on class arbitration and state that the waiver is non-severable,
because _Kinkel_ severed a waiver and enforced the clause without it, sending the
defendant into class arbitration.

---

## 17. Changes to these Terms

We may update these Terms. When we do, we will change the "Last updated" date and
publish the new version at the same stable URL, and the change history is visible
in this repository's git log, which is public.

**A material change requires you to accept it. We do not treat continuing to use
Pull.fm as acceptance of one.** When we publish a material revision, Pull.fm asks
you to read it and accept it, and until you do:

- **you keep read access.** Your account is not suspended and nothing is deleted.
  A revision is our act, not yours, and locking you out of your own data because
  we rewrote a document would be a penalty for something you did not do.
- **changes you make are refused.** You may not add to your wishlist, mint a
  token, or connect an account, because those are the things the Terms govern and
  we do not have your agreement to the version that would govern them.
- **you may always leave.** Export and deletion keep working. They are never
  conditioned on accepting anything, which is stated in
  [`privacy-policy.md`](privacy-policy.md) and enforced in the code.

A change that is **not** material does not ask anything of you. That distinction
is not ours to make loosely: every published revision is recorded with a version,
a digest of its exact text, and a flag saying whether it was material, in an
append-only table whose rows cannot be edited afterwards. Marking a material
change as cosmetic to avoid asking you is therefore a thing we would have to do on
the record.

> **This clause used to read: "Continuing to use Pull.fm after a change takes
> effect means you accept it."** It was replaced for two reasons, and the second
> is the one that matters.
>
> First, that is the arrangement that failed in `Sgouros v. TransUnion Corp.`, 817
> F.3d 1029 (7th Cir. 2016), which is Seventh Circuit law over Illinois and
> therefore over these Terms. A court declined to find a contract there even
> though the terms were displayed and the user completed a paid purchase, because
> the interface did not communicate that proceeding was assent. Continued use
> communicates less than that, not more.
>
> Second, **it described a weaker mechanism than the one Pull.fm actually
> implements**, which made the sentence untrue about our own system. The service
> does not infer your agreement from continued use; it stops accepting your
> changes and asks. So the old clause simultaneously relied on a theory a court
> rejected and understated the control that makes the theory unnecessary. Both
> halves are fixed by describing what the code does.

---

## 18. Miscellaneous

- **Entire agreement.** These Terms and the [Privacy Policy](privacy-policy.md)
  are the entire agreement between you and us about Pull.fm.
- **Severability.** If a provision is unenforceable, the rest stands.
- **No waiver.** Not enforcing a provision once does not waive it.
- **Assignment.** You may not assign these Terms. We may assign them to a
  successor of the business.

---

## 19. Contact

**312.dev LLC**, Illinois, United States
Email: `ope@312.dev`
Security reports: see [`../SECURITY.md`](../SECURITY.md)

**No postal address is published, and that is a decision rather than an
oversight.** [`privacy-policy.md`](privacy-policy.md) section 2 records what was
checked before making it, and names the two events that reverse it: entering an
app store, and sending a first marketing email, which is when CAN-SPAM's physical
address requirement attaches.

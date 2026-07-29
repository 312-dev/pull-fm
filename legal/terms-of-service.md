# Pull.fm Terms of Service and Application End User Licence Agreement

> # STOP. THIS DOCUMENT CANNOT BE PUBLISHED.
>
> **Section 16 selects no governing law and no venue.** Both are still
> placeholders. Published as written, **the dispute framework is void**: there is
> no chosen law, no forum, and no consent to jurisdiction, and sections 11, 12
> and 13 (warranty disclaimer, liability cap, indemnity) are left resting on a
> choice-of-law clause that chose nothing.
>
> **This is not a drafting decision and it must not be guessed.** The controller
> is **312.dev LLC**, and its state of organisation is a fact about that company:
> read it off the certificate of formation or the registered-agent record. Whoever
> publishes this is the person who knows it; the drafter did not.
>
> Section 1 has the same placeholder, for the same fact.
>
> **Before publishing, run:**
>
> ```bash
> node legal/check-publication-blockers.mjs   # or: make legal
> ```
>
> It exits non-zero while any placeholder remains and prints each one with a
> file and line. It currently reports two `VOID IF PUBLISHED` markers, both in
> section 16.

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
> Terms of Use clause 4.3 requires an Application EULA containing terms at least
> as protective of SeatGeek as those API terms, and requires that the SeatGeek
> Entities be expressly designated as third-party beneficiaries entitled to
> enforce it against end users. Until that exists, Pull.fm may not ship live
> event data at all. Section 8 and section 9 are that clause discharged.

**Version:** DRAFT-0 (unpublished)
**Last updated:** 2026-07-28
**Effective:** not yet effective

---

## 1. Who we are and what this covers

Pull.fm ("**Pull.fm**", "**we**", "**us**") is a music discovery service operated
by **312.dev LLC**, a limited liability company organised under the laws of
`[CONFIRM: state of organisation]`, United States.

> **This placeholder identifies the party you would be contracting with, and it
> also settles section 16.** It is one fact, needed in three places: here,
> section 16's governing law, and section 16's venue. See the notice at the top
> of this document.

These Terms are a binding agreement between you and 312.dev LLC. They cover:

- the Pull.fm backend API at `api.pull.fm`;
- the Pull.fm client applications distributed as signed GitHub Release assets;
- any personal API token you create.

By creating an account, installing a Pull.fm client, or using the API, you agree
to these Terms. If you do not agree, do not use Pull.fm.

**Pull.fm is free and non-commercial.** We charge nothing, we sell nothing, we
run no advertising, we take no affiliate or referral revenue, and we do not sell
or share your personal information. This is a locked product constraint recorded
in [`../docs/PLAN.md`](../docs/PLAN.md) section 1a, not a launch promotion. It is
also a condition of several of the upstream licences Pull.fm depends on, so it
cannot change without those licences being renegotiated first.

**Pull.fm is operated by one person.** Section 12 states what that means for
availability in terms we can actually keep.

---

## 2. Eligibility and your account

You must be at least **16 years old** to use Pull.fm. We do not knowingly
provide the service to anyone younger. If we learn that an account belongs to
someone under 16, we will delete it.

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

## 3. Licence to use Pull.fm clients

Subject to these Terms, we grant you a **personal, non-exclusive,
non-transferable, non-sublicensable, revocable licence** to install and use the
Pull.fm client applications on devices you own or control, for your own
non-commercial use.

The Pull.fm source code in this repository is separately licensed under the
**Apache License 2.0**, and nothing in this section restricts rights granted to
you by that licence in respect of the source code. This section governs the
**hosted service and the compiled client binaries**, which the Apache licence
does not.

You may not:

- use Pull.fm, or data obtained from it, for any commercial purpose;
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

`[CONFIRM: whether the compiled client binaries are themselves distributed under
Apache-2.0, in which case the "non-transferable, revocable" framing above is
inconsistent with the licence actually granted and this section must be rewritten
to cover only the hosted service.]`

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
before relying on anything. Our own agreement with SeatGeek caps their liability
to us at a nominal amount, so nothing in Pull.fm is designed to depend on their
availability, and neither should anything you do.

---

## 9. Third-party beneficiaries

**SeatGeek, Inc. and its affiliates, subsidiaries, parents, successors, and
assigns (collectively, the "SeatGeek Entities") are express third-party
beneficiaries of these Terms.**

The SeatGeek Entities are entitled to **enforce these Terms directly against
you**, in their own name, with respect to any provision that concerns SeatGeek
Materials, including without limitation section 7, section 8, section 11
(disclaimer), and section 12 (limitation of liability). No consent from the
SeatGeek Entities is required for any amendment of these Terms, but no amendment
may reduce the protections these Terms afford the SeatGeek Entities below those
in SeatGeek's own API Terms of Use.

Except as stated in this section, these Terms create no rights in any person who
is not a party to them.

`[CONFIRM with counsel: that this clause is drafted so as to be effective under
the governing law chosen in section 16, and that "at least as protective as"
under SeatGeek clause 4.3 is satisfied by the combination of sections 7, 8, 9,
11, 12, and 13. This is the specific judgement a non-lawyer cannot make and it is
the whole point of the clause.]`

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

Some jurisdictions do not allow these limitations, so parts of this section may
not apply to you. Nothing in these Terms limits liability that cannot lawfully be
limited, including for fraud, or for death or personal injury caused by
negligence.

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

> ### THIS SECTION IS VOID AS WRITTEN
>
> The two placeholders below are **not** editorial notes. Until both are filled
> in, this section selects no law and no forum, so it has no legal effect and
> neither does anything that depends on it: the warranty disclaimer (11), the
> liability cap (12), and the indemnity (13) all assume a governing law exists.
>
> **Do not guess the state.** It is the state of organisation of **312.dev LLC**,
> a fact recorded on that company's formation documents. Fill it in section 1
> at the same time; it is the same fact in both places.
>
> `make legal` fails while either placeholder is present.

These Terms are governed by the laws of `[CONFIRM: state]`, United States,
without regard to its conflict-of-laws rules. The exclusive venue for any dispute
is `[CONFIRM: county/state courts]`, and you and we each consent to personal
jurisdiction there.

If you are a consumer resident in the European Union, the United Kingdom, or
another jurisdiction whose law gives you a non-waivable right to the protection
of your local law or to bring proceedings in your local courts, nothing in this
section removes that right.

`[CONFIRM with counsel: whether to include an arbitration clause and class-action
waiver. This draft deliberately includes neither. For a free, non-commercial
service with a USD 100 liability cap, arbitration adds cost and consumer-law risk
without adding protection, but that is a judgement to confirm rather than assume.
Note also that SeatGeek clause 4.3 requires terms "at least as protective" as
theirs, so if SeatGeek's own terms compel arbitration, this section may need to
match.]`

---

## 17. Changes to these Terms

We may update these Terms. When we do, we will change the "Last updated" date and
publish the new version at the same stable URL, and the change history is visible
in this repository's git log, which is public.

For a **material** change we will give notice in the application before it takes
effect. Continuing to use Pull.fm after a change takes effect means you accept
it. If you do not accept it, delete your account.

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

**312.dev LLC**
Email: `ope@312.dev`
Security reports: see [`../SECURITY.md`](../SECURITY.md)

`[CONFIRM: a postal address is required for a published consumer-facing legal
document in several jurisdictions, and an EU Article 27 representative may be
required. See privacy-policy.md section 12.]`

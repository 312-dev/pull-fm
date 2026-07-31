# Pull.fm Terms of Service and Application End User Licence Agreement

> **DRAFT. Not yet effective. Has not been reviewed by counsel.**
>
> These Terms have not been published at a stable URL and no user has accepted
> them. Outstanding items, including the counsel questions on sections 9 and 13,
> are tracked in
> [`../docs/compliance/publication-checklist.md`](../docs/compliance/publication-checklist.md)
> and must be closed before publication.

**Version:** DRAFT-1 (unpublished)
**Last updated:** 2026-07-30
**Effective:** not yet effective

---

## 1. Who we are and what these Terms cover

Pull.fm ("**Pull.fm**", "**we**", "**us**") is a music discovery service operated
by **312.dev LLC**, a limited liability company organised under the laws of the
State of Illinois, United States.

These Terms are a binding agreement between you and 312.dev LLC. They cover the
Pull.fm backend API at `api.pull.fm`, the Pull.fm client applications distributed
as signed GitHub Release assets, and any personal API token you create.

By creating an account, installing a Pull.fm client, or using the API, you agree
to these Terms. If you do not agree, do not use Pull.fm.

Pull.fm is free and non-commercial. We charge nothing, we sell nothing, we run no
advertising, we take no affiliate or referral revenue, and we do not sell or
share your personal information. This is a permanent product constraint and a
condition of several of the upstream licences on which Pull.fm depends.

Pull.fm is operated by one person. Section 12 states what that means for
availability.

---

## 2. Eligibility, where Pull.fm is offered, and your account

**Pull.fm is offered to residents of the United States.** We refuse to create an
account for anyone who appears to be in the European Economic Area (the 27 EU
member states together with Iceland, Liechtenstein and Norway), the United
Kingdom, or Switzerland. The refusal extends to European Union territory reported
under its own country code rather than that of its member state.

The following describes the limits of that refusal:

- **It refuses registration, not access.** Pull.fm is not withdrawn in those
  places. An existing account continues to work, sessions continue to refresh,
  and nothing is deleted. What is refused is the creation of a new account.
- **A refused attempt creates nothing and sends nothing.** The check runs before
  we contact our identity provider, so no account is created, no record of your
  address is created at that provider, and no sign-in email is sent.
- **It is determined from the network address the request arrives from**, as
  reported by our content delivery network. It is not proof of residence, and a
  virtual private network or a mis-located address can defeat it in either
  direction. We do not represent that no resident of those regions holds an
  account. We represent that we do not knowingly create one and that we take
  reasonable measures to that end.
- **Where the origin of a request cannot be determined, the request is refused.**
  This includes requests over Tor.

You must be at least **16 years old** to use Pull.fm. We do not knowingly provide
the service to anyone younger, and if we learn that an account belongs to a
person under 16 we will delete it. Pull.fm never asks your age, so this is a term
you agree to rather than a matter we verify;
[`privacy-policy.md`](privacy-policy.md) section 11 sets out what follows.

Accounts are created through WorkOS AuthKit using an emailed one-time code.
Social sign-in, passkeys and passwords are not enabled. Pull.fm issues no
passwords and stores no password hashes.

You are responsible for the security of the identity provider account you sign in
with, and for any personal API token you create. A personal API token is a bearer
credential: any person holding it may read your Pull.fm data within its scopes
until it expires or you revoke it.

---

## 3. The software and the service are licensed separately

**The software is licensed to you under the Apache License 2.0, and these Terms
do not restrict that licence.**

The Pull.fm source code and the compiled client applications we publish are both
licensed under the Apache License 2.0. That licence is perpetual, irrevocable,
worldwide, royalty-free and transferable, and it permits commercial use. Nothing
in these Terms limits it. You may keep, copy, modify, redistribute and sell the
application under Apache-2.0, including a version directed at a server other than
ours.

**These Terms govern access to the hosted service:** the Pull.fm API, the
accounts it holds and the data it returns. That access is personal,
non-transferable and revocable, and it is offered to residents of the United
States under section 2.

Accordingly, we may suspend or terminate your account and API access, and we
neither can nor claim to prevent you from running the application. On termination
of access, your copy of the application remains yours under Apache-2.0 and simply
has no Pull.fm server to address.

The conditions in this section are conditions of using the hosted service and not
conditions of your licence to the software. Several exist because our upstream
data providers impose them on us and we cannot sublicense rights we do not hold.

When using the hosted service, you may not:

- use the hosted service, or data obtained from it, for any commercial purpose.
  Apache-2.0 permits commercial use of the software and this restriction does not
  affect that; what is restricted is commercial use of the service and the data it
  returns, which our upstream providers licence to us for non-commercial use only;
- resell, sublicense, or provide Pull.fm's output as a service to others;
- remove, obscure, alter or fail to render any attribution, credit, logo or link
  that Pull.fm supplies with data (see section 7 and
  [`attribution.md`](attribution.md));
- circumvent rate limits, quotas or access controls;
- scrape, bulk-download or systematically extract data from Pull.fm;
- use Pull.fm to build or train a machine learning model, or to populate a search
  engine, directory, dataset or index;
- probe, scan or test the security of the service other than as permitted by our
  [security policy](../SECURITY.md), which provides a safe harbour for good-faith
  research.

---

## 4. Personal API tokens

You may create read-only personal API tokens to access your own data.

- Tokens are read-only and scoped. They cannot delete your account, export your
  personal data, create or list other tokens, modify your wishlist, or affect
  your connected third-party accounts.
- Every token expires, by default after 90 days and at most after 365 days. You
  may revoke or rotate a token at any time; revocation takes effect on the next
  request.
- You may hold at most 10 live tokens.
- We store only an irreversible fingerprint of a token and cannot recover or
  re-display it.

Tokens grant no data licence. Sections 3, 7 and 8 apply in full to anything
retrieved with a token, and in particular the prohibitions on machine learning
use, public datasets and search indexing.

Live event data is not available through a personal API token. This is a
contractual restriction; see section 8.

---

## 5. Connecting third-party accounts

Pull.fm can connect to your ListenBrainz and Last.fm accounts to produce
recommendations. When you connect one, you authorise us to store a credential for
that service and to use it on your behalf for that purpose.

- Credentials are encrypted using AES-256 under a key held separately from them,
  and are never included in a data export, log, error message or support record.
- You may disconnect a service at any time, which deletes our stored credential.
- Your relationship with ListenBrainz and Last.fm is governed by their terms. We
  are not responsible for their services, their availability, or their handling
  of your data.
- **Revoke at the source as well.** Disconnecting at Pull.fm deletes our copy of
  the credential. To invalidate the credential itself, revoke it in your account
  settings at that provider. Last.fm session keys do not expire.

---

## 6. Your content

You own what you put into Pull.fm, including wishlist entries, notes and your
display name. You grant us only the licence necessary to operate the service for
you: to store, process and display that content back to you.

We do not publish your data, sell it, share it with advertisers, or use it to
train models. There is no public profile, no social feed and no sharing surface.

---

## 7. Data from third-party sources

Pull.fm assembles data from ListenBrainz, MusicBrainz, Last.fm, Apple/iTunes,
Deezer and SeatGeek. That data belongs to those providers, is licensed to us on
limited terms, and is provided to you subject to the same limits.

You agree that:

- you will not copy, redistribute, republish, sell or systematically store data
  obtained from Pull.fm that originates with any of those providers;
- you will not use it to build a competing catalogue, dataset, index or
  directory;
- you will not use it to train, fine-tune, ground or evaluate a machine learning
  model;
- you will render every attribution, credit, logo and link that Pull.fm supplies
  alongside the data, unmodified except as expressly permitted;
- **you will not add affiliate, referral or tracking parameters** to any outbound
  link Pull.fm provides. Doing so would breach the Last.fm, Deezer and Apple
  terms simultaneously and would end Pull.fm's access to all three.

Music previews are provided by Apple/iTunes and Deezer for preview purposes only.
You may not download, record, save, cache or redistribute preview audio.

If a provider terminates or restricts our access, the corresponding part of
Pull.fm ceases to function. We have no control over that and no obligation to
replace it.

---

## 8. Live event data and SeatGeek

Live event data is **not served at present** and no events provider is enabled.
This section must be in force before the first event is served.

When enabled, live event information in Pull.fm is supplied by SeatGeek
("**SeatGeek Materials**"). In addition to section 7, you specifically agree that
you will **not**:

1. systematically download, scrape, harvest or store SeatGeek Materials, in whole
   or in part, whether manually or by automated means;
2. make SeatGeek Materials available to, or use them in connection with, any
   search engine, directory, dataset, index, or any artificial intelligence or
   machine learning application or model, including by entering them into or
   retrieving them for such a system;
3. use SeatGeek Materials for any competitive purpose, including price
   comparison, ticket aggregation, market analysis, or operating or supporting a
   secondary ticket marketplace;
4. remove, obscure, alter, crop, recolour or otherwise modify the SeatGeek logo
   or its link, or display SeatGeek Materials anywhere the logo is not displayed
   and linked to <https://seatgeek.com>. Proportional resizing of the logo is the
   only modification permitted;
5. display, invent, estimate or infer ticket prices in connection with SeatGeek
   Materials. SeatGeek supplies none;
6. use SeatGeek Materials for any commercial purpose or in any manner that
   generates revenue for you;
7. submit personal data, including precise location coordinates, postal codes,
   email addresses or the names of other people, through any Pull.fm feature that
   queries live events. Pull.fm's events interface accepts a city name only and
   the service rejects coordinate-shaped input;
8. use SeatGeek Materials in any manner that would breach SeatGeek's own
   published terms were you their direct licensee.

**Access restrictions we enforce.** SeatGeek-derived data is not exposed through
personal API tokens, is not included in a data export, is not served on any
unauthenticated or public route, and is not included in any feed cached or
indexable by a crawler. Any route by which it can be reached is a defect and we
ask that you report it under our [security policy](../SECURITY.md).

**No warranty on events.** Event data is provided by SeatGeek as is. Times,
venues, line-ups and availability change. Confirm with the venue or with SeatGeek
before relying on any of it. Section 13 states the limit of liability applicable
to the SeatGeek Entities.

---

## 9. Third-party beneficiaries

**SeatGeek, Inc. and its affiliates, subsidiaries, parents, successors and
assigns (collectively, the "SeatGeek Entities") are express third-party
beneficiaries of these Terms.**

The SeatGeek Entities are entitled to enforce these Terms directly against you,
in their own name, with respect to any provision concerning SeatGeek Materials,
including without limitation section 7, section 8, section 11 (disclaimer of
warranties), section 13 (limitation of liability) and section 14 (indemnity). No
consent of the SeatGeek Entities is required for any amendment of these Terms,
but no amendment may reduce the protections these Terms afford the SeatGeek
Entities below those in SeatGeek's own API Terms of Use.

Except as stated in this section, these Terms create no rights in any person who
is not a party to them.

---

## 10. Acceptable use

You may not:

- access another person's account or data, or attempt to do so;
- interfere with, overload or degrade the service or its infrastructure;
- use Pull.fm to violate any law or any third party's rights;
- misrepresent yourself, or use Pull.fm to impersonate any person;
- automate the service beyond your own personal use, or operate it as a shared
  backend for other people.

We may suspend or terminate access for breach of this section, immediately and
without notice where the breach threatens the service, other users, or our
upstream licences.

---

## 11. Disclaimer of warranties

**Pull.fm is provided "as is" and "as available", without warranty of any kind.**
To the maximum extent permitted by law, we and our suppliers, including the
SeatGeek Entities and every other upstream provider named in section 7, disclaim
all warranties, express, implied or statutory, including any implied warranty of
merchantability, fitness for a particular purpose, title, accuracy and
non-infringement.

We do not warrant that Pull.fm will be available, uninterrupted, timely, secure
or error-free, or that any data it displays is accurate or complete. Metadata,
recommendations, previews and event listings originate with third parties and are
frequently inaccurate.

Some jurisdictions do not permit the exclusion of implied warranties, so parts of
this section may not apply to you.

---

## 12. Availability

**Pull.fm gives no availability commitment.** There is no service level
agreement, no uptime guarantee, no support commitment and no 24-hour response.

- Pull.fm is operated by one person, with no on-call rotation.
- Alerts do not page a person. The service is designed to degrade automatically
  by means of restart policies, an external health check that can enable a
  maintenance mode, and a read-only degraded mode.
- Outages may last hours, or longer during a scheduled freeze.
- Security reports are triaged on the timetable published in
  [`../SECURITY.md`](../SECURITY.md), measured in business days.
- We may change, suspend or discontinue any part of Pull.fm, including all of it,
  at any time and without notice. If we discontinue Pull.fm we will make
  reasonable efforts to give notice and an opportunity to export your data, but
  we do not undertake to do so.

Pull.fm is free. You are not paying for availability and we are not selling it.

---

## 13. Limitation of liability

To the maximum extent permitted by law:

- We are **not liable** for any indirect, incidental, special, consequential,
  exemplary or punitive damages, or for lost profits, lost data or loss of
  goodwill, arising out of or relating to Pull.fm, on any theory of liability,
  even if advised of the possibility.
- Our **total aggregate liability** to you for all claims relating to Pull.fm is
  limited to **one hundred United States dollars (USD 100)**.
- The same limitations apply, to the same extent, for the benefit of the SeatGeek
  Entities and every other upstream provider named in section 7.
- **THE MAXIMUM AGGREGATE LIABILITY OF THE SEATGEEK ENTITIES FOR ALL DAMAGES,
  LOSSES, AND CAUSES OF ACTION IN CONNECTION WITH SEATGEEK MATERIALS, WHETHER IN
  CONTRACT, TORT (INCLUDING NEGLIGENCE), OR OTHERWISE, IS FIFTY UNITED STATES
  DOLLARS (USD 50.00).**

Some jurisdictions do not permit these limitations, so parts of this section may
not apply to you. Nothing in these Terms limits liability that cannot lawfully be
limited, including for fraud or for death or personal injury caused by
negligence.

---

## 14. Indemnity

You will indemnify and hold harmless 312.dev LLC, its members and personnel, and
the SeatGeek Entities, against any claim, demand, loss or expense, including
reasonable legal fees, arising out of your breach of these Terms, your misuse of
Pull.fm, or your use of data obtained through Pull.fm in a manner prohibited by
sections 3, 7 or 8.

---

## 15. Termination

You may stop using Pull.fm at any time and delete your account from the account
screen in a Pull.fm client, or by the equivalent request to our API. Deletion is
irreversible;
[`privacy-policy.md`](privacy-policy.md) section 7 states what it removes and
what remains in backups.

We may suspend or terminate your access at any time for breach of these Terms, to
protect the service or its users, or if an upstream provider requires it.

Sections 6 (as to content already lawfully processed), 7, 8, 9, 11, 13, 14 and 16
survive termination.

---

## 16. Governing law and disputes

These Terms are governed by the laws of the **State of Illinois**, United States,
without regard to its conflict-of-laws rules. The exclusive venue for any dispute
arising out of or relating to these Terms or to Pull.fm is the state and federal
courts located in the State of Illinois, and each party consents to personal
jurisdiction and venue in those courts and waives any objection to them on
grounds of inconvenient forum.

No county is specified. A venue clause is effective where it fixes a state and a
court system, and Illinois contains two federal judicial districts.

If you are a consumer resident in a jurisdiction whose law gives you a
non-waivable right to the protection of your local law or to bring proceedings in
your local courts, nothing in this section removes that right.

**These Terms contain no arbitration clause and no class-action waiver.**

---

## 17. Changes to these Terms

We may update these Terms. When we do, we will change the "Last updated" date and
publish the new version at the same stable URL. The change history is visible in
this repository's public version control.

**A material change requires your acceptance. We do not treat continued use of
Pull.fm as acceptance of one.** When we publish a material revision, Pull.fm asks
you to read and accept it, and until you do:

- **you keep read access.** Your account is not suspended and nothing is deleted.
  A revision is our act and not yours.
- **changes you make are refused.** You may not add to your wishlist, create a
  token, or connect an account, because those are the matters these Terms govern
  and we do not have your agreement to the version that would govern them.
- **you may always leave.** Export and deletion continue to operate and are never
  conditioned on your accepting anything.

A change that is not material asks nothing of you. Every published revision is
recorded with a version, a digest of its exact text, and a flag recording whether
it was material, in an append-only table whose rows cannot be altered afterwards.

---

## 18. Miscellaneous

- **Entire agreement.** These Terms and the [Privacy Policy](privacy-policy.md)
  are the entire agreement between you and us concerning Pull.fm.
- **Severability.** If a provision is unenforceable, the remainder stands.
- **No waiver.** A failure to enforce a provision on one occasion does not waive
  it.
- **Assignment.** You may not assign these Terms. We may assign them to a
  successor of the business.

---

## 19. Contact

312.dev LLC, Illinois, United States
Email: `ope@312.dev`
Security reports: [`../SECURITY.md`](../SECURITY.md)

No postal address is published; [`privacy-policy.md`](privacy-policy.md) section
2 records the basis for that decision.

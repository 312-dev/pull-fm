# Publication checklist for the legal documents

Everything here blocks publication of `legal/privacy-policy.md` or
`legal/terms-of-service.md` at a stable URL. It is the internal companion to
those documents: the drafting rationale, the unresolved questions, and the
evidence trail behind claims the documents state flatly.

**Why this file exists separately.** A privacy policy states obligations. It does
not narrate why it states them, and it does not carry a running commentary on its
own drafting. Both documents previously did, which made them read as engineering
memoranda about law rather than as legal instruments. The reasoning was not
discarded when they were rewritten on 2026-07-30; it moved here. Where a
disclosure qualified something a user is told, it stayed in the document.

**The rule that governs this split.** A limitation that changes what a user can
rely on belongs in the published document, however uncomfortable. A limitation
that only concerns whether the operator has finished their homework belongs here.
Deleting a disclosure of the first kind to make a document read more smoothly
turns a disclosed weakness into a false statement, which is precisely what
`legal/check-publication-blockers.mjs` exists to prevent.

---

## A. Blocking, and disclosed in the published documents

These remain visible to the reader because each qualifies something the reader is
otherwise entitled to rely on. Closing them means changing the system, not the
sentence.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where disclosed                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A1  | No retention period is configured for application or web server logs anywhere in the system. A number must exist before one is stated.                                                                                                                                                                                                                                                                                                            | Privacy policy section 8                 |
| A2  | The retention jobs are implemented, tested and scheduled by committed systemd timers, and **no scheduled run has ever fired**, because no compute is deployed. Every period in section 8 is therefore applied on execution rather than automatically. Closing this requires evidence that a timer fired, not further configuration.                                                                                                               | Privacy policy section 8                 |
| A3  | The 35-day and 90-day object-storage lifecycle rules are configured but **cannot be read by us**. The backup credential was deliberately narrowed to a bucket-scoped object token after an account-wide grant was found to read every bucket in the estate; lifecycle reads are a bucket-admin operation and that token is refused them. Run the conformance check from an operator credential.                                                   | Privacy policy section 7.2 and section 8 |
| A4  | WorkOS does not publish the schedule on which its backup and archival copies of identity data are deleted following termination.                                                                                                                                                                                                                                                                                                                  | Privacy policy section 8                 |
| A5  | Custody of the application encryption key rests with a **single holder**, the operator (`PULLFM-RISK-003`).                                                                                                                                                                                                                                                                                                                                       | Privacy policy sections 5 and 12         |
| A6  | Other than California and Connecticut, the state comprehensive privacy statutes have not been checked against primary sources. The stated position is the operator's understanding. Re-surveying them is a recurring audit with a trigger (`apps/bff/src/lib/recurring-audits.ts`), because these statutes change on their own schedule: Connecticut removed two applicability thresholds on 1 July 2026 and nothing here would have surfaced it. | Privacy policy section 10.2              |

---

## B. Blocking, and deliberately internal

These do not change what a user may rely on. They are the operator's unfinished
work, and stating them in a published legal instrument would be a category error.

### B1. Whether listening history is "sensitive data" under the CTDPA

**This is the most consequential open question in the file.** Public Act 25-113
took effect on 1 July 2026 and removed the volume threshold from two of the three
CTDPA applicability triggers. Pull.fm's position now rests on processing no
sensitive data rather than on being small, and that position is only as strong as
the answer to one question.

The CTDPA definition reaches personal data _revealing_ religious beliefs or
sexual orientation. Privacy policy section 3.6 states that musical taste can be
revealing, which is true and is the reason the point is arguable. No United
States court has decided whether data permitting an inference of that kind is
"revealing" data within such a definition. Under the GDPR the Court of Justice
took the broad view in `C-184/20 (OT v Vyriausioji tarnybinės etikos komisija)`,
holding that data capable of indirectly disclosing sexual orientation falls
within the special categories.

If listening history is sensitive data under the CTDPA, the second trigger
attaches with no threshold to escape, and **the relevant event is the first
Connecticut user rather than the first paying user.**

Counsel must reach a view before publication.

### B2. Massachusetts and New York citations

The duty in privacy policy section 9.3 to require security measures of a service
provider by contract is sourced to **Massachusetts 201 CMR 17.03(2)(f)** and the
**New York SHIELD Act**. Both citations are the operator's reading and have not
been checked against primary sources. Four processor records rest on them.
Counsel must confirm both, and whether any other state imposes the same duty.

### B3. State-by-state breach notification deadlines

Privacy policy section 13 states the structure of the obligation and the position
we would take. The precise deadlines per state, and which of them treat the
information Pull.fm holds as covered, have not been compiled. The commitment to
notify does not depend on that work; the accuracy of any specific deadline does.

### B4. Infrastructure not pinned by committed code

Two placements in privacy policy section 9.2 are held by something less durable
than the rest, and the document says so without elaborating:

- The application node's location is supplied from an operator file that is not
  committed, while the committed default for that variable is still a European
  site. A fresh apply that omitted the operator file would place the node in
  Europe.
- The erasure-ledger bucket is not described by infrastructure code at all, so
  unlike the backup bucket there is no committed artifact fixing or checking its
  placement.

Neither makes a statement in section 9.2 false today. Both mean a true statement
is one forgotten input away from becoming false.

### B5. Postal address

No postal address is published, and section 2 of the privacy policy records what
was checked. Two future events reverse the decision and are named there: entering
an app store, and sending a first commercial email. Separately, 312.dev LLC's
registered agent address is already public record at the Illinois Secretary of
State, so publishing it would cost nothing in privacy terms. Whether to publish
it anyway is an operator decision that has not been made.

### B6. No client presents the documents, so no assent is obtained

**This is the largest gap in the project and it is worth more than any clause in
either document.** Distribution is a sideloaded application file from GitHub
Releases, so there is no store flow and no installer dialogue in which a user is
shown terms and acts on them.

_What exists._ Both documents carry machine-readable versions and a content
digest. The API records who accepted which version of which document, when, from
which session and on which client build, in an append-only table an UPDATE cannot
rewrite. A material revision raises a consent epoch and every user must accept
again; a corrected typo does not. `GET /v1/me/consent` reports what an
authenticated user still owes and `POST /v1/me/consent` records an acceptance. A
user who has accepted nothing is refused every route except signing out, reading
their own account, the consent endpoints, and export and deletion, which are never
conditioned on accepting the Terms. A user who accepted an earlier epoch keeps
read access and is refused writes. The record is server-side and survives a
reinstall.

_What does not exist._ No client presents the documents. A server that records an
acceptance it was told about cannot know a human was shown anything, and under
Illinois law the interface is the whole question. Two prerequisites are also
outstanding: the documents are not published at a stable URL, and the client must
fetch the canonical document bytes and echo their digest, because the API refuses
an acceptance whose digest does not match the version it publishes. Publishing a
rendered page whose bytes differ from the canonical source would make acceptance
impossible rather than merely inconsistent.

_Why it matters more than it appears._ In `Sgouros v. TransUnion Corp.`, 817 F.3d
1029 (7th Cir. 2016), no contract formed even where the user completed a paid
purchase on a page displaying the terms, because the interface did not
communicate that proceeding was assent. A sideloaded application with no consent
step has a weaker record than that. **If no contract forms, nothing binds** -
not the limitation of liability, not the Illinois governing-law and venue
selection, not the third-party beneficiary grant, and not the US-only offering.

_The second, independent reason._ SeatGeek clause 4.3 does not merely require
that an Application EULA exist. It requires that the Application **displays** it
and that each End User be **required to accept it before using the Application**,
and it separately obliges us to use all reasonable efforts to enforce it and to
ensure the Application collects information from an End User only where that End
User has affirmatively authorised it. **On the day live events are enabled, the
missing screen is a breach of the SeatGeek agreement in three places at once**,
and the affirmative-authorisation duty is not limited to SeatGeek data. Enabling
events without it is worse than leaving events disabled.

The recording half is what makes 4.3(i) dischargeable at all: "use all reasonable
efforts to enforce" needs a system that knows who accepted which version and
refuses service to someone who has accepted nothing. What that system cannot do
is manufacture the acceptance it records.

### B7. SeatGeek third-party beneficiary and liability cap: counsel questions

Terms sections 9 and 13 must be confirmed by counsel as drafted so as to be
effective under Illinois law, and as satisfying "at least as protective of the
SeatGeek Entities as the terms hereof" under SeatGeek clause 4.3 through the
combination of sections 7, 8, 9, 11, 13 and 14. Three specific questions:

1. Whether the USD 50 cap in the fourth bullet of section 13 discharges 4.3's
   express reference to "limitations of liability", given that SeatGeek's own
   clause 8.2 caps them at exactly USD 50, so we match rather than better it.
2. Whether "at least as protective" reaches **conspicuousness** as well as
   substance. Their 8.2 is in capitals and ours now is for the SeatGeek bullet
   only. Under Illinois law a limitation of liability must be conspicuous to be
   enforceable at all.
3. Whether sections 9 and 13 together survive `Sosa v. Onfido`, 8 F.4th 631 (7th
   Cir. 2021), which turned on a third party falling outside the defined class the
   limitation protected. Onfido could not enforce an app operator's terms because
   the limitation protected "OfferUp providers", defined as "affiliates [and]
   licensors", and the court held Onfido was neither. Illinois requires that
   third-party benefit be practically an express declaration.

**Do not consolidate the SeatGeek bullet into the general cap.** A single bullet
reading "USD 100, or USD 50 for the SeatGeek Entities" is the same sentence and a
worse one: protection extended to a third-party beneficiary should be findable by
searching for that beneficiary's name. The enumeration in section 9 must also
name section 13 and not section 12; a mislabelled cross-reference in the clause
doing the extending is exactly the `Sosa` defect.

### B8. The SeatGeek cap moves downward only, without notice

The USD 50 figure was USD 100 until 2026-07-29, which was a breach of the very
clause these Terms exist to satisfy: our cap extended "the same limitations" to
the SeatGeek Entities by name, so the number protecting them was USD 100, twice
the exposure their own clause 8.2 permits. It was invisible because every prior
analysis in this repository worked from a paraphrase in which 8.2 was mis-numbered
as "9.2" and reduced to a fact about their risk appetite rather than a ceiling on
ours.

Section 1 of SeatGeek's terms permits them to change their terms at any time with
continued use as acceptance. **If their cap on themselves drops below USD 50,
this bullet is immediately non-compliant with no notice to us.** Re-audit
quarterly against
[`../../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md).

**The quarterly re-audit has a trigger and is no longer an intention.**
`apps/bff/src/lib/recurring-audits.ts` records when it was last performed and by
whom, and the suite fails once it is overdue. Clearing it means doing the audit
and recording the date, not dismissing a reminder. Note the division of labour:
the `seatgeek-cap-is-fifty` predicate in `legal-triggers.ts` catches **our**
figure moving, and only this audit can catch **theirs**.

### B9. Arbitration: the decision and the premises that would reverse it

Decided 2026-07-29 by the controller: **no arbitration clause and no class-action
waiver.** Recorded so the decision is re-examined on its premises rather than
re-argued from scratch.

- **The forum costs more than the liability it would protect.** The cap is USD 100. Business-side arbitration fees exceed that by roughly 12x to 35x at every
  scale, and there is no number of claimants at which arbitrating is cheaper than
  paying each claimant the cap. AAA also charges an annual consumer-clause
  registry fee in perpetuity whether or not anyone files.
- **The Illinois-specific reason does not apply.** BIPA carries a private right
  of action and a class-action waiver is the standard defence, but BIPA section 10
  is a closed list of biometric identifiers that expressly excludes photographs,
  and every section 15 duty is conditioned on collecting or possessing one. This
  service collects none.
- **The external pressure is absent.** SeatGeek clause 12.2 selects New York law
  and the exclusive venue of New York County and contains no arbitration clause
  and no class-action waiver, so the "at least as protective" requirement does not
  import one.

**Re-open if either premise changes.** If a feature ever touches voice, face or
fingerprint data, BIPA attaches and the calculation inverts. If the service ever
charges money, the cap and the cost-benefit both move. Adding a clause later binds
only users who accept the amended terms, so this is cheap now and expensive to
reverse. If one is ever added, name **JAMS** and expressly invoke its Mass
Arbitration Procedures, which charge a flat filing fee regardless of case count,
rather than AAA, which charges per case and scales linearly against the
defendant. Include an express bar on class arbitration and state that the waiver
is non-severable, because `Kinkel` severed a waiver and enforced the clause
without it, sending the defendant into class arbitration.

### B10. Counsel review

Neither document has been reviewed by a lawyer. Both must be before publication
at a stable URL.

---

## C. Constraints on future work

Not blocking today. Each becomes a false statement the moment the corresponding
feature ships, so each is recorded as a constraint on what may be built rather
than as a task.

| #   | Constraint                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | If a release stores per-user listening history, ranking state or an inferred taste profile, privacy policy section 3.3 must be rewritten **before it ships**, and those rows must cascade on user deletion, or the deletion claim in section 7 becomes false. A user-scoped `upstream_cache` key would place user-linked rows in a table the deletion cascade does not touch.        |
| C2  | If a feature ever uses voice, face, fingerprint or anything else within the Illinois Biometric Information Privacy Act, the Act's written notice, written release and published retention schedule attach **before the first collection**. There is no version of such a feature that can ship first and be papered afterwards.                                                      |
| C3  | If social sign-in, passkeys, WebAuthn or passwords are ever enabled, privacy policy section 3.1 must change, because the provider would then also disclose which third-party account was used. A database constraint on `users.auth_method` and a test currently prevent this from happening silently.                                                                               |
| C4  | Taking revenue, or reaching 100,000 users, converts section 10.2 from "below the threshold" to "covered". The obligations that arrive are not paperwork: a notice at collection, verified consumer request handling with statutory deadlines, and contractual terms with every service provider. **Treat the first paying user and the hundred-thousandth account as legal events.** |
| C5  | If Pull.fm ever sells or shares personal information, honouring Global Privacy Control becomes an engineering obligation rather than a sentence, because the signal must be detected and acted on in code.                                                                                                                                                                           |
| C6  | Entering an app store makes a postal address mandatory. Sending a first commercial email engages 15 U.S.C. section 7704(a)(5)(A)(iii).                                                                                                                                                                                                                                               |

---

## D. Evidence behind claims the documents state flatly

Recorded so that a reader of the documents does not have to take them on trust,
and so that a later editor does not weaken a sentence that was expensive to earn.

**The replay list cannot live in the database.** A restore drill on 2026-07-29
disproved the previous design directly: erasing an account after a restore point
and then restoring to before it left the account present and `deletion_log`
holding zero rows. The list lived inside the thing being rolled back, so the
rollback took the evidence with it. The ledger now lives in object storage as one
immutable object per erasure, written inline with the deletion before anything is
destroyed. Append-only is enforced by a retention lock on the bucket rather than
by the credential, because the platform has no write-only permission; a delete
and an overwriting write were both attempted and both refused. The honest limit:
the lock is administered by the same account that administers everything else, so
it defends the ledger against a compromised application and not against a
compromised account.

**The ledger has its own bucket.** Object-storage credentials scope to a bucket
and never to a key prefix, so a credential permitting the API to write ledger
entries inside the backup bucket would also permit a compromised API to destroy
every backup.

**Audit anonymisation uses a random pseudonym, not a keyed hash.** Because
`deletion_log` permanently retains the identifier of every deleted account, a
keyed scheme would be reversible by anyone holding both the key and that table. A
fresh random UUID minted inside the applying statement has no such property.

**Daily dumps follow from the retention figure.** What can be restored to is the
window divided by the interval, so daily gives roughly 35 recovery points inside
35 days where weekly would give five.

**The scheduled dump excludes the imported MusicBrainz catalogue** and retains its
schema. That table is an import of a published upstream dataset that a committed
command rebuilds, and at 31.5 million rows it was 99.99% of the database by size.
Every manifest lists what was excluded. Nothing a user supplied is excluded.

**Backups are not selectively rewritten.** This is the position the ICO, the EDPB
and every serious analysis of the erasure right take: selectively rewriting a
backup destroys the integrity that makes it a backup, and the attempt would be a
larger risk to every other user's data than the residual retention is to the
deleted one. It is an argument about what a backup is and does not change with
the jurisdiction.

**The seven-day recovery window replaced six hours** when the database moved to a
paid United States plan. The number moved because the plan and the project moved,
not because anyone tuned it. It is stated in the direction that matters to a user:
a longer recovery window means deleted data remains restorable for longer.

**The CCPA revenue threshold is quoted from the statute** rather than as the
current adjusted figure, because the adjustment under section 1798.199.95 is
automatic and a number written into the document would go stale without anyone
noticing. The figure in force at the time of writing is $26,625,000.

**Continued use is not acceptance.** Inferring assent from continued use is the
arrangement that failed in `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir.
2016), which is Seventh Circuit law over Illinois. A court declined to find a
contract there even though the terms were displayed and the user completed a paid
purchase, because the interface did not communicate that proceeding was assent.
Continued use communicates less than that, not more. It would also understate
what the service does, which is to stop accepting changes and ask.

**SeatGeek's terms were read in a browser, not fetched.** Every automated request
to `seatgeek.com` returns 403, including its public press page, which is blanket
bot-blocking rather than a login wall. The clauses were transcribed by hand and
the verbatim text is at
[`../../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md`](../../packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md)
so the quotation in the terms of service can be checked against its source. Their
clause 12.2 selects New York law and the exclusive venue of New York County, and
contains no arbitration clause and no class-action waiver, so the "at least as
protective" requirement in their clause 4.3 does not import one.

---

## F. What the published documents describe, in implementation terms

The privacy policy was written against the schema, the export builder, the
deletion cascade, the logger redaction list and the infrastructure definitions
rather than from a template. Until 2026-07-30 it named the tables and columns
directly, which made every claim checkable and made the document read as a
schema description. **The names moved here and the claims stayed there.**

**Why the names could not stay.** A privacy policy is a representation under
section 5 of the FTC Act. A document that asserts `users.auth_method` constrains
sign-in becomes a false statement the moment somebody renames the column, with no
lawyer in the loop and no test that would catch it. Here, a stale name is a
documentation defect. There, it was a misrepresentation. Verifiability was the
right instinct; the published legal instrument was the wrong place for it.

**This table is enforced, not merely maintained.**
`apps/bff/test/integration/legal-claims.test.ts` parses it, classifies every
backticked token, and asserts that each file, environment variable, package
script, table and column named here actually exists. Renaming
`users.auth_method` fails a test that names the policy sentence depending on it.
The suite also refuses to pass if fewer than fifteen tokens resolve, so emptying
this table or breaking the parser is itself a failure rather than a quiet
reduction in coverage.

| Policy statement                                                                         | Implementation                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A stable account identifier" (3.1)                                                      | `users.workos_user_id`                                                                                                                                                       |
| "Your email address" (3.1)                                                               | `users.email`, lower-cased                                                                                                                                                   |
| "A display name" (3.1)                                                                   | `users.display_name`                                                                                                                                                         |
| "Enforced in our systems rather than left to convention" (3.1)                           | Check constraint on `users.auth_method`, plus a test failing if any password, social, passkey or SSO route is registered                                                     |
| Connected services (3.2)                                                                 | `user_connections`; credentials in `access_token_ct` and `refresh_token_ct`; username in `provider_account_id`                                                               |
| "A shared cache organised by service and content, carrying no account identifier" (3.3)  | `upstream_cache`, no user column. **A user-scoped key here would place user-linked rows in a table the deletion cascade does not touch.** See C1.                            |
| "Recommendations and the personalised feed are not yet available" (3.3)                  | Those routes return HTTP 501                                                                                                                                                 |
| Wishlist entries (3.4)                                                                   | `wishlist_items`                                                                                                                                                             |
| Personal API tokens (3.4)                                                                | `api_tokens`; "irreversible fingerprint" is a SHA-256 digest                                                                                                                 |
| "A record of each change you make" (3.5)                                                 | `idempotency_keys`                                                                                                                                                           |
| Security records (3.5)                                                                   | `audit_log`; the closed event list is defined in `apps/bff/src/lib/audit.ts`                                                                                                 |
| "A record that a deletion occurred" (3.5, 7.1)                                           | `deletion_log`. Deliberately has no foreign key to `users`, so rows outlive the deletion they record.                                                                        |
| "Short-lived counters" (3.5)                                                             | Redis, both instances                                                                                                                                                        |
| "Web server access logs" (3.5)                                                           | nginx on the origin node                                                                                                                                                     |
| "Encrypted using AES-256, under a key unique to that record" (5)                         | AES-256-GCM envelope encryption; per-record data key wrapped by an application-wide KEK held outside the database                                                            |
| "Bound to your account, the service and the specific field" (5)                          | Additional authenticated data covers user, provider and column                                                                                                               |
| Export and deletion (6, 7, 10.1)                                                         | `GET /v1/me/export` and `DELETE /v1/me`                                                                                                                                      |
| "Removed together, in a single step that either completes or does not happen at all" (7) | One `DELETE FROM users` in a transaction; every user-owned table declares `ON DELETE CASCADE`; asserted by `packages/db/scripts/verify-migrations.mjs` on every CI run       |
| "Signed in within the previous fifteen minutes" (7)                                      | `DELETE_FRESH_AUTH_MAX_AGE_S`, default 900                                                                                                                                   |
| "Your request fails and nothing is deleted" (7.2)                                        | The route returns HTTP 503 if the erasure-ledger write fails                                                                                                                 |
| "Reduced to its general network area" (7.1)                                              | `/24` for IPv4, `/48` for IPv6, overwritten in place                                                                                                                         |
| "An untraceable substitute" (7.1)                                                        | A random UUID minted inside the applying statement, once per account per batch. See section D for why not a keyed hash.                                                      |
| "Recovery to any point within the previous seven days" (7.2)                             | `history_retention_seconds = 604800` in `infra/neon/variables.tf`                                                                                                            |
| "Deleted automatically on expiry" (8, unverified sign-in records)                        | `AUTH_UNVERIFIED_REAP_AFTER_S`, applied by `reap:unverified`                                                                                                                 |
| The three retention processes (8)                                                        | `purge:audit`, `sweep:expired`, `reap:unverified`, each with a committed systemd timer and a CI check asserting the units are enabled and expand to the documented intervals |
| "A United States region" (9.2)                                                           | `aws-us-east-1`                                                                                                                                                              |
| "Settings that are not part of our published configuration" (9.2)                        | The node location variable, whose committed default is still a European site, and the erasure-ledger bucket, which infrastructure code does not describe. See B4.            |
| "Automated tests that fail our build if any is left untested" (12)                       | The route authorization suite                                                                                                                                                |

---

## E. Closed

| Item                                                               | Resolution                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration refusal for the EEA, UK and Switzerland did not exist | Resolved 2026-07-29. `apps/bff/src/lib/registration-geo.ts` holds the list, three auth routes enforce it before the identity provider is called, 40 tests across two suites cover it. Its limits are disclosed in privacy policy section 9.1. |
| Controller's state of organisation unfilled                        | Resolved. 312.dev LLC is organised in Illinois.                                                                                                                                                                                               |
| No written security commitments on file with Neon or Hetzner       | Resolved 2026-07-30. All four agreements are in writing and filed as dated documents in the operator's vault, addressed by title, deliberately not copied into this public repository. What remains is B2, the citations they rest on.        |
| Terraform described the pre-Neon self-hosted database              | Resolved. Region confirmed by reading the live project from the provider API.                                                                                                                                                                 |
| Sign-in methods sentence disagreed with the plan                   | Resolved 2026-07-29. Magic link only, enforced by a database constraint and a test.                                                                                                                                                           |

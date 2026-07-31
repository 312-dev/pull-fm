# Pull.fm Privacy Policy

> **DRAFT. Not yet effective. Has not been reviewed by counsel.**
>
> This policy has not been published at a stable URL and no user has accepted it.
> Outstanding items are tracked in
> [`../docs/compliance/publication-checklist.md`](../docs/compliance/publication-checklist.md)
> and must be closed before publication.

**Version:** DRAFT-1 (unpublished)
**Last updated:** 2026-07-30
**Effective:** not yet effective

---

## 1. Summary

This summary is provided for convenience. The numbered sections that follow
govern.

- Pull.fm is free and non-commercial. We do not sell, rent or share your personal
  information. There is no advertising, ad technology or affiliate revenue in the
  product.
- We use no analytics, tracking pixels, advertising software, third-party
  telemetry or third-party error reporting.
- We collect an identifier and email address from your sign-in provider, the
  music accounts you choose to connect, the items you add to your wishlist, and
  operational logs.
- Your connected-service credentials are encrypted and are never exported, logged
  or displayed.
- Pull.fm is offered to residents of the United States. We refuse registration
  from the European Economic Area, the United Kingdom and Switzerland.
- You may export your data and delete your account yourself, at any time, without
  contacting us.

---

## 2. Who we are

**312.dev LLC**, a limited liability company organised under the laws of
Illinois, United States, is responsible for the personal information described in
this policy.

|                   |                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Responsible party | 312.dev LLC, Illinois, United States                                                                                 |
| Contact           | `ope@312.dev`                                                                                                        |
| Postal address    | Not published. Contact is by email.                                                                                  |
| Territorial scope | Offered to residents of the United States. Registration from the EEA, the United Kingdom and Switzerland is refused. |

Pull.fm is operated by one person. We disclose this because it affects our
response times under section 10 and because it is a security characteristic you
are entitled to weigh.

We have not appointed a Data Protection Officer or an Article 27 representative.
Both are offices of the General Data Protection Regulation, which does not apply
to Pull.fm for the reasons given in section 9.

**Postal address.** We do not publish a postal address, and no law applicable to
Pull.fm requires one. CalOPPA (California Business and Professions Code section
22575(b)) does not require a postal address. The CCPA permits a business
operating exclusively online, with a direct relationship with the consumer, to
offer an email address as the sole method for submitting requests. Illinois PIPA
does not require one, and the published-retention-policy duty under BIPA attaches
only to an entity in possession of biometric identifiers, which we are not. Two
future events would create the obligation: distribution through an app store,
which would make a postal address mandatory under store rules, and the sending of
a first commercial email, which would engage 15 U.S.C. section
7704(a)(5)(A)(iii). A sign-in code is a transactional message and is outside that
provision.

---

## 3. Information we collect

### 3.1 Account information

Authentication is provided by WorkOS, which processes this information in the
United States. You sign in with a one-time code sent to your email address.
Social sign-in, passkeys and passwords are not enabled, and this is enforced in
our systems rather than left to convention.

| Information                                                                | Source      |
| -------------------------------------------------------------------------- | ----------- |
| A stable account identifier                                                | WorkOS      |
| Your email address                                                         | WorkOS      |
| A display name, formed from the first and last name your provider supplied | WorkOS      |
| The dates your account was created and last updated                        | 312.dev LLC |

We never receive, store or create a password. Pull.fm has no password field and
no password reset process.

WorkOS acts as a service provider on our instructions under the WorkOS Data
Processing Addendum published at
[workos.com/legal/dpa](https://workos.com/legal/dpa). Two terms of that addendum
are disclosed here:

- WorkOS may process your information for its internal use to build or improve
  the quality of its services, to detect security incidents and to protect
  against fraud. That permission is broader than processing solely on our
  instructions. The addendum is silent as to the training of artificial
  intelligence or machine-learning models, and we have obtained no separate
  commitment on that subject.
- Under the CCPA, WorkOS undertakes not to sell or share your personal
  information, not to retain or use it for any purpose other than providing the
  service, and not to combine it with information obtained from others.

### 3.2 Connected music services

If you connect ListenBrainz or Last.fm, we store which service you connected,
your username at that service, the access credential and any refresh credential
we are issued, and the connection's status, permissions, expiry, last
verification time and last error.

The credentials are encrypted. Everything else in that list is held as ordinary
text; your username at those services is not a secret and is needed to make
requests on your behalf.

Connecting is optional. You may disconnect at any time, which deletes our copy of
the credential.

We use these credentials solely to read the information required to generate
recommendations for you. We do not use them to write to your account at the
service, and we do not use them for any unrelated purpose.

### 3.3 Listening information

We read listening information from ListenBrainz and Last.fm using the credential
you supplied, at the time a request requires it.

We do not keep a record of your listening history. Responses from those services
are held in a shared cache that is organised by service and by content, carries
no account identifier, and is not linked to you.

Recommendations and the personalised feed are not yet available.

### 3.4 Information you create

- **Wishlist entries**, including the artist and title, the recording
  identifiers, how the entry was added, its status and any note you write.
- **Personal API tokens**, including your label for the token, its permissions,
  rate limit and expiry, when it was last used, and the IP address it was last
  used from.

We store only an irreversible fingerprint of a personal API token, never the
token itself, so we cannot recover or re-display it. The last-used IP address is
recorded at most once per minute per token.

### 3.5 Operational and security information

- **Request logs**, holding a request identifier, the method and path with any
  query string removed, the response status, your IP address and your browser or
  client identification. The query string is removed because it may carry a
  search term or a credential.
- **Web server access logs**, holding the same.
- **Security records** of events that affect credentials, drawn from a fixed
  list: sign-in code requested, verified or failed; sign-in completed; session
  refreshed or revoked; profile updated; a music service connection started,
  created, connected or deleted; a personal API token created, rotated, revoked
  or used after expiry; an export requested or downloaded; an account deleted; a
  deletion notice from your sign-in provider accepted or rejected; an unverified
  sign-in record removed. Each record holds an internal account identifier where
  one exists, what happened, the outcome, non-secret context and your IP address.
- **A record that a deletion occurred**, holding the internal identifier of the
  deleted account, when it was requested and completed, and how much was removed.
- **Short-lived counters** for rate limiting, export cooldowns, single-use export
  tickets and sign-outs. These hold opaque identifiers and expire between 60
  seconds and the remaining life of your session.
- **A record of each change you make**, holding the key you supplied, a
  fingerprint of the request and the response we returned, so that a retry on an
  unreliable connection does not duplicate the change. See section 8.

IP addresses are personal information and we treat them as such. We retain them
because a service that consumes another company's rate-limited quota cannot
investigate abuse without them.

### 3.6 Information we do not collect

- No advertising or analytics of any kind, including Google Analytics, Segment,
  PostHog, Mixpanel, Amplitude, session replay, advertising software and device
  fingerprinting.
- No third-party crash or error reporting.
- No precise location. We do not request or store GPS coordinates. The live
  events feature, where enabled, accepts a city name only, and the service
  rejects anything shaped like a coordinate.
- No contacts, photographs, calendar, microphone or device identifiers.
- **No biometric identifiers and no biometric information of any kind**,
  including voiceprints, retina or iris scans, fingerprints, scans of hand or
  face geometry, and anything derived from them. Sign-in is a one-time code sent
  to your email address; passkeys and other biometric sign-in methods are not
  enabled; and nothing of this kind is held anywhere in our systems. The Illinois
  Biometric Information Privacy Act (740 ILCS 14) applies to a private entity
  regardless of size or revenue, and if Pull.fm ever introduces a feature within
  its scope, the Act's written notice, written release and published retention
  schedule will be in place before any collection occurs.
- No health, political opinion, religious or sexual orientation information is
  requested. We treat musical taste as sensitive in practice, although no United
  States statute classifies it as such.
- No passwords.
- No payment information. Pull.fm is free and accepts no payments.

---

## 4. How we use information

| Purpose                                                                            | Information used                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Creating and operating your account                                                | Your account information                                    |
| Connecting a music service and generating recommendations                          | The connection credential and your username at that service |
| Maintaining your wishlist                                                          | Your wishlist entries                                       |
| Operating personal API tokens                                                      | Token details and the last-used IP address                  |
| Security, abuse investigation, and protecting another company's rate-limited quota | Logs, IP address, client identification, security records   |
| Evidencing a deletion                                                              | The deletion record and the erasure ledger                  |
| Complying with law                                                                 | As required, including the duties in section 13             |

We do not process personal information for marketing, advertising, profiling for
advertising, or automated decision-making producing legal or similarly
significant effects. Recommendation ranking is automated and determines only
which music is displayed to you.

---

## 5. Connected-service credentials

- Each credential is encrypted using AES-256, under a key unique to that record.
- That key is in turn encrypted under a master key that is never held in the same
  place as the data, so the stored information is unusable on its own.
- Encryption is bound to your account, the service and the specific field.
  Encrypted information moved between records will not decrypt.
- Credentials are never written to logs, traces, error messages or support
  records. Automated checks fail our build if a credential can reach a log.
- Credentials are excluded from your data export. See section 6.
- The master key is held separately and escrowed. Custody currently rests with a
  single holder.

---

## 6. Access and export

You may request a copy of everything we hold about you. The export contains your
account record, your connected services and their status, your wishlist in full
including any notes, and the details of any personal API tokens you have created.

The export **excludes** your third-party access and refresh credentials, Last.fm
session keys, personal API token secrets, and the encryption material protecting
them. A credential for another service is not information about you; it is a key
to someone else's system, which you can replace at source in a minute. Including
it would mean that a single disclosure of your export file resulted in a lasting
compromise of your ListenBrainz and Last.fm accounts, on systems we neither
control nor can revoke. The export file states this exclusion on its face.

An export request produces a single-use download link valid for approximately ten
minutes. You may request one export every five minutes. An export cannot be
requested or downloaded with a personal API token; you must be signed in.

No United States law currently requires us to offer export. We offer it as a
matter of policy and it will not be withdrawn.

---

## 7. Deleting your account

Deleting your account is irreversible. It proceeds as follows:

1. We record that you asked to be deleted, before anything is removed, so that a
   failure part-way through leaves a durable record we can act on.
2. Your account and everything linked to it are removed together, in a single
   step that either completes or does not happen at all, rather than a sweep that
   can partly fail. This covers your connected services, wishlist, API tokens and
   any in-progress connection. It is verified automatically on every change we
   make to the system.
3. Your identity is deleted at WorkOS. If that fails, your information with us is
   nonetheless deleted and the failure is recorded so it can be retried.
4. Short-lived records held about you are cleared.

Because deletion is irreversible, it requires that you be signed in (a read-only
personal API token is refused), that you have signed in within the previous
fifteen minutes, and that you type your account email address to confirm.

If you delete your identity at WorkOS instead, we are notified and the same
process runs here.

### 7.1 What survives deletion

| Survives            | Contents                                                                                                                                                                                                                                              | Reason                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The deletion record | The internal identifier of the deleted account, the dates, and how much was removed                                                                                                                                                                   | To evidence the deletion, and to re-apply it if a backup is ever restored                                                     |
| Security records    | For thirty days after deletion: the internal identifier, what happened, the outcome and the IP address. Thereafter the same records with the identifier replaced by an untraceable substitute and the IP address reduced to its general network area. | Security evidence must survive the deletion it records. Deleting an account is a plausible final step of an account takeover. |
| Encrypted backups   | Your information as it stood at the time of backup                                                                                                                                                                                                    | See section 7.2                                                                                                               |
| Logs                | A request identifier, an internal identifier, an IP address and client identification. No email address and no credential.                                                                                                                            | See section 8                                                                                                                 |

The identifiers in security records are removed on a fixed schedule. The internal
account identifier is replaced by a randomly generated substitute, created at the
moment of replacement and recorded nowhere else. There is no key and no lookup
table, so the substitution cannot be reversed by anyone, including us. IP
addresses are reduced to their general network area, with the part identifying a
specific connection overwritten. Records that were never associated with a
signed-in person have no identifier to replace and receive no substitute; their
IP addresses are reduced on the same schedule.

The periods are ninety days in full, or thirty days following account deletion,
whichever comes first, after which records are made anonymous; and four hundred
days from the event, after which records are deleted outright.

### 7.2 Backups

Encrypted backups are retained so that the service can be recovered. We do not
selectively edit backups to remove individual accounts. Editing a backup destroys
the integrity that makes it a backup, and doing so would present a greater risk to
every other user's information than the residual retention presents to yours. The
following commitments apply instead:

1. Backups are put beyond ordinary use. They are encrypted, reachable only with a
   credential separate from the one the service uses, and never read to answer a
   live request.
2. Retention is limited. Your information leaves the backup set when the last
   backup containing it expires.
3. **A restore repeats the deletions.** We keep a list of deleted accounts
   outside the database, and before a restored system serves anyone, every
   account on that list is deleted again. The list is kept outside the database
   because a list kept inside it would be reverted by the same restore it exists
   to correct. Each entry is written at the moment you ask to be deleted, before
   anything is removed; if that write fails, your request fails and nothing is
   deleted, so you are never told you were deleted when you were not.
4. A restored backup yields your connected-service credentials only in encrypted
   form, under a key that was never stored with them.

Backups allow recovery to any point within the previous **seven days**. A
deletion therefore remains recoverable for seven days after it is applied. A
longer recovery window means deleted information stays restorable for longer.

We additionally take a daily encrypted copy of the database, retained for
**thirty-five days**, and a copy taken by hand before any deliberately
destructive maintenance, retained for **ninety days**. Our access to that storage
is deliberately limited to the files themselves, which means we cannot read back
the retention setting; these two periods are therefore stated as configured
rather than as independently verified by us.

---

## 8. Retention

| Information                                           | Retention                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account, connected services, wishlist, API tokens     | Until you delete them or delete your account                                                                                                                                                                                                                                                                                                                         |
| Records of changes you make                           | Ineffective after 24 hours, and deleted one hour later                                                                                                                                                                                                                                                                                                               |
| In-progress service connections                       | Expire minutes after starting, and are deleted one hour later                                                                                                                                                                                                                                                                                                        |
| Rate-limit counters, export cooldowns, export tickets | 60 seconds to approximately 11 minutes                                                                                                                                                                                                                                                                                                                               |
| Sign-out records                                      | Until the session would otherwise have expired                                                                                                                                                                                                                                                                                                                       |
| Application and web server logs                       | No retention period is currently configured. A period will be set and stated here before publication.                                                                                                                                                                                                                                                                |
| Security records                                      | 90 days in full, or 30 days following account deletion, whichever comes first, then made anonymous; deleted 400 days from the event. See section 7.1.                                                                                                                                                                                                                |
| Personal API token last-used IP address               | Cleared 90 days after the token was last used                                                                                                                                                                                                                                                                                                                        |
| Deletion records                                      | Indefinite. They contain an internal identifier and dates only.                                                                                                                                                                                                                                                                                                      |
| Encrypted backups                                     | 7 days for point-in-time recovery. 35 days for the daily copy, and 90 days for a copy taken before destructive maintenance, both as configured. See section 7.2.                                                                                                                                                                                                     |
| Information held by WorkOS                            | Deleted when you delete your account. An email address that was sent a sign-in code but never used leaves a record at WorkOS and no account with us; those are deleted automatically on expiry. On termination of our agreement, WorkOS undertakes to delete your information other than backup and archival copies, the schedule for which WorkOS does not publish. |

**The periods in this section are applied each time the corresponding process
runs.** Each is built, tested and scheduled, and the schedule is verified
automatically. No scheduled run has yet taken place, because the service is not
yet deployed. Until then, these are the periods the system applies when it runs,
rather than periods after which information has automatically gone.

---

## 9. Where information is held, and applicable law

### 9.1 The GDPR does not apply

The General Data Protection Regulation reaches a company outside the European
Union through Article 3(2), which turns on whether that company offers goods or
services to people in the Union. It does not turn on where servers are located.
Pull.fm is offered to residents of the United States, and we refuse to create an
account for anyone who appears to be in the European Economic Area, the United
Kingdom or Switzerland. That refusal is enforced before your sign-in provider is
contacted and is covered by automated tests. Accordingly this policy contains no
Article 27 representative, no Chapter V transfer safeguards and no Standard
Contractual Clauses.

The refusal operates on where your request appears to come from. It is not an
identity check and a determined person can circumvent it.

### 9.2 Where information is held

|                                 |                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Database                        | A United States region                                                                                             |
| Application server              | Ashburn, Virginia                                                                                                  |
| Backup storage                  | **Not assigned to any country.** Our provider offers no United States option, so these files may be held anywhere. |
| Content delivery                | Worldwide                                                                                                          |
| Account and sign-in information | WorkOS, United States                                                                                              |

No European infrastructure holds Pull.fm information. The database location was
confirmed by reading it back from the provider rather than from our own
configuration.

Two of the placements above are held in place by settings that are not part of
our published configuration, so they depend on those settings being applied
correctly. Neither affects the placements stated today.

### 9.3 Service providers

We disclose personal information to the following service providers, each of whom
processes it on our instructions:

| Provider   | Function                     | Written security terms                |
| ---------- | ---------------------------- | ------------------------------------- |
| WorkOS     | Identity and authentication  | Data Processing Addendum, Exhibit A   |
| Neon       | Database hosting             | Data Processing Agreement, Annex 2    |
| Hetzner    | Application hosting          | Data Processing Agreement, Appendix 2 |
| Cloudflare | Storage and content delivery | Data Processing Addendum, section 6.2 |

Each agreement is executed and on file. Two United States laws impose a duty to
require security measures of a service provider by contract, with no revenue or
volume threshold: Massachusetts 201 CMR 17.03(2)(f), which requires reasonable
steps to select and retain providers capable of maintaining appropriate security
measures and to require those measures by contract; and the New York SHIELD Act,
which imposes a materially similar duty. The schedule named in each agreement is
the written security commitment those provisions require.

ListenBrainz, Last.fm, MusicBrainz and our live events provider are independent
sources rather than service providers acting on our instructions. We send them
only what is necessary to answer your request, and we send no personal
information to the live events provider.

---

## 10. Your rights

### 10.1 What you may do at any time

| Right                          | How to exercise it                                                        |
| ------------------------------ | ------------------------------------------------------------------------- |
| Obtain all of your information | "Export my data" in the application, or the equivalent request to our API |
| Delete your account            | "Delete account" in the application, or the equivalent request to our API |

Both are self-service and require no action by us. For any other request,
including correction, contact `ope@312.dev`.

### 10.2 State privacy laws

Pull.fm is not currently a covered business under the California Consumer Privacy
Act as amended by the California Privacy Rights Act. Civil Code section
1798.140(d)(1) requires annual gross revenues in excess of $25,000,000 as adjusted
for inflation, or the purchase, sale or sharing of the personal information of
100,000 or more consumers or households annually, or the derivation of 50 percent
or more of annual revenues from selling or sharing personal information. Pull.fm
has no revenue and has not launched. 312.dev LLC is a limited liability company,
so the non-profit exclusion is unavailable, and this position rests on the
thresholds alone. It changes if Pull.fm takes revenue or reaches 100,000 users.

The Connecticut Data Privacy Act, as amended by Public Act 25-113 with effect from
1 July 2026, does not operate on a threshold alone. It applies to an entity that
in the preceding calendar year controlled or processed the personal data of 35,000
Connecticut consumers, **or** controlled or processed sensitive data regardless of
volume, **or** offered personal data for sale regardless of volume. Pull.fm
processes none of the enumerated categories of sensitive data and offers no
personal data for sale. That Act also widened the definition of biometric data by
removing the requirement that it be held in order to identify a specific person;
section 3.6 disclaims biometric information absolutely and so answers the wider
definition.

Approximately twenty states have enacted comprehensive privacy legislation. Most
set a consumer-count threshold, commonly 100,000, or a lower count combined with a
proportion of revenue derived from the sale of data, and Pull.fm is below each.
`[OPEN]` **Other than California and Connecticut, these statutes have not been
checked against their primary sources, and the position stated here is the
operator's understanding rather than a verified one.** Rhode Island sets the
lowest numeric threshold at 35,000 consumers, or 10,000 combined with 20 percent
of revenue from sale. Texas and Nebraska apply a Small Business Administration
size test rather than a numeric threshold, and an exempt small business remains
prohibited from selling sensitive personal data without consent.

**Obligations that apply regardless of threshold.** Breach notification, which
every state imposes without a revenue or volume test; the Illinois Biometric
Information Privacy Act (740 ILCS 14), which applies to a private entity of any
size, and which section 3.6 addresses; the Illinois Personal Information
Protection Act (815 ILCS 530), from which our breach notification, reasonable
security and secure disposal duties derive; and section 5 of the FTC Act, under
which a statement in this policy that the service does not implement is a
deceptive practice.

**Obligations we have examined and do not implement.** We do not honour Global
Privacy Control or other opt-out preference signals. The duty to do so attaches to
a business that sells or shares personal information, and Pull.fm does neither. We
make no automated decision-making disclosure under the California regulations
effective 1 January 2026, which bind businesses covered by the CCPA and are
limited to decisions concerning lending, housing, employment, education and
healthcare. We do not provide a notice at collection, categories tables, a "Do Not
Sell or Share My Personal Information" link, a "Limit the Use of My Sensitive
Personal Information" link, an authorized agent process or a 45-day response
undertaking, because each is an obligation of a covered business and asserting
them would itself be a misrepresentation. Each arrives on the day a threshold is
crossed.

### 10.3 Complaints

You may complain to the Federal Trade Commission, to the Illinois Attorney
General, or to the Attorney General of your own state. We ask that you contact
`ope@312.dev` first.

### 10.4 Response times

Pull.fm is operated by one person and has no support team. Export and deletion are
self-service and are not queued behind us. They form part of the service and are
subject to the same availability as the rest of it; Pull.fm gives no availability
commitment. Where the service is unreachable, contact us by email and we will
respond within the applicable statutory period.

---

## 11. Children

Pull.fm is not intended for children. The terms of service require you to be at
least sixteen.

Pull.fm never asks your age. We hold no date of birth, no age confirmation and no
age information of any kind, and signing in with an emailed code tells us nothing
about your age. The minimum age is therefore a term of the agreement rather than
something we can check, and nothing in the service prevents a younger person from
creating an account.

COPPA applies to an operator of a service directed to children under thirteen, or
to an operator with actual knowledge that it collects personal information from a
child under thirteen. Pull.fm is a music discovery service for adults, is not
directed to children, and collects nothing indicating a user's age. If we learn
that an account belongs to a person under thirteen we will delete it, and the same
applies under sixteen as a term of the agreement. If you believe a child has an
account, contact `ope@312.dev`.

---

## 12. Security

The security design of this service is published rather than kept secret.

- Third-party credentials are encrypted as described in section 5.
- The service is available only over an encrypted connection.
- Every route that touches your information is covered by automated tests that
  fail our build if any is left untested.
- Automated scanning for exposed secrets, code defects, vulnerable dependencies
  and live vulnerabilities runs on every change.
- Vulnerability reports are handled under [`../SECURITY.md`](../SECURITY.md),
  which provides a safe harbour for good-faith research.

**Known limitations.** Custody of the master encryption key rests with a single
holder. The hosting account is shared with unrelated personal services. Both are
recorded, with review dates, in a risk register held privately.

---

## 13. Breach notification

We will notify you without unreasonable delay once we have determined that a
breach has occurred and whom it affects, and we will notify the Attorneys General
and any other authority named by statute. Where several states set outer limits
measured in days, we will meet the shortest deadline among the affected states.
Where an agreement with a partner requires faster notice, we will meet that
deadline.

Every state imposes breach notification without a revenue or volume threshold, and
the applicable law is that of your state. The Illinois Personal Information
Protection Act (815 ILCS 530) applies to us additionally, and imposes a standing
duty to implement reasonable security measures and to dispose of records securely.

Two matters specific to the information Pull.fm holds are disclosed here. First,
most breach-notification statutes define personal information as a name combined
with a Social Security number, driver's licence number or financial account
number, none of which we hold; but newer statutes, including California's, also
cover an email address combined with a credential permitting access to an online
account, and we hold an email address alongside encrypted ListenBrainz and Last.fm
credentials. Whether a credential for another company's service engages a statute
written about the operator's own accounts is unsettled. **We would notify rather
than contest the point.** Second, most of these statutes do not require
notification where the information was encrypted and the key was not also taken.
Connected-service credentials are encrypted under a key held separately, so
disclosure of our database or a backup alone yields nothing readable. We would
notify you in any event.

---

## 14. Changes

We will update this policy when the service changes. The "Last updated" date will
move and previous versions remain publicly available in our published change
history.

For a material change we will give notice in the application before the change
takes effect, and we will ask you to accept it before you can continue to make
changes to your account. We do not treat continued use as acceptance.

---

## 15. Contact

312.dev LLC, Illinois, United States
Privacy: `ope@312.dev`
Security: [`../SECURITY.md`](../SECURITY.md)

Contact is by email. No postal address is published; see section 2.

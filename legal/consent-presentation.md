# Pull.fm consent screen: what a person is shown, and what they are asked

> # THIS DOCUMENT IS THE INTERFACE, AND THE INTERFACE IS WHAT DECIDES WHETHER A CONTRACT FORMS
>
> `terms-of-service.md` and `privacy-policy.md` say what the agreement is.
> **Neither of them, and nothing on the server, decides whether the agreement was
> ever entered into.** That is settled by what a person was shown and what they
> were asked to do, and until this file existed nobody had written either down.
>
> In `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016), the Seventh
> Circuit found that **no contract had formed under Illinois law** even though the
> user completed a **paid** purchase on a page that **displayed the terms**,
> because the interface did not communicate that proceeding was assent. Illinois
> law is what section 16 of the Terms selects. So the sentence above the button
> and the label on the button are not presentation: they are the evidence that
> assent was communicated, and they carry the liability cap in section 13, the
> venue selection in section 16, the third-party beneficiary grant to the SeatGeek
> Entities in section 9, and the United-States-only offering in section 2. If the
> interface fails, all four fail with it.
>
> **"Continue" and "I agree to the Terms of Service" are not legally equivalent,
> and that is the entire reason this file is versioned, digest-locked and stored
> append-only alongside the documents it asks about.** A change to the words
> around the button can be as material as a change to a clause, so it is capable
> of being recorded as material, on the same terms and through the same interlock.

> # DRAFT - NO CLIENT PRESENTS THIS YET, WHICH IS WHY IT IS WRITTEN DOWN FIRST
>
> `[OPEN]` **No Pull.fm client presents this screen.** The copy below is what a
> client must display and the rules in section 5 are what it must satisfy; both
> are specification rather than description until a client exists. This is the
> same gap that `terms-of-service.md` section 1 keeps open, stated from the other
> side: section 1 records that no screen exists, and this document records exactly
> what that screen has to say when it does, so building it is a matter of
> rendering a published text rather than of drafting under deadline.
>
> Written before the client rather than after it, deliberately. The recording half
> of this feature was built first and it has been complete and unusable for as
> long as it has existed. Writing the words last is how a product ends up with
> "Continue" above a checkbox.

> # DRAFT - NOT LEGAL ADVICE, REQUIRES REVIEW
>
> Drafted by the operator against the behaviour of the code in this repository and
> against the two documents it asks about. **It has not been reviewed by a
> lawyer.** Section 3.3 and section 5 are where a non-lawyer draft is most likely
> to be wrong, because they are where the formation question actually lives.

**Version:** DRAFT-0 (unpublished)
**Last updated:** 2026-07-30
**Effective:** not yet effective
**Highlights checked against:** `terms-of-service@DRAFT-1`, `privacy-policy@DRAFT-1`

The `Highlights checked against` line above is **machine-checked**, not
decorative. `apps/bff/test/integration/legal-versions.test.ts` compares it to the
registry in `apps/bff/src/lib/legal-documents.ts` and fails the build when they
disagree. Section 3.1 quotes four specific figures and four specific section
numbers out of the Terms; without that line, a Terms revision that moved the
liability cap or renumbered a section would leave this screen stating a false
figure to every new user, with nothing to catch it. See section 2.3.

---

## 1. What this document is, and what it deliberately is not

**It is two things.** Sections 3 and 4 are the copy itself, verbatim, as the words
a person sees. Section 5 is the set of rules the surrounding interface has to
satisfy for those words to mean anything.

**It is not a document anybody is asked to accept**, and that is a decision
rather than an omission. Asking a person to agree to the words with which they
are being asked to agree is circular: the acceptance would need its own
presentation, which would need its own acceptance. So this document is
**published, versioned and recorded, and never gated on**. It does not appear in
`GET /v1/me/consent`, it never puts a subject in the `never-accepted` tier, and
adding it to `CONSENT_DOCUMENTS` would be a bug rather than an improvement.

### 1.1 How it is versioned, which is the same way and not a parallel one

The requirement was that a change to this copy be capable of being material. That
ruled out both of the shapes already in `legal/`:

| Shape                                                        | Why it was rejected                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An entry in `CONSENT_DOCUMENTS`                              | Circular, as above. It would also make every existing user owe an acceptance of the consent screen, and the screen would list itself among the documents it was presenting.                                                                      |
| An entry in `NON_CONSENT_LEGAL_FILES`, like `attribution.md` | That list is an escape hatch meaning "this file is not part of the gate, ignore it". It records no version, no digest and no epoch, so the copy could change with nobody deciding what the change meant. That is precisely the failure to avoid. |

So there is a third category, and it reuses every mechanism the other two use
rather than inventing one:

- **Registered** in `apps/bff/src/lib/legal-documents.ts` as
  `CONSENT_PRESENTATION`, with the same `version`, `consentEpoch`, `material` and
  `contentSha256` fields as any other document.
- **Digest-locked** by the same test. Editing this file without updating the
  registry is a red build, and updating the registry forces the materiality
  decision in a reviewable diff.
- **Published** into `legal_document_revisions` by the same `ensureRevisions`,
  which means it inherits the append-only trigger, the epoch guard, the
  `content_sha256` shape check, and the `CHECK` in migration 0009 that refuses
  text disagreeing with the digest on its own row.
- **Served** byte-exactly at `/v1/legal/consent-presentation` and at
  `/v1/legal/consent-presentation/versions/DRAFT-0`, forever, including after it
  is superseded. So the words that were live on a given date are retrievable by
  anyone, with no access to this repository and no need to trust us about them.
- **Not accepted.** It is absent from the set the gate compares against.

### 1.2 The client should render these words from the API, not from its own build

A client that hard-codes this copy is a client where the published copy and the
displayed copy can differ silently, which is the same defect as a client shipping
a stale bundled copy of the Terms. Fetch it, verify the digest against
`GET /v1/legal`, render it. Two things follow that are worth having: a wording
correction reaches users without a release, and the question "what did the screen
say in March" has a server-side answer rather than a question about which build
somebody had installed.

**What that does not do is prove the words were rendered.** Section 6.

---

## 2. When a change to this document is material

The rubric for the other two documents is "does it change what a user is agreeing
to". Here the question is different, and it is narrower and sharper: **does the
change alter whether, or to what, assent was communicated?**

### 2.1 Material. Raise the epoch, set `material: true`

- The sentence that says what the button means (section 3.2).
- The label on the button (section 3.3).
- Which documents are named, or the addition or removal of one.
- Any of the four highlights in section 3.1: adding, removing, or changing what
  one says.
- What a decline does, or the removal of any option from the decline screen
  (section 3.4).
- Anything in section 4 that tells a returning user what they previously agreed
  to, or what happens if they do not agree now.
- Any rule in section 5, in either direction. Loosening one changes what the
  interface is permitted to do; tightening one changes what it must do.

### 2.2 Cosmetic. Keep the epoch, set `material: false`

- Punctuation, capitalisation or line breaking that leaves the words intact.
- A heading.
- Anything in this document's own commentary that is not the copy and not a rule:
  the banners, the rejected-shapes table, the reasoning in this section.
- A corrected typo in the commentary. **A typo in the copy is material**, because
  the copy is quoted verbatim to a user and the fixed version is not the version
  they were shown.

### 2.3 The coupling this document has and the other two do not

Section 3.1 quotes figures and section numbers out of the Terms. That makes this
document **derivative of a specific version of another document**, which nothing
else in `legal/` is. Two rules follow, and the first is enforced by a test rather
than by memory:

1. **A new version of the Terms or the Privacy Policy requires re-checking
   section 3.1 and updating `Highlights checked against`.** The test compares that
   line to the registry, so a version bump elsewhere turns this document red until
   somebody has read section 3.1 against the new text. Whether the result is a
   material or a cosmetic revision here depends on what moved: a renumbered
   section is cosmetic, a changed liability figure is material.
2. **A highlight may only ever be a true and complete-enough summary of what it
   cites.** A highlight that overstates a protection, or omits a condition that
   changes its effect, is worse than no highlight, because it is a statement made
   at the moment of formation by the party relying on the clause.

---

## 3. The first-launch screen

Presented to a subject who has accepted nothing: `GET /v1/me/consent` reports
`satisfied: false` with `reason: "never-accepted"`.

### 3.1 What is displayed

Verbatim. The text is in a fenced block because a fence is the one construct
Prettier will not reflow, so the words below are the words, and `[ ... ]` marks a
control rather than being literal characters to render.

```text
Before you can use Pull.fm

Pull.fm is operated by 312.dev LLC, a limited liability company in Illinois,
United States.

Two documents govern your use of Pull.fm, and both are below in full. What you
see is the whole document; neither one is a summary.

    Terms of Service and Application End User Licence Agreement
    version DRAFT-0

    Privacy Policy
    version DRAFT-1

Four things in them that people are most often surprised by. Each is stated
properly in the document itself, and this list does not stand in for reading it.

    There is a limit on what we owe you if something goes wrong. The Terms,
    section 13, set it at USD 100 for us, and at USD 50 for SeatGeek.

    SeatGeek can enforce parts of the Terms against you directly, as a third
    party who is not us. The Terms, section 9, say which parts and why.

    Illinois law applies, and a dispute is heard in a court in Illinois. The
    Terms, section 16.

    Pull.fm is offered to residents of the United States. The Terms, section 2,
    also say what that does and does not mean for someone outside it.

Choosing "I agree" below is your agreement to both documents, at the versions
named above. It is the only thing in Pull.fm that is your agreement to them. You
do not agree by scrolling, by closing this screen, by signing in, or by using
Pull.fm without choosing it.

    [ I agree to the Terms of Service and the Privacy Policy ]

    [ I do not agree ]
```

Both version strings and both document titles come from `GET /v1/legal` or
`GET /v1/me/consent`. **They are not typed into the client.** A client displaying
`DRAFT-0` while accepting something else would produce a record whose version is
not the version the user saw named, which is the failure the whole digest
handshake exists to prevent, arriving through the one channel the digest does not
cover.

### 3.2 The affirmative act

**The act is choosing the primary control, and nothing else is the act.** Not
scrolling to the end, not dismissing the screen, not the passage of time, not
signing in, not tapping a link to read a document.

The sentence that says so is the fourth paragraph of section 3.1, and it is there
because `Sgouros` turned on its absence. It does three things at once, and all
three are needed:

- It states that the control **is** assent, so proceeding is not merely
  proceeding.
- It states what the assent is **to**, by name and by version, so the scope is
  not inferred from a link.
- It states what is **not** assent, in a list, because the arrangements that lose
  are the ones where a user could reasonably think agreement happened somewhere
  else, or nowhere.

That third clause is a statement of fact about the system and it is true:
`POST /v1/me/consent` is the only writer of `legal_consents`, it requires an
interactive session, and `legal_consents_auth_method_chk` refuses any other
credential at the schema level.

### 3.3 The button

```text
I agree to the Terms of Service and the Privacy Policy
```

**The label names the act and both documents. It is not "Continue", not "Get
started", not "OK", and not "Accept".** The first three describe navigation and
say nothing about agreement, which is the defect in `Sgouros`. "Accept" alone is
better than those and still worse than this, because it does not say what is
being accepted.

The label is long, and the length is the point rather than a cost that was
accepted: a person who reads only the button has still read what they are doing
and to what. If it does not fit, the interface is wrong, not the label. Wrapping
onto two lines is fine.

### 3.4 What a decline does

`[ I do not agree ]` is a real option with a real outcome, and it leads here:

```text
You have not agreed, so Pull.fm cannot be used

Nothing has been recorded except that you signed in. Your account has not been
deleted and nothing has been taken away.

    [ Go back and read them again ]

    [ Sign out ]

    [ Delete my account ]

Deleting your account does not require you to agree to anything, and it never
will. If you decide not to agree, deleting is how you leave: it removes your
account and everything derived from it. The Privacy Policy, section 7, lists
exactly what that removes and what stays in backups until they expire.
```

**Why `Delete my account` is on this screen and not only in settings.** A subject
who has accepted nothing is refused every route except signing out, reading their
own account, the consent endpoints, and export and deletion. So a person who
declines and is sent away has an account they cannot use, and if the only route
out were behind the part of the product they cannot reach, they would have an
account they also cannot leave. Offering deletion here is what makes the decline
honest rather than a dead end. It is also what the Privacy Policy already
promises: the deletion right is never conditioned on accepting the Terms, and a
screen that made it conditional in practice would falsify that in the one place a
user would notice.

**Declining records nothing.** There is no row for a refusal, no `declined_at`,
and no counter. A refusal is the absence of a contract, and the absence is
already fully represented by the absence of a consent row.

---

## 4. The re-consent screen, after a material revision

Presented when `GET /v1/me/consent` reports `satisfied: false` with
`reason: "revision-pending"`: the subject accepted an earlier epoch of every
required document, and at least one has since had a material revision.

**A returning user must not be told they are agreeing for the first time.** This
is the requirement that most obviously separates the two screens, and getting it
wrong is not merely rude: a screen that presents a replacement as an original
misdescribes what is happening, and the thing being obtained is assent to a
**change** to an agreement that already exists and already governs.

### 4.1 What is displayed

```text
The Privacy Policy has changed

You agreed to the Privacy Policy on 14 March 2026. That was version DRAFT-1.
Version DRAFT-2 replaces it.

You are not agreeing to this for the first time. The version you agreed to is
still published, still says exactly what it said then, and still governs until
you agree to the one replacing it.

    What changed
    <the "What changed in this version" section of the new document, quoted
     from the document itself>

    The version you agreed to    DRAFT-1, still readable at <url>
    The version replacing it     DRAFT-2, below in full

Until you agree, Pull.fm keeps working for reading. Anything that would change
your data is refused: no new wishlist entries, no connecting another account, no
changes to your settings. Your data export and your right to delete your account
are not affected, and never are.

    [ I agree to the new Privacy Policy ]

    [ Not yet ]
```

The date, the previous version and the previous version's URL all come from the
`accepted` member that `GET /v1/me/consent` returns per document. The client does
not remember them; it is told them, from the append-only row, which is why a
reinstall does not turn a returning user into a new one.

The heading names the document that changed. When both changed, the heading is
`The Terms of Service and the Privacy Policy have changed` and the body carries
one block per document, each with its own prior date and version.

### 4.2 What changed, and the gap in it today

`[OPEN]` **No published document carries a "What changed in this version"
section, so there is nothing for the client to quote.** The rule from here on is
that a material revision adds one, at the top of the revised document, in the
document itself rather than in a field beside it. Three reasons it belongs in the
text: it is then covered by the same digest, so the summary a user was shown
cannot drift from the version it describes; it is served by the same route, so an
auditor reading a superseded version sees the summary that accompanied it; and it
needs no new column, no new API member, and no second place to forget. The
registry's `notes` field is not a substitute and is deliberately withheld from
the wire: it is written for a maintainer reading the revision table, and
`privacy-policy` DRAFT-1's `notes` is four hundred words about epoch arithmetic.

Until a document carries such a section, a client must show the document and must
not invent a summary of it. **An empty "What changed" is a disclosed gap; a
generated one is a statement we did not write being attributed to us at the
moment of formation.**

### 4.3 What `Not yet` does

It dismisses the screen and the subject continues in the read-only tier the copy
describes. It is not a trap and it is not a nag loop:

- The screen is reachable again, from the account screen, at any time.
- A refused write says why, and offers this screen, rather than failing opaquely.
- **Section 17 of the Terms promises notice in the application before a material
  change takes effect.** This screen is that notice, so it may be shown before
  the epoch is raised, and in that state the subject is not yet in
  `revision-pending` and nothing is refused. The epoch is raised only after the
  notice period has run, which is a decision the operator makes in one line of
  one diff.

`[OPEN]` **Section 17 of the Terms also says "Continuing to use Pull.fm after a
change takes effect means you accept it", and this interface does not rely on
that sentence and should not.** Continued use is the arrangement that lost in
`Sgouros`; the gate obtains an affirmative act instead, and is therefore stricter
than the clause. The clause is not currently false, because it describes a
fallback the product does not use, but it invites exactly the design this
document forbids and it should be narrowed at the next revision of the Terms.
Recorded here rather than silently corrected, because editing section 17 is a
materiality decision about the Terms and belongs in that document's diff.

---

## 5. Rules the interface must satisfy

The copy is necessary and not sufficient. These are the rules, stated as
prohibitions and requirements so a reviewer can check the screen against them.

### 5.1 Prohibited

- **No pre-ticked box.** A control that is already in the agreeing state when the
  screen appears records the interface's state, not a person's act.
- **No "by continuing you agree".** If proceeding is the assent, the button must
  say so, and then it is not "continuing".
- **No decline in small print.** `[ I do not agree ]` is a control of the same
  kind as the primary one, in the same type size, unobscured, and not behind a
  scroll.
- **No agreement inferred from scrolling to the end**, from time spent, or from
  any interaction other than the primary control.
- **No bundling.** Nothing else is agreed to, enabled, subscribed to, or opted
  into by the same act. The button agrees to two named documents and does
  nothing else.
- **No interstitial before the documents.** The full text is reachable from this
  screen without creating anything, sending anything, or dismissing anything.
- **No summary presented as the document.** The four highlights are labelled as
  what they are, and the documents are present in full on the same screen.
- **No dismissing the first-launch screen by any route that leaves the subject in
  the product.** There are two ways off it and they are both in section 3.

### 5.2 Required

- **The client fetches the canonical bytes and verifies the digest before
  displaying anything.** `GET /v1/legal` gives the digest; the document routes
  serve pre-normalised text, so a plain sha256 over the response body as received
  equals it, with no preprocessing. **A mismatch means the copy in hand is not
  the copy Pull.fm published, and the person must not be asked to accept it.**
  Show a failure, not a document.
- **The version displayed is the version accepted.** The client echoes the same
  `version` and `contentSha256` it displayed. A 409 means the document moved
  underneath it, and the answer is to re-read `GET /v1/me/consent` and present
  the new text, never to retry with a different digest.
- **Both documents are readable in full without leaving the screen**, at a size a
  person can read, scrollable, and selectable or copyable where the platform
  allows it.
- **The primary control is disabled until both documents have been fetched and
  verified.** Not until they have been scrolled: a person is entitled to decide
  without reading, and a scroll gate is a fiction about attention. What must be
  true is that the text was **there** to read.
- **A person who has agreed can read what they agreed to, at the version they
  agreed to, from the account screen.** `GET /v1/me/consent` returns it and the
  versioned document route serves it forever.
- **The same words on every platform.** A client that reworded this copy for its
  own tone would produce a set of users who were asked different questions, and
  no way to tell from a record which one any of them was asked.

---

## 6. What the record proves, and what it takes the client's word for

Stated here, in the document the record is about, and in full in
[`../docs/compliance/consent-evidence.md`](../docs/compliance/consent-evidence.md),
which is copied verbatim into every evidence bundle so that an auditor reads it at
the same time as the records.

**The server can prove that a request arrived, when, on which authenticated
session, carrying the correct version and the correct content digest of a
document it published.** That is a real and useful fact and it is not the whole
question.

**The server cannot prove that a screen was rendered, that these words were on
it, that a human read them, or that a human touched the control.** A client that
fetched the document, hashed it, and never displayed it would produce a record
indistinguishable from one where a person read every word. `client_build` and
`client_platform` do not fix this and are not evidence about the client: the
client supplies them.

This is why section 1.2 asks the client to render this copy from the API rather
than from its own build. That does not close the gap, and nothing available
server-side does. What it does is narrow it: **the words are then a published
fact rather than a claim about a binary**, so the remaining unknown is whether the
published words were displayed, rather than what the displayed words were.

**No field is added to `legal_consents` to cover this.** A column the client
fills in with "the user scrolled to the end" or "the screen was shown for eleven
seconds" would look like proof of the one thing that is not provable, and a record
that overstates what it establishes is worse in a dispute than one that is candid
about its limits.

---

## 7. Withdrawing, and what happens to the record

**There is no way to withdraw an acceptance, and that is correct rather than
missing.** Accepting these documents is contract formation, not consent in the
data-protection sense, and the way out of a contract is termination. For Pull.fm
that is `DELETE /v1/me`, or `Delete my account` from a client, which the Terms
section 15 states and which section 3.4 above puts on the decline screen. There
is deliberately no `withdrawn_at` column; migration
`packages/db/migrations/0008_legal_consent.sql` gives the reasoning, which is that
a nullable withdrawal column would be a mutable column on an append-only evidence
table and would invite an `UPDATE` path onto the one table that must never have
one.

**Deleting the account destroys the consent rows and keeps a narrower receipt.**
`legal_consents` cascades on account deletion, so the user id, the IP address, the
user agent and the session id go with the account. Before the cascade runs, the
deletion service writes a receipt into `deletion_log.consents`: which documents,
at which versions, with which digests, when, and at which gate. So the fact that
assent was given survives, and the identifiers that corroborated it do not. The
same migration argues that trade in four points, the shortest of which is that the
deletion notice we already publish says the account "and all data derived from it
have been deleted from the live database", and a surviving row carrying the
deleted user's id and IP address would make that a false statement.

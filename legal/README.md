# Legal documents

**Everything in this directory is a DRAFT and none of it has been reviewed by a
lawyer.** It is published in the repository so that the claims can be checked
against the code that makes them true or false, which is the only way a privacy
policy stays accurate.

> **Posture, since 2026-07-29: United States.** Pull.fm is offered to residents
> of the United States, the infrastructure is moving out of the European Union,
> and registration from the EEA, the United Kingdom and Switzerland is to be
> refused. `privacy-policy.md` and `terms-of-service.md` were rewritten for that
> and no longer carry a GDPR analysis. `attribution.md` is untouched and does not
> change: upstream licence and attribution obligations are contractual, not
> privacy law, so nothing about them turns on which country the service is
> offered in.

## Before publishing anything here, run this

```bash
make legal        # or: node legal/check-publication-blockers.mjs
```

It fails while any `[CONFIRM]` or `[OPEN]` marker remains, printing every one
with a file and a line, sorted worst first. It exists because "remember to
check" is not a control, and because two of the markers do more damage than the
rest.

### The two that were worse than incomplete, and are now closed

`terms-of-service.md` §16 used to carry `[CONFIRM: state]` and
`[CONFIRM: county/state courts]`. Published in that state the dispute framework
would have been **void**: no governing law, no forum, no consent to
jurisdiction, and the warranty disclaimer, the liability cap and the indemnity
all resting on a choice-of-law clause that chose nothing.

**Closed on 2026-07-29.** 312.dev LLC is organised in **Illinois**, which the
operator supplied. That one fact settled all three places it was needed: §16's
governing law, §16's venue, and the party identification in `terms-of-service.md`
§1 and `privacy-policy.md` §2.

**No county is named and that is deliberate.** The clause fixes the state and
both court systems in it, which is enough to be enforceable, and naming a county
would have meant guessing the LLC's principal place of business. Illinois also
has two federal districts, so "the Northern District" would have been a second
guess on top of the first. Narrowing it later costs nothing; guessing it now
would have been the same error the placeholders existed to prevent.

### The territorial claim, and the order it was written in

Both documents now say Pull.fm is offered to residents of the United States and
that registration from the EEA, the United Kingdom and Switzerland is refused.
**That sentence was drafted as an `[OPEN]` first**, because when it was drafted
no country check existed, and a legal document that says "United States only"
while European sign-ups succeed is a false statement of fact in a binding
agreement rather than a disclosed gap. It was only rewritten as a plain statement
after `apps/bff/src/lib/registration-geo.ts` and its two test suites were read.

That order matters more than the outcome. The failure this directory usually
guards against is a marker deleted to make a check pass; this is the same failure
arriving from the other side, a posture asserted before the control that makes it
true. Write the marker, then delete it when the code arrives.

Both documents also state what the control does **not** do, which is the other
half of the same discipline: it refuses account creation rather than blocking
access, and it is address-based geolocation rather than proof of residence, so
neither document claims that no European resident can hold an account.

| Document                                             | What it is                                                                                                               | Blocks                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`privacy-policy.md`](privacy-policy.md)             | What Pull.fm collects, stores, uses, and discloses, written from the schema and the handlers rather than from a template | **Gate L.** Also required by SeatGeek API terms 4.4                                                                                                                                                                                                                                                     |
| [`terms-of-service.md`](terms-of-service.md)         | Terms of Service and Application EULA, including the SeatGeek third-party-beneficiary clause                             | **Gate L.** Required by SeatGeek API terms 4.3, which makes it a hard prerequisite of shipping live events at all. 4.3 is quoted in full in that document's banner and verbatim in the vendor-spec file; do not paraphrase it here or anywhere else                                                     |
| [`consent-presentation.md`](consent-presentation.md) | The consent screen copy: what a person is shown and asked, plus the rules the interface must satisfy                     | **Nothing, and it is not a document anybody accepts.** Published, versioned and digest-locked like the two above, because the sentence above the button and the label on it are the evidence that assent was communicated (`Sgouros v. TransUnion`, 817 F.3d 1029), so a change to them can be material |
| [`attribution.md`](attribution.md)                   | The attribution each upstream requires, as a checklist a UI engineer executes                                            | A frontend build requirement, and a licence condition of Last.fm, MusicBrainz, Apple, Deezer, and SeatGeek                                                                                                                                                                                              |

## Three categories, and adding a file means choosing one

`apps/bff/test/integration/legal-versions.test.ts` reconciles this directory
against the registry in `apps/bff/src/lib/legal-documents.ts` **in both
directions**, so a new file here is a red build until it is classified. There are
three places it can go, and they are not interchangeable:

| Category                                        | Where it is declared                        | What it gets                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A document a user must accept                   | `CONSENT_DOCUMENTS`                         | Version, epoch, digest lock, stored text, a served URL, and **the gate**. Adding one makes it mandatory for every existing user immediately |
| A document that is published but never accepted | `PUBLISHED_DOCUMENTS`, via its own constant | Everything above **except** the gate. `consent-presentation.md` is the only one                                                             |
| Not a published document at all                 | `NON_CONSENT_LEGAL_FILES`                   | Nothing. No version, no digest, no record. `attribution.md` and this file                                                                   |

**The middle category exists because of the consent screen copy and it is worth
understanding before reusing it.** The copy has to be versioned and digest-locked
for the reason the documents are: a change to the words around the button can be
as material as a change to a clause. But it cannot be a `CONSENT_DOCUMENTS` entry,
because asking somebody to accept the words with which they are being asked to
accept is circular, and the screen would list itself among the documents it was
presenting. And it must not be a `NON_CONSENT_LEGAL_FILES` entry, because that list
records nothing, so the copy could change with nobody deciding what the change
meant.

`consent-presentation.md` also carries a `**Highlights checked against:**` line
that the same test compares to the registry, because it quotes figures and section
numbers out of the Terms. **Bumping the Terms turns that document red** until
somebody has re-read its section 3.1 against the new text. That is the one
dependency in this directory the digest lock cannot see, so it is checked
separately.

## How to read the markers

| Marker      | Meaning                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[OPEN]`    | **The system does not do what the surrounding sentence would claim.** A gap in the code, not in the writing. It must be closed in code, or the sentence rewritten, before publication. |
| `[CONFIRM]` | A decision the operator or counsel has to make. Must not survive into a published version.                                                                                             |

`privacy-policy.md` ends with an appendix listing every `[OPEN]` in one table.
That list is the real pre-publication checklist, and `make legal` is the machine
that refuses to let it be skipped.

**An `[OPEN]` is not a to-do to be tidied away.** It is the document declining to
claim something the system does not do. Deleting one to make the check pass
converts a disclosed weakness into a false statement of fact, which is the exact
thing this directory's accuracy standard exists to prevent, and in the United
States is the specific thing the FTC treats as a deceptive practice. Narrow the
wording, or close the gap in code. Never just remove the marker.

### The one case where removing a marker is right, and the test for it

A marker may be removed when **the obligation it records has genuinely stopped
existing**, and never merely because the section around it was deleted. The test
is a sentence: if you cannot justify the removal in one sentence that would
survive a regulator reading it, keep the marker.

The 2026-07-29 rewrite to a United States posture is the worked example. The
GDPR Article 27 representative, the Chapter V transfer safeguards and the
Standard Contractual Clauses were removed because Article 3(2) turns on who a
service is offered to, and Pull.fm is not offered to anyone in the Union; the
document says so in `privacy-policy.md` §9 rather than leaving the removal
unexplained. In the same pass the written-processor-contract marker was **kept**
and re-sourced from GDPR Article 28 to Massachusetts 201 CMR 17.03(2)(f) and the
New York SHIELD Act, because a materially similar duty survives the change of
jurisdiction with no threshold attached. Removing that one would have been the
lazy version of the same edit.

### The checker's old blind spot, which was in the script and is now fixed

**This section used to say that `MARKER` is matched line by line and cannot span a
newline. That is no longer true, and it was left stale.** The pattern in
`check-publication-blockers.mjs` is now

```js
/\[(CONFIRM|OPEN)\b(?:[^\]\n]|\n(?!\s*\n))*\]/g;
```

applied to the whole file. A marker may wrap across a line break; it may not cross
a blank line, and an unclosed bracket fails to match rather than swallowing the
rest of the section. So the `CLASSIFIED` entries that could previously never fire
(`CONFIRM with counsel: ...`, `CONFIRM: a postal address is required`) do fire, and
they are why the current count is what it is.

The history is worth keeping, because it is the exact failure this directory guards
against arriving inside the guard. Three markers in `terms-of-service.md` were
invisible for as long as the file had existed: the compiled-binaries question in
§3, the third-party-beneficiary question in §9 and the arbitration question in §16,
all three real unresolved counsel decisions that `make legal` was not counting.
With the governing-law placeholders filled, the terms would have reported **zero**
blockers while carrying three.

Those three are still written on a single long line each, which is why those
paragraphs do not wrap like their neighbours. **Do not re-wrap them** - it is no
longer load-bearing, but re-wrapping them is a diff that changes the digest of a
legal document for no reason, which forces a materiality decision nobody needed to
make. Prettier will not, since its markdown prose wrapping is left at `preserve`.

## Why the accuracy standard is higher here than in ordinary documentation

A privacy policy is a statement of fact about a system, made to the people whose
data is in it and to regulators. A wrong one is worse than none: it is a false
representation, and in the United States it is the specific thing the FTC treats
as a deceptive practice. So every claim in these documents was written by
reading the migration, the handler, or the Terraform that decides it, and where
the code does not support a claim the document says so instead of making it.

## Publication

These are not published yet. Gate L requires them at **stable URLs**, which means
a decision about where they live (a `pull.fm/legal/*` route, or rendered from
this directory) and a commitment that the URL does not move. Until then they are
drafts in a public repository, which is the honest state.

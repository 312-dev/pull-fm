# Legal documents

**Everything in this directory is a DRAFT and none of it has been reviewed by a
lawyer.** It is published in the repository so that the claims can be checked
against the code that makes them true or false, which is the only way a privacy
policy stays accurate.

## Before publishing anything here, run this

```bash
make legal        # or: node legal/check-publication-blockers.mjs
```

It fails while any `[CONFIRM]` or `[OPEN]` marker remains, printing every one
with a file and a line, sorted worst first. It exists because "remember to
check" is not a control, and because two of the markers do more damage than the
rest.

### The two that are worse than incomplete

| Where                     | Marker                           | Effect if published                                                                                                                              |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terms-of-service.md` §16 | `[CONFIRM: state]`               | **The dispute framework is void.** No governing law is selected, so the warranty disclaimer, the liability cap and the indemnity rest on nothing |
| `terms-of-service.md` §16 | `[CONFIRM: county/state courts]` | **No forum and no consent to jurisdiction.** Unenforceable as written                                                                            |

Both, plus `[CONFIRM: state of organisation]` in `terms-of-service.md` §1 and
`privacy-policy.md` §2, are the **same single fact**: the state under whose law
**312.dev LLC** is organised.

**That fact is not in this repository and must not be guessed.** Read it off the
company's certificate of formation or its registered-agent record. A guessed
state is worse than a blank one, because a blank stops publication and a wrong
one does not.

| Document                                     | What it is                                                                                                               | Blocks                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`privacy-policy.md`](privacy-policy.md)     | What Pull.fm collects, stores, uses, and discloses, written from the schema and the handlers rather than from a template | **Gate L.** Also required by SeatGeek API terms 4.4                                                               |
| [`terms-of-service.md`](terms-of-service.md) | Terms of Service and Application EULA, including the SeatGeek third-party-beneficiary clause                             | **Gate L.** Required by SeatGeek API terms 4.3, which makes it a hard prerequisite of shipping live events at all |
| [`attribution.md`](attribution.md)           | The attribution each upstream requires, as a checklist a UI engineer executes                                            | A frontend build requirement, and a licence condition of Last.fm, MusicBrainz, Apple, Deezer, and SeatGeek        |

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

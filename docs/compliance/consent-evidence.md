# What a Pull.fm consent record proves, and what it only asserts

> **Audience:** an auditor, a lawyer answering a dispute, and the next engineer to
> touch the consent code. It is written once, here, and
> `packages/db/scripts/consent-evidence.mjs` copies this file verbatim into every
> evidence bundle it produces, so the two cannot drift and so an auditor reads the
> limits at the same time as the records.
>
> **The short version, if you read nothing else.** The record proves that a request
> arrived, when, on which authenticated session, carrying the correct version and
> the correct content digest of a document Pull.fm published, and that nothing has
> rewritten that row since. **It does not prove that a screen was rendered, that a
> human read it, or that a human touched anything.** Under Illinois law the
> interface is the whole question, and the interface is the part the server cannot
> witness.

## 1. Why this document exists at all

A consent record that overstates what it establishes is **worse in a dispute than
one that is candid about its limits**. An opposing party who finds a column called
`user_confirmed_reading` will spend the deposition on it, and the answer will be
that a client filled it in, at which point every other field is read in that
light. A record that says plainly what it saw is a record whose surviving claims
are believed.

So the boundary is written down rather than left to be inferred from the schema,
and it is written down in the place both audiences will actually reach it: the
bundle, for someone who has records in front of them and no repository access, and
`docs/`, for someone about to add a field.

## 2. What the record proves

Each of these is a server-side observation, made by the process that wrote the
row, and each is checkable afterwards from the bundle.

| Proved                                                  | By what                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A request arrived and was accepted                      | The row exists. `POST /v1/me/consent` is the only writer of `legal_consents`, and it writes one row per document per version.                                                                                                      |
| When it arrived                                         | `accepted_at`, set by the database with `now()`, never supplied by the caller. `ON CONFLICT DO NOTHING` means a retry cannot move it forward.                                                                                      |
| Which account it arrived on                             | `user_id`, resolved from the credential before the handler runs.                                                                                                                                                                   |
| That it arrived on an interactive session, not a script | `auth_method`, plus the route's `allow: ["session"]`, plus `legal_consents_auth_method_chk`, which refuses any other value at the schema level. Widening it needs a migration as well as a diff.                                   |
| Which session                                           | `session_id`, the WorkOS `sid`. Ties the act to one authenticated session rather than to an account.                                                                                                                               |
| Which version was named                                 | `document_version`, compared against the published current version before the insert. A mismatch is a 409 and no row.                                                                                                              |
| That the caller held the digest of the published text   | `content_sha256`, compared against the published digest before the insert. A mismatch is a 409 and no row.                                                                                                                         |
| What that text actually was                             | `legal_document_revisions.content`, stored at publish time, with a `CHECK` that refuses text whose sha256 disagrees with the digest on its own row. The bundle ships the text, so the digest has a preimage anyone can recompute.  |
| Which of the two gates the subject was at               | `gate`, derived from whether the subject had any prior acceptance. **Server-derived, never taken from the request**, so a client cannot claim it showed a first-launch screen to a returning user.                                 |
| That the row has not been edited since                  | The `BEFORE UPDATE` trigger refuses every `UPDATE` on `legal_consents`, and refuses every `UPDATE` on `legal_document_revisions` except filling a NULL `content` with text matching the digest already on the row. `TRUNCATE` too. |
| What the words around the button were, on that date     | `consent-presentation`, published as a versioned revision with its own digest and text. See section 5.                                                                                                                             |

That set is not nothing. It is enough to answer "what agreement is this person
under, at what text, since when" with a document anyone can hash themselves.

## 3. What the record asserts on the client's word

These fields exist, they are useful, and **they are not evidence about the client**
because the client supplies them.

| Asserted          | Why it is recorded anyway                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_build`    | If a formation challenge is ever made about what a particular release displayed, this is what names the release. It is a lead to investigate, not a fact established. |
| `client_platform` | Same.                                                                                                                                                                 |
| `user_agent`      | Corroborates the shape of the caller. Trivially settable by the caller.                                                                                               |
| `ip`              | Corroborates that the request came from somewhere plausible for that person. Attributable to a network, not to a person, and not to an act.                           |

The wording used elsewhere in the codebase is the right wording here too: these
are **corroboration of the act for our benefit rather than data the subject
provided**. That is why `GET /v1/me/export` omits `ip` and `user_agent`, and it is
why section 7 of this document treats them differently in a bundle.

## 4. What the record does not even assert

**No column claims any of this, and none should be added.**

- That a screen was rendered.
- That these words were on it.
- That a human read them, or looked at them, or scrolled.
- That a human, rather than the client's own code, initiated the request.

A client that fetched the document, hashed it, and never displayed anything would
produce a row **indistinguishable** from one where a person read every word and
tapped the button. No server-side control closes that, and the reason is structural
rather than a gap waiting to be filled: the server's entire view of the interaction
is one HTTP request.

### 4.1 Why no field was added to close it, having considered several

The obvious candidates were considered and rejected, and the reasoning is the same
for all of them: **a field the client fills in is not evidence about the client.**

| Candidate                                      | Why it was rejected                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrolled_to_end boolean`                      | The client asserts it. It also encodes a fiction about attention: a person is entitled to decide without reading, and a scroll gate measures thumb travel.                                           |
| `displayed_ms integer`                         | The client asserts it, and it is the most misleading of the set because a number looks measured. Eleven seconds proves nothing about a person and would be quoted as if it did.                      |
| `presentation_version text` on the consent row | Tempting, and genuinely wrong. The client would be asserting which copy it showed. The same question is answered server-side and provably: see section 5.                                            |
| A client-side signature over the interaction   | Moves the problem rather than solving it. A key held by software the user controls signs whatever that software decides to sign, and it would add a key-distribution problem to a formation problem. |
| A screenshot or a rendered attestation         | Uploaded by the client, so asserted; and it would mean receiving and retaining an image of a person's screen, which is a large new personal-data holding bought with no evidential gain.             |

**If it cannot be proved server-side, the honest thing is to say so, not to add a
field that looks like proof.**

## 5. The one thing that was worth changing, and what it does and does not buy

The consent screen copy is now a published, versioned, digest-locked document
(`legal/consent-presentation.md`, registered as `consent-presentation`), served at
its own immutable versioned URL forever, and clients are asked to render it from
the API rather than from their own string tables.

**What that buys.** The words a client was told to display on a given date are a
server-side published fact with a digest and a retrievable text, rather than a
question about which build somebody had installed. It also makes a change to the
words around the button a versioned, reviewable decision that can be recorded as
material, which is the same standard the documents themselves are held to. The
epoch guard, the append-only trigger and the digest `CHECK` all apply to it
unchanged.

**What it does not buy, stated plainly so nobody quotes it as more.** It does not
prove the published words were displayed. The remaining unknown is narrowed from
"what did the screen say" to "was the published text shown", and the second
question is still not one the server can answer. **A consent row does not carry a
presentation version**, precisely because the only source for one would be the
client.

**A consent row can be associated with a copy version, server-side, by time.**
`legal_document_revisions.published_at` is set by the database, is immutable, and
is on the same append-only table; `legal_consents.accepted_at` likewise. So "which
copy version was the current published one when this person accepted" is derivable
from two server-set timestamps, needs no new column, and cannot be influenced by a
client. The evidence bundle computes it and labels it for what it is: **the copy
that was current, not the copy that was shown.**

## 6. What a bundle can be re-verified against, offline, by someone who does not trust us

A bundle asserting "these tables are append-only" would be worth very little; the
assertion is ours and the reader has no reason to accept it. These four checks need
nothing but the bundle, `sha256sum`, and a text editor.

### 6.1 The bundle has not been altered since it was produced

```bash
cd <bundle>
sha256sum -c SHA256SUMS
```

Ordinary coreutils format, one line per file, so this needs no tool of ours. It
proves internal integrity of the bundle and nothing about the database. Its real
job is to make the next three checks meaningful: a reader who has verified the
files can then reason about their contents.

### 6.2 The text is the preimage of the digest every consent row cites

**This is the strongest material in the bundle**, and it is the one that turns a
digest from decoration into evidence.

```bash
sha256sum documents/*.md
```

Compare each result with:

- `content_sha256` on the matching entry in `revisions.json`, and
- `content_sha256` on every consent row in `subject/*/consents.json` that names
  that document and version.

They must be equal. A digest with no retrievable text reads like proof while being
unfalsifiable; a digest whose text you have hashed yourself is a fact. This also
means the bundle cannot quietly ship different text from the text a record cites,
because the reader computes the binding rather than being told it.

### 6.3 The database is enforcing what we claim it enforces

`schema/append-only.sql` is not a copy of a migration file. It is read out of the
**live database** with `pg_get_functiondef`, `pg_get_triggerdef` and
`pg_get_constraintdef` at bundle time, so it is the definition Postgres is actually
running. Read it. It should show, and a reader should check for:

- a `BEFORE UPDATE` and a `BEFORE TRUNCATE` trigger on `legal_consents` calling a
  function whose body is an unconditional `RAISE EXCEPTION`;
- a `BEFORE UPDATE` trigger on `legal_document_revisions` whose only permitted
  transition is NULL `content` to text, with every other column compared for
  equality;
- `legal_document_revisions_content_digest_chk`, which recomputes sha256 over the
  stored text and refuses the row unless it equals the digest on that row;
- the epoch guard, which refuses a regressed epoch, a skipped epoch, and either
  direction of materiality lie.

If a trigger a bundle claims is present is absent from this file, the bundle
contradicts itself and the reader has found something real.

### 6.4 Nothing recorded has changed between two bundles

`MANIFEST.json` carries `recordsRootSha256`: a digest over a canonical, sorted
serialisation of every record in the bundle, **excluding** the generation
timestamp, the operator's flags and the file layout. So it is stable across runs
and moves if and only if a recorded row moved.

```bash
# Two bundles taken months apart:
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['recordsRootSha256'])" a/MANIFEST.json
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['recordsRootSha256'])" b/MANIFEST.json
```

Equal roots over the same query scope means no row in scope was added, removed or
rewritten in the interval. This is the only tamper-evidence in the system that does
not depend on trusting the database's own triggers, and it is worth exactly as much
as the independence of the party holding the earlier root.

## 7. What cannot be re-verified, and what would be needed

Said plainly, because a bundle that implied otherwise would be the same defect this
document is about.

- **A single bundle cannot prove immutability.** It is a snapshot. Everything in
  section 6.4 requires an _earlier_ root held by somebody who is not us. Two
  bundles from the same laptop on the same afternoon prove that nothing changed in
  an afternoon.
- **An operator with database superuser can defeat the triggers.** `ALTER TABLE
... DISABLE TRIGGER`, edit, re-enable, re-export, and the resulting bundle is
  internally consistent. What limits this is that the application role
  (`pullfm_app`) does not hold those privileges, that Neon's point-in-time recovery
  window is a separate copy the operator would also have to reach, and that the
  root digest would change. **Nothing prevents it.** Real tamper-evidence needs the
  root digest published to an append-only log outside the operator's control, and
  **there is no such log today.** The bundle prints the root prominently so that it
  can be recorded externally by whoever receives it, which is the cheapest
  available approximation and is not the same thing.
- **The bundle cannot show what a person saw.** Sections 3 and 4.
- **The bundle cannot show a refusal.** Declining records nothing, deliberately:
  the absence of a contract is fully represented by the absence of a row. So a
  bundle can never show that a named person declined, only that they have not
  accepted.

## 8. Withdrawal

There is no way to withdraw an acceptance and no `withdrawn_at` column, and this is
a design decision with its reasoning in the header of
`packages/db/migrations/0008_legal_consent.sql`. In summary: accepting the Terms is
**contract formation**, not consent in the GDPR Article 6(1)(a) sense, and it is
therefore not withdrawable. The way out of a contract is termination, which for
Pull.fm is `DELETE /v1/me` (Terms section 15), offered on the decline screen itself
so that a person who never agrees is not left with an account they can neither use
nor leave.

A nullable withdrawal column would also be a **mutable column on an append-only
evidence table**, which is a contradiction, and adding one would put an `UPDATE`
path on the one table that must never have one.

## 9. Retention, and the asymmetry an auditor should expect to see

`legal_consents` has `user_id ... ON DELETE CASCADE`, so an account deletion
destroys the consent history in the same transaction as everything else. Before the
cascade runs, the deletion service writes a narrower receipt into
`deletion_log.consents`: which documents, at which versions, with which digests,
when, and at which gate. No IP, no user agent, no session id, no client build.

**So the fact that assent was given survives an account deletion, and the
identifiers that corroborated it do not.** Migration 0008 argues that trade in four
points; the shortest is that the deletion notice already published to the user says
the account "and all data derived from it have been deleted from the live
database", and a surviving row carrying the deleted user's id and IP address would
make that a false statement in a compliance notice.

The practical consequence for an auditor, and the thing worth knowing before asking
for a bundle: **for a deleted account, the strongest available record is the
`deletion_log` receipt, and it is deliberately weaker than a live consent row.**
Retention for the establishment, exercise or defence of legal claims was available
(GDPR Article 17(3)(e) and the CCPA carve-outs) and was **not used**, which is a
decision rather than an oversight.

## 10. The redaction position, and why it is the reverse of the subject's own export

`GET /v1/me/export` gives a subject their consent history and **excludes** `ip` and
`user_agent`, because those "corroborate the act for our benefit and are not data
the subject provided", and echoing an address into a portable file a person may
forward is a disclosure with no portability value.

An evidence bundle is precisely the "our benefit" case, so the same two fields are
available there. They are still **redacted by default**, and the asymmetry is
deliberate in both directions:

| Section of a bundle               | `ip`, `user_agent`, `session_id`                             | `email`           |
| --------------------------------- | ------------------------------------------------------------ | ----------------- |
| Subject dossier, default          | Redacted to a presence flag: `ipPresent: true`               | Absent            |
| Subject dossier, `--unredact`     | Present, and the reason given is recorded in the bundle      | Present           |
| Outstanding cohort, any flags     | **Never present.** Not redacted on request: absent by design | **Never present** |
| Revision diff and re-consent list | **Never present**                                            | **Never present** |

Three rules behind that table:

1. **A presence flag is informative and not disclosing.** "There was an IP address
   on this row" answers most of what an auditor wants to know about whether the act
   was corroborated, without putting an address in a file that will be emailed.
2. **`--unredact` requires `--reason`, and the reason is written into the
   bundle.** An unredacted bundle therefore carries the justification for its own
   existence, which is the only control available once a file exists on a laptop.
3. **The cohort listing is never unredactable.** "Who has not accepted the current
   epoch" is answered by a count and a list of opaque user ids. Corroborating
   details of an act that has not happened do not exist, and a roster of every
   user's email address is a data-exfiltration path wearing a compliance label.

## 11. How a bundle is produced, and the two properties of the producer that matter

```bash
PGURL_ITEM='pull-fm/staging/DATABASE_URL' \
  node packages/db/scripts/consent-evidence.mjs --out ./evidence-run
```

- **It runs inside a single `REPEATABLE READ, READ ONLY` transaction.** One
  snapshot, so no two sections of a bundle can disagree with each other; and the
  transaction cannot write, so **producing the evidence cannot alter the evidence**.
  That is asserted by the database rather than by the script's good intentions.
- **It is an operator script, not an API endpoint**, and that is the right shape
  here. An external auditor does not get credentials to a production API, Pull.fm
  is operated by one person, and an authenticated `GET /v1/admin/consent-evidence`
  would be a permanently reachable route that returns every user's consent history
  and IP addresses. A script produces a file, on demand, with the request recorded
  in the file, and adds no attack surface to the running service.

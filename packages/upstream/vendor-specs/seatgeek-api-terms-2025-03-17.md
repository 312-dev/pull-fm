# SeatGeek API/SDK Terms of Use - clause record

**Terms last updated by SeatGeek: 2025-03-17.**
**First relayed as a paraphrase: 2026-07-28. Read in full and transcribed:
2026-07-29.**

## Read this first: what changed on 2026-07-29, and why it matters

> **THIS FILE USED TO BE A PARAPHRASE OF THE CLAUSE THAT DECIDES WHETHER WE MAY
> SHIP EVENTS AT ALL, AND THE PARAPHRASE WAS WRONG IN BOTH DIRECTIONS.**
>
> Until 2026-07-29 this document was a digest in which only passages marked
> _verbatim_ were exact, and **clause 4.3 was not one of them**. Three separate
> documents in this repository rendered 4.3's "at least as protective" standard
> three different ways: `docs/SCORECARD.md` had the full standard, `docs/PLAN.md`
> section 11.6/§10e reduced it to "naming the SeatGeek Entities as third-party
> beneficiaries", and this file dropped the protectiveness standard entirely and
> kept only the beneficiary designation. A requirement recorded three ways is a
> requirement nobody can check, and the one that decided a shipping gate was the
> shortest of the three.
>
> The paraphrase also **mis-numbered the clauses**. It cited "7.13" and "7.15"
> for prohibitions that live in **4.7 (Rules of Conduct)**, "8.1" for a
> confidentiality obligation that lives in **section 5**, and "9.2" for the
> liability cap that is **8.2**. Section 7 is Suspension and Termination and has
> no subsection 13; section 9 is Representations and Warranties. Every one of
> those citations had been copied into source comments, tests, runbooks and a
> frontend checklist, so the wrong number was in eleven files.
>
> **The terms are now transcribed rather than summarised.** The operator opened
> `https://seatgeek.com/api-terms` in a signed-in browser and supplied the text.
> The two clauses that drive the legal documents (4.3 and 8.2) are quoted exactly
> below and marked **VERBATIM**. The rest of section "Clauses that drove code" is
> still a summary, and is still labelled as one.

`https://seatgeek.com/api-terms` returns **HTTP 403 to automated fetches**, so
none of this can be re-verified by tooling. Anyone re-auditing must obtain the
document the same way - open the URL in a real browser while signed in - and must
not conclude from a 403 that the terms are unavailable, that this record is
complete, or that a paraphrase is good enough. The last time somebody accepted a
paraphrase it cost a wrong liability cap in a published-draft EULA and eleven
wrong clause citations.

**Re-audit before launch and quarterly after.** Section 1 provides that the terms
may change at any time and that continued use is acceptance, so a transcription
ages exactly as badly as a digest did.

## Section map of the real document

Recorded because a clause citation with no map behind it is how the "7.13" error
survived for as long as it did. If a future citation does not resolve against
this map, the citation is wrong, not the map.

| Section | Title                                   | Subsections named in the document                                                                                                                  |
| ------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Introduction                            | Includes the change-of-terms provision: they may change at any time and continued use is acceptance                                                |
| 2       | License and Access                      |                                                                                                                                                    |
| 3       | SeatGeek Marks                          | **3.1** logo attribution                                                                                                                           |
| 4       | Applications                            | **4.1** Responsibility, **4.2** Application Review, **4.3** EULA, **4.4** Privacy Policy, **4.5** Audit, **4.6** PCI-DSS, **4.7** Rules of Conduct |
| 5       | Security and Confidentiality            | **5.3** Security Incidents. **5.4** is the subsection that survives termination                                                                    |
| 6       | Our Proprietary Rights                  |                                                                                                                                                    |
| 7       | Suspension and Termination              | **7.2** survives termination. **There is no 7.13 or 7.15 - those were our error**                                                                  |
| 8       | Disclaimers and Limitation of Liability | **8.2** Limitation of Liability, capped at USD 50                                                                                                  |
| 9       | Representations and Warranties          | **Not the liability cap.** "9.2" in our old digest was 8.2                                                                                         |
| 10      | Indemnification                         |                                                                                                                                                    |
| 11      | Public Announcements                    |                                                                                                                                                    |
| 12      | Miscellaneous                           | **12.2** Governing Law: New York, exclusive venue New York County NY, six-month limitation on causes of action against us                          |

**Sections 4, 5.4, 6, 7.2, 8, 9, 10, 11 and 12 survive termination.** Section 4
surviving in whole is the consequential one: the EULA duty in 4.3 and every
prohibition in 4.7 **outlive our use of the API**. Turning the events route off
does not retire them, and neither does losing access.

## 4.3 EULA - VERBATIM

This is the clause that makes `legal/terms-of-service.md` a shipping gate rather
than paperwork. It is quoted in full because every earlier summary of it lost
something that turned out to matter.

> **VERBATIM** (SeatGeek API Terms of Use dated 2025-03-17, clause 4.3, EULA)
>
> "You will ensure that each Application displays, and you will require each End
> User to accept before using your Application, an end user agreement or terms of
> service ("Application EULA") that contains terms (including, without
> limitation, warranty disclaimers and limitations of liability) at least as
> protective of the SeatGeek Entities as the terms hereof and that complies with
> any third-party app store requirements. You will: (i) use all reasonable
> efforts to enforce the Application EULA; and (ii) ensure that no Application
> takes any action on behalf of any End User, collects any information from or
> regarding any End User, or accesses or provides access to any portion of an End
> User's mobile or other device, in each case without having been affirmatively
> authorized or directed to do so by such End User. The Application EULA must
> expressly designate the SeatGeek Entities as third-party beneficiaries entitled
> to enforce the Application EULA against End Users directly."

**Six distinct duties, not one.** The paraphrase carried duty 5 and half of duty
3, which is why they are numbered here:

1. **Display.** The Application must display the EULA.
2. **Acceptance before use.** Each End User must be **required to accept it
   before using the Application**. Not "made available", not "linked in a
   footer". This is the duty a sideloaded GitHub Release with no first-launch
   consent gate fails, and it is a second, contractual reason for the `[OPEN]`
   in `legal/terms-of-service.md` section 1 that is already there on
   contract-formation grounds.
3. **At least as protective of the SeatGeek Entities**, with warranty
   disclaimers and limitations of liability called out expressly. This is what
   makes 8.2 load-bearing: their own cap on themselves is **USD 50**, so any cap
   we extend to them must be USD 50 or lower. Our EULA capped them at USD 100
   until 2026-07-29 and was therefore **less** protective of them than their own
   terms, in the one respect 4.3 names by name.
4. **Complies with any third-party app store requirements.** Currently vacuous:
   distribution is signed GitHub Release assets, so no store's requirements are
   incorporated. It reattaches on the day Pull.fm enters any store, and Gate S
   was retired on the assumption that no store is involved.
5. **Express third-party-beneficiary designation**, enforceable by the SeatGeek
   Entities **against End Users directly**.
6. **(i) reasonable efforts to enforce it, and (ii) no action on behalf of, no
   collection of information from or regarding, and no access to any part of the
   device of, an End User without that End User's affirmative authorisation.**
   (ii) is an operative product constraint that had never been recorded anywhere
   in this repository. Note that it is **not limited to SeatGeek data**: it is a
   duty about the Application's behaviour towards its End Users in general.

**The canonical one-sentence rendering of 4.3**, to be used identically wherever
this requirement is summarised (`docs/SCORECARD.md`, `docs/PLAN.md`,
`legal/README.md`, `legal/terms-of-service.md`):

> An Application EULA that the Application displays and that each End User must
> accept before using it, containing terms - expressly including warranty
> disclaimers and limitations of liability - **at least as protective of the
> SeatGeek Entities as SeatGeek's own API Terms**, complying with any third-party
> app-store requirements, and **expressly designating the SeatGeek Entities as
> third-party beneficiaries entitled to enforce it against End Users directly**;
> plus (i) all reasonable efforts to enforce it and (ii) no action on behalf of,
> collection of information from or regarding, or device access for any End User
> without that End User's affirmative authorisation.

## 8.2 Limitation of Liability, final sentence - VERBATIM

> **VERBATIM** (SeatGeek API Terms of Use dated 2025-03-17, clause 8.2, final
> sentence)
>
> "OUR MAXIMUM AGGREGATE LIABILITY FOR ALL DAMAGES, LOSSES, AND CAUSES OF ACTION
> IN CONNECTION WITH SEATGEEK TECHNOLOGY AND THESE API TERMS, WHETHER IN
> CONTRACT, TORT (INCLUDING NEGLIGENCE), OR OTHERWISE, SHALL BE FIFTY U.S.
> DOLLARS ($50.00)."

Two consequences, and the second one is the one that was missed for a year:

1. **Availability is best-effort by contract.** Fifty dollars is the whole
   remedy for any outage, corruption, or withdrawal of the API. The circuit
   breaker, the kill switch and the honest empty state are the correct posture,
   and nothing user-facing may depend on SeatGeek being up.
2. **It sets the ceiling for our own EULA.** Read with 4.3, USD 50 is the most
   protective number they grant themselves, so it is the maximum we may leave
   them exposed to in `legal/terms-of-service.md`. It is quoted in capitals here
   because the original is in capitals, which is itself a conspicuousness
   decision a court may read as part of "protective".

## Clauses that drove code, and what they changed

Everything in this table is a **summary**, with the two exceptions marked
_verbatim_. Clause numbers are the corrected ones; the old wrong number is shown
where a reader might be holding a stale citation.

| Clause                     | Requirement                                                                                                                                                                                                                                                                                                                                                 | What it changed in this package                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **3.1**                    | Attribution must be the **SeatGeek logo**, displayed "in every place in your Application where SeatGeek Materials are being accessed, used, or displayed", linking to `seatgeek.com`, per their Brand Guidelines. Asset and Guidelines at `https://seatgeek.com/press`. Proportional resizing is permitted without approval; any other modification is not. | `ProviderAttribution` in `src/events/types.ts` replaced a credit string. It carries `logoRequired`, `logoAssetPage`, `linkUrl`, and `logoModification`. **This is a UI obligation the backend cannot discharge**; it can only refuse to hand back a bare string a frontend would render as text and consider done.                   |
| **4.2**                    | **Application Review.** SeatGeek may review the Application and **require changes to it** as a condition of continued access.                                                                                                                                                                                                                               | Nothing in code. Recorded because it is a launch risk with no engineering mitigation: a shipped, sideloaded, self-updating client that SeatGeek can require changes to is a client that needs a working update path before events are enabled. Tracked in `docs/SCORECARD.md` Gate L.                                                |
| **4.3**                    | _Verbatim above._ Application EULA, accepted before use, at least as protective of the SeatGeek Entities as these terms, expressly designating them as third-party beneficiaries.                                                                                                                                                                           | Gate L item, and the reason `legal/terms-of-service.md` sections 8, 9, 11, 13 and 14 are shaped the way they are. Section 13 caps the SeatGeek Entities at **USD 50** because of 8.2. **Not satisfiable in code**, and duty 2 (acceptance before use) is not satisfiable by a backend at all.                                        |
| **4.4**                    | _Verbatim:_ "the SeatGeek API is not intended for Personal Data, and you agree to not input or process Personal Data using the SeatGeek API." A Privacy Policy is also contractually required.                                                                                                                                                              | `EventsQuery` has **no coordinate and no postal-code field**. `assertNoPersonalData()` in `src/seatgeek/client.ts` enforces a parameter allow-list and rejects coordinate-, coordinate-pair-, email- and postal-shaped values before a URL is built. Callers holding coordinates must resolve them to a city name first.             |
| **4.5**                    | **Audit.** SeatGeek may audit our compliance.                                                                                                                                                                                                                                                                                                               | Nothing in code, and it is the reason this file exists in the form it does. An audit is answered with the record, not with recollection.                                                                                                                                                                                             |
| **4.6**                    | **PCI-DSS**, where card data is handled.                                                                                                                                                                                                                                                                                                                    | **Not applicable and structurally so:** Pull.fm takes no payments, holds no card data, and is locked non-commercial (`docs/PLAN.md` section 1a). Recorded so that a future payments feature trips over it.                                                                                                                           |
| **4.7** (was cited "7.13") | **Rules of Conduct.** Prohibits placing SeatGeek Materials into "a search engine, directory, or AI or machine learning application or model", and prohibits **systematically downloading or storing** SeatGeek Materials.                                                                                                                                   | Performer-id TTL cut from 30 days to **7**; event TTL stays at 6 hours as ordinary operational caching. The **bulk performers dump parser was deleted outright** (see below). `EventsProviderMetadata.redistributionRestricted` surfaces the downstream-exposure restriction at the integration point.                               |
| **4.7** (was cited "7.15") | Same Rules of Conduct section: no use for competitive purposes and no operating a secondary ticket marketplace.                                                                                                                                                                                                                                             | We do neither. **Do not add price comparison later**; the events surface is "is this artist playing near me" plus a link out, and it must stay that.                                                                                                                                                                                 |
| **5.3**                    | Any suspected **Security Incident** must be reported to SeatGeek "as soon as possible, and in no event later than 24 hours thereafter", **and they must be consulted before any public communication about it**.                                                                                                                                            | Runbook obligation, not code. Now a numbered step with a clock in `docs/RUNBOOK-INCIDENT.md` section 5a, including the consultation duty, which had never been recorded and which collides with the "notify users without undue delay" instinct.                                                                                     |
| **5** (was cited "8.1")    | **Security and Confidentiality.** API credentials are Confidential Information. The exact subsection is not recorded here because it was not transcribed; **5.4** is the part that survives termination.                                                                                                                                                    | Our existing handling (1Password only, HTTP Basic so the credential never enters a URL, never logged, never in an error message) is **contractually required**, not merely good practice. Tests assert the id and secret cannot appear in a URL or an error string.                                                                  |
| **8.2** (was cited "9.2")  | _Verbatim above._ SeatGeek's maximum aggregate liability is **USD 50**.                                                                                                                                                                                                                                                                                     | Availability is best-effort by contract, and this number is the ceiling on what our own EULA may leave the SeatGeek Entities exposed to.                                                                                                                                                                                             |
| **11**                     | **Public Announcements.**                                                                                                                                                                                                                                                                                                                                   | Not transcribed in detail. Assume any public statement naming SeatGeek as a partner needs their agreement, and read the clause before writing a launch post. Survives termination.                                                                                                                                                   |
| **12.2**                   | **Governing law: New York**, exclusive venue in the state and federal courts of **New York County, NY**. Any cause of action **by us** must be brought **within six months**. **There is no arbitration clause.**                                                                                                                                           | Two consequences. The six-month limitation means a dispute with SeatGeek has to be recognised and acted on fast, which is an argument for keeping this file current. And their terms do **not** compel arbitration, so 4.3's "at least as protective" applies **no** downward pressure toward an arbitration clause in our own EULA. |
| **1**                      | Terms may change at any time; continued use constitutes acceptance.                                                                                                                                                                                                                                                                                         | An argument for subscribing to SeatGeek's announcement-only Google Group. A term can become binding on us with no notification we would otherwise see. (The old digest cited "1.3" for this; the subsection was not re-verified on 2026-07-29, only the section.)                                                                    |

## The bulk performers dump: deleted, not disabled

An earlier revision of this package included `seatgeek/bulk-performers.ts`, a
parser for SeatGeek's hourly JSONL performers dump. It was written to make a
future name -> performer-id backfill cheap, and deferred for operational
reasons.

**Clause 4.7 makes it the wrong thing to own.** Ingesting a whole-catalogue dump
into local storage is close to the definition of "systematically downloading or
storing SeatGeek Materials". The module was therefore **deleted rather than left
in the tree behind a comment**: dormant code with a "do not enable" note is an
invitation, and the person who enables it in eighteen months will not read this
file first.

If a licensed bulk path is ever negotiated, it is recoverable from git history
(commit `705a3d8`), and re-adding it should require the same conversation that
this deletion records.

## What the frontend now owes

1. Render the **SeatGeek logo** (from their press page, per the Brand
   Guidelines) wherever event data appears - not the string "SeatGeek".
2. Link **every instance** of that logo to `https://seatgeek.com`.
3. Resize proportionally only. No recolouring, cropping, or effects.
4. Do not render, or invent, any price. SeatGeek return none.
5. **Present the EULA and require acceptance before the application is usable**
   (4.3 duty 2), and take no action on behalf of the user, collect no
   information from or about them, and touch no part of their device without
   their affirmative authorisation (4.3 duty 6(ii)).

## What other backend surfaces now owe

Event data must **not** be exposed through the per-user API token surface, a
public feed, or anything reachable by a crawler or a model, unless that path is
separately gated and reviewed against clause 4.7. This is not a restriction we
can satisfy by intending well: the moment a token holder can retrieve
SeatGeek-derived data, a third party's integration can put it somewhere the
clause forbids.

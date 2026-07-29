# SeatGeek API/SDK Terms of Use - clause digest

**Terms last updated by SeatGeek: 2025-03-17.**
**Retrieved by the operator: 2026-07-28.** Recorded here: 2026-07-28.

## Read this first: what this file is, and is not

This is a **digest of the clauses that drove design decisions**, not a copy of
the terms. Only the passages marked _verbatim_ are quoted exactly; everything
else is a paraphrase.

`https://seatgeek.com/api-terms` returns **HTTP 403 to automated fetches**. Two
separate attempts from tooling failed, which is why this file exists at all: the
operator retrieved the terms out of band and relayed the binding clauses. Anyone
re-auditing must obtain the full document the same way - open the URL in a real
browser while signed in - and should not conclude from a 403 that the terms are
unavailable or that this digest is complete.

**Re-audit before launch and quarterly after**, and note clause 1.3 below: the
terms can change at any time and continued use is acceptance, so a digest ages
badly.

## Clauses that drove code, and what they changed

| Clause   | Requirement                                                                                                                                                                                                                                                                                                                                             | What it changed in this package                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3.1**  | Attribution must be the **SeatGeek logo** from `https://seatgeek.com/press`, displayed in every place SeatGeek Materials are accessed, used, or displayed, with **every instance linking to the SeatGeek homepage**. Brand Guidelines at the same URL govern usage; proportional resizing is permitted without approval, any other modification is not. | `ProviderAttribution` in `src/events/types.ts` replaced a credit string. It carries `logoRequired`, `logoAssetPage`, `linkUrl`, and `logoModification`. **This is now a UI obligation**: the backend cannot discharge it, it can only refuse to hand back a bare string that a frontend would render as text and consider done. |
| **4.4**  | _Verbatim:_ "the SeatGeek API is not intended for Personal Data, and you agree to not input or process Personal Data using the SeatGeek API." A Privacy Policy is also contractually required.                                                                                                                                                          | `EventsQuery` has **no coordinate and no postal-code field**. `assertNoPersonalData()` in `src/seatgeek/client.ts` enforces a parameter allow-list and rejects coordinate-, email-, and postal-shaped values before a URL is built. Callers holding coordinates must resolve them to a city name first.                         |
| **7.13** | Prohibits **systematically downloading and/or storing** SeatGeek Materials, and prohibits making them available to **"a search engine, directory, or AI or machine learning application or model."**                                                                                                                                                    | Performer-id TTL cut from 30 days to **7**; event TTL stays at 6 hours as ordinary operational caching. The **bulk performers dump parser was deleted outright** (see below). `EventsProviderMetadata.redistributionRestricted` surfaces the downstream-exposure restriction at the integration point.                          |
| **7.15** | No use for competitive purposes and no operating a secondary ticket marketplace.                                                                                                                                                                                                                                                                        | We do neither. **Do not add price comparison later**; the events surface is "is this artist playing near me" plus a link out, and it must stay that.                                                                                                                                                                            |
| **5.3**  | Any suspected **Security Incident must be reported to SeatGeek within 24 hours**.                                                                                                                                                                                                                                                                       | Runbook obligation, not code. Flagged to the coordinator for the incident runbook.                                                                                                                                                                                                                                              |
| **8.1**  | API credentials are **Confidential Information**.                                                                                                                                                                                                                                                                                                       | Our existing handling (1Password only, HTTP Basic so the credential never enters a URL, never logged, never in an error message) is **contractually required**, not merely good practice. Tests assert the id and secret cannot appear in a URL or an error string.                                                             |
| **9.2**  | SeatGeek's total liability is capped at **fifty dollars**.                                                                                                                                                                                                                                                                                              | Availability is best-effort by contract. The circuit breaker, the kill switch, and the honest empty state are the correct posture; nothing user-facing may depend on SeatGeek being up.                                                                                                                                         |
| **4.3**  | An **Application EULA** is required, and it must name SeatGeek Entities as **third-party beneficiaries**.                                                                                                                                                                                                                                               | Gate L item. **Hard dependency of shipping events at all** - not satisfiable in code.                                                                                                                                                                                                                                           |
| **1.3**  | Terms may change at any time; continued use constitutes acceptance.                                                                                                                                                                                                                                                                                     | Another argument for subscribing to SeatGeek's announcement-only Google Group. A term can become binding on us without any notification we would otherwise see.                                                                                                                                                                 |

## The bulk performers dump: deleted, not disabled

An earlier revision of this package included `seatgeek/bulk-performers.ts`, a
parser for SeatGeek's hourly JSONL performers dump. It was written to make a
future name -> performer-id backfill cheap, and deferred for operational
reasons.

**Clause 7.13 makes it the wrong thing to own.** Ingesting a whole-catalogue
dump into local storage is close to the definition of "systematically
downloading and/or storing SeatGeek Materials". The module was therefore
**deleted rather than left in the tree behind a comment**: dormant code with a
"do not enable" note is an invitation, and the person who enables it in eighteen
months will not read this file first.

If a licensed bulk path is ever negotiated, it is recoverable from git history
(commit `705a3d8`), and re-adding it should require the same conversation that
this deletion records.

## What the frontend now owes

1. Render the **SeatGeek logo** (from their press page, per the Brand
   Guidelines) wherever event data appears - not the string "SeatGeek".
2. Link **every instance** of that logo to `https://seatgeek.com`.
3. Resize proportionally only. No recolouring, cropping, or effects.
4. Do not render, or invent, any price. SeatGeek return none.

## What other backend surfaces now owe

Event data must **not** be exposed through the per-user API token surface, a
public feed, or anything reachable by a crawler or a model, unless that path is
separately gated and reviewed against clause 7.13. This is not a restriction we
can satisfy by intending well: the moment a token holder can retrieve
SeatGeek-derived data, a third party's integration can put it somewhere the
clause forbids.

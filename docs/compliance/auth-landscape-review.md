# Auth landscape review: what should hold Pull.fm's identities?

**Researched 2026-07-28 and 2026-07-29.** The Better Auth section was verified by downloading and reading the
published package source (`better-auth@1.6.25`, `@better-auth/core@1.6.25`,
`@better-auth/utils@0.4.2`, `@better-auth/redis-storage@1.6.25`) from npm on that date, not from
documentation and not from memory. Vendor and project claims elsewhere were checked against live
pages on that date. Where a page was unreachable or a claim could not be confirmed, this document
says so rather than filling the gap.

**Convention:** text in a blockquote marked **VERBATIM** is copied exactly from the cited source.
Everything else is the reviewer's paraphrase or judgement. Findings are labelled **[verified]**
when read directly out of source or a live page, and **[inferred]** when reasoned from those facts.

**Known limits of this review.** Two WorkOS documentation URLs returned HTTP 404 during the review
(`workos.com/docs/data-residency`, `workos.com/docs/security`) and are recorded as unreachable
rather than reconstructed. The session's web-search budget was exhausted partway through, so some
landscape entries rest on fewer independent sources than others; those are flagged in place. No
claim below was filled in from memory to cover a gap.

---

## The question, and the criterion

The operator's requirement, in their words:

> **VERBATIM** (operator, 2026-07-28)
> "We need something that minimizes exposure / risk."

That is the criterion. Not feature richness, not developer experience, not elegance. Pull.fm is a
non-commercial, donation-funded, public consumer app run by one person with no on-call, and it
stores **other people's third-party credentials** (ListenBrainz tokens, Last.fm session keys) under
AES-256-GCM envelope encryption in `user_oauth_connections`. A breach here is not our embarrassment,
it is other users' accounts. Blast radius outranks everything else.

---

## Verdict

**Stay on WorkOS. Do not adopt Better Auth in-process. Do not self-host an auth service. Do not
adopt Neon Auth.**

The cost of switching exceeds the benefit, and for this specific operator the current setup is
already the right risk trade-off. That is the honest answer, and it is not the answer that would be
reached by defaulting to the proposal on the table.

The reasoning in one paragraph. Pull.fm's auth is already **the least dangerous component in the
system**. WorkOS holds no session material in our database, cannot read `user_oauth_connections`,
cannot reach the KEK, costs **$0 at our scale and stays $0 to 1M MAU**, and is professionally
pentested every year. Every alternative either moves auth code into the process that holds the KEK
(Better Auth, Auth.js), or hands us a patching obligation on the credential-holding service with no
on-call (Kratos, Zitadel, Keycloak, Logto, Authentik, Casdoor, self-hosted Hanko or Supabase), or is
Beta software pinned to a six-month-old dependency with a live High-severity advisory (Neon Auth).
None of those reduces exposure. Several increase it materially.

**The one genuine argument for moving is not security, it is EU data residency**, and it should be
handled on its own terms rather than by rewriting working authentication code. See "What would have
to be true for this to be wrong" below.

### The strongest case against this recommendation

One of the two independent research passes reached the opposite conclusion about the incumbent, and
it deserves to be stated in its own terms rather than paraphrased away. Its argument: WorkOS is
US-only per its own DPA, offers no credential export path, is B2B-positioned so we are a non-customer
they tolerate rather than serve, and is **the only vendor here with a CVE against the hosted login
service itself** (CVE-2025-23017, an MFA bypass by enrolling a new factor). On that reading, $0 is
the only axis WorkOS wins.

Three of those four are true. Here is why they still do not flip the recommendation, and where the
argument does land:

- **The export objection does not apply to us.** It is the strongest general-purpose criticism of
  WorkOS and it is nearly irrelevant here, because `PLAN.md` section 4 already decided we issue no
  passwords. There are no hashes to hold hostage. The same pass applied "largely moot for a
  passwordless app" to other vendors and then scored WorkOS down for it; that is inconsistent, and
  the consistent reading is that credential export is a non-criterion for this project.
- **The service CVE cuts the other way.** CVE-2025-23017 was found, patched by the vendor on
  2025-01-07 and disclosed with a no-exploitation finding, and **we would have done nothing**. That
  is the hosted model working. Compare the alternative: 31 advisories in Better Auth, each of which
  is our pager.
- **The B2B-positioning point is real but is a continuity risk, not an exposure risk**, and it is
  already mitigated by M23 plus the no-password decision, and made less likely by a $100M Series C at
  a $2B valuation.
- **The residency point is correct and is the one that lands.** It is why this document gives it top
  billing as the single genuine reason to move, and why Descope is second on the shortlist rather
  than absent.

The honest summary: the case against WorkOS is a good case, and it is a case about **compliance
posture**, not about blast radius. The criterion given was minimise exposure and risk. On exposure,
WorkOS still wins, because it holds nothing of ours and cannot reach the vault.

### Ranked shortlist

| #     | Option                       | Isolation                                   | Users in our DB                           | Cost @10k / @50k MAU                                                                         | EU                | Verdict                                       |
| ----- | ---------------------------- | ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------- |
| **1** | **Stay on WorkOS**           | Hosted, isolated                            | No (exportable; no password hashes exist) | **$0 / $0**                                                                                  | **No**            | **Recommended**                               |
| 2     | Descope                      | Hosted, isolated                            | No                                        | $249 / ~$2,049 list; EU region gated at $799. Plausibly ~$0 on non-profit or startup pricing | **Frankfurt**     | Best option **if residency binds**            |
| 3     | Hanko (Cloud or self-hosted) | Separate process, **own separate Postgres** | Self-hosted: yes, in a DB of its own      | $0 / ~$429 Cloud                                                                             | **German vendor** | Best isolation; weakest assurance             |
| 4     | Auth0                        | Hosted, isolated                            | No                                        | $0 / $3,500                                                                                  | EU, no sub-region | Cheap EU fallback; Okta support-plane history |

Everything else is eliminated:

- **Better Auth in-process:** 31 advisories including 4 Criticals, **no third-party audit ever**,
  plaintext session tokens in the same Postgres as the credential vault, one advisory invisible to
  `npm audit`, a single npm publisher account for a 6.18M-download package, latest-version-only
  support with **no documented stability or deprecation policy**, and unresolved governance after the
  Vercel deal. See below and Appendix A.
- **Neon Auth:** Beta, pinned to Better Auth 1.4.18 (inside the affected range of a CVSS 8.3
  advisory, 37 releases stale), and our architecture is on its documented unsupported list.
- **Auth.js / NextAuth:** never reached 1.0, v5 has 33 betas and no stable release, no Fastify
  integration after a 2.5-year-old open PR, session tokens stored plaintext by `@auth/pg-adapter`
  with no override, and its own security policy says the `@auth/*` packages are
  > **VERBATIM** (https://authjs.dev/security)
  > "not considered ready for production yet"
- **Lucia:** deprecated, no upstream. **Passage:** retired 2026-01-16. **Corbado:** not an IdP.
- **Clerk, Stytch, Firebase, PropelAuth:** US-only, fail the residency test that is the only reason
  to move at all. Clerk additionally has five CVEs in thirteen months in auth-bypass classes.
- **Kinde, Cognito:** no magic link.
- **Supabase Auth standalone on Neon:** unsupported integration, and CVE-2026-31813 was an
  Apple-provider auth bypass. We use Apple sign-in.
- **Keycloak, Zitadel, Logto, Authentik, Casdoor, Kratos, SuperTokens:** self-hosting an identity
  service with no on-call. SuperTokens additionally puts MFA and account linking behind a paid
  enterprise licence and its Node SDK went four months without a commit while the core shipped 383.

**A finding that changes how to read "diversification".** Better Auth Inc. took over Auth.js
stewardship on 2025-09-22 and announced it is **joining Vercel on 2026-07-07**. The same three or
four people now merge both codebases and hold the npm publish rights for `next-auth`, `@auth/core`
and `@auth/pg-adapter`. **Choosing Auth.js instead of Better Auth is not supply-chain
diversification; it is the same supply chain.** The Vercel post is silent on licence, trademark and
governance, which is the open question for anyone planning multi-year.

**Why Hanko is third and not second.** It has the best isolation property of anything surveyed: its
own process **and its own database**, so it never holds credentials to the Postgres containing the
credential vault. But it has **no published third-party audit**, four to five active contributors, an
unverified funding position, and $429/mo at 50k MAU on Cloud. Descope outranks it purely on assurance
(SOC 2 Type 2, ISO 27001, FedRAMP High, zero CVEs) and on Frankfurt being an explicit product rather
than an inference from the vendor's country of incorporation.

### What would have to be true for each of these to be wrong

**For "stay on WorkOS" to be wrong**, any one of:

1. **US processing of EU users' identity data becomes unacceptable** to the operator, a supervisory
   authority, or the published privacy policy. Note this is now a **settled fact, not an open
   question**: WorkOS's DPA names the United States as the sole storage and access country and there
   is no EU region to switch on. If the "EU data residency posture" in the draft privacy policy is
   meant literally, WorkOS cannot satisfy it at any price, and the answer is **Descope in
   Frankfurt**. SCCs remain a lawful transfer mechanism, so this is a posture decision rather than a
   legal failure, but it is the operator's call and it should be made deliberately rather than by
   default.
2. **WorkOS declines to execute the DPA for a non-paying customer.** That would leave gaps 4 and 7
   permanently open with a US processor holding EU users' identities. This is **the single most
   important thing to go and check**, and it is a short task: try to execute it.
3. WorkOS changes the free tier or sunsets consumer AuthKit. Mitigated by M23 and by the no-password
   decision, and made less likely by the March 2026 $100M Series C at a $2B valuation. This is a
   migration project, not an emergency.

**For "move to Descope" to be right**, all of: residency is binding; **and** either non-profit
pricing or the Hello World startup plan brings it to roughly $0, or the project accepts $799/mo,
which for a donation-funded app it almost certainly cannot. Get the pricing answer in writing before
doing any engineering. Their own FAQ invites the request.

**For "adopt Better Auth" to be right**, all of:

1. The operator accepts a **standing obligation to track the newest release** on the auth path
   indefinitely, because Better Auth supports only the latest version, and accepts doing that with no
   on-call.
2. `session.cookieCache` stays off, `magicLink.storeToken` is set to `"hashed"`, sessions are pointed
   at the `noeviction` instance, and each of those is an **asserted test**, not a comment.
3. Someone accepts that session tokens sit in plaintext in the same Postgres as the credential
   ciphertext, and that a single read primitive therefore yields both. This is the item I do not
   think can be accepted given the stated criterion.
4. Gate L in `verify-migrations.mjs` is extended to cover the new tables, since its cascade check is a
   hardcoded three-table list and would otherwise pass green over a broken cascade.

**For "self-host a service" to be right**, the operator has to genuinely want to run identity
infrastructure. Keycloak carries 3,060 open issues and a JVM; Zitadel is AGPL-3.0 with 1,097 open
issues; all of them are a patch obligation on the path to other people's credentials. The threat
model's own framing applies: this trades a vendor risk we have already mitigated for an operational
risk we have no capacity to absorb.

**For "adopt Neon Auth" to be right**, it would have to reach GA, support separate frontend and
backend deployments, and track Better Auth releases closely rather than pinning six months back. All
three are plausible within a year. **It is worth re-reviewing then**, because the architecture is
genuinely attractive: Better Auth's capability as an isolated service with users in our own Postgres.
It is simply not ready in July 2026.

**For "adopt Better Auth" to be right**, see the four conditions listed under Appendix A. The third
of them, accepting plaintext session tokens in the same database as the credential ciphertext, is the
one I do not think can be accepted given the stated criterion.

### What to do instead, in priority order

1. **Decide the residency question explicitly.** It is the only real finding against WorkOS, and it
   is now a settled fact rather than an unknown. Either accept US processing under SCCs and say so
   plainly in the privacy policy, or decide that Frankfurt is binding and open the Descope non-profit
   pricing conversation. Do not leave it as an `[OPEN]` marker.
2. **Execute the WorkOS DPA.** Closes gap 4 and answers gap 7. Cheapest risk reduction available, and
   worth doing even if a move is later chosen, because it covers the interim.
3. **Implement M23**, the scheduled export of the WorkOS user list into our own backups. This is what
   makes staying reversible, and it is currently spec, not code. It is also the prerequisite for any
   future migration, so it is not wasted work under either outcome.
4. **Leave the auth code alone.** The `requireAuth` credential-type asymmetry, the dual revocation,
   the `noeviction` deny-list and the BOLA suite are the strongest part of this codebase. Rewriting
   them against a new session model would be the largest single injection of risk considered in this
   document.
5. **Do not put users' third-party tokens in any IdP's vault**, whatever is chosen. Descope's
   Outbound Apps and Kinde's Connected Apps both offer this. The vault stays in our Postgres under
   our own KEK.
6. Noted in passing, independent of the auth decision: `legal/privacy-policy.md` still lists
   **Hetzner (Finland)** as the database location while the database has moved to **Neon
   (Frankfurt)**, and `infra/staging` still stands up its own Postgres. That is a live accuracy
   problem in a document intended for publication.

---

## The axis that matters most: process isolation

Most auth comparison tables rank on features, price and developer experience. For Pull.fm the first
column should be **what can this thing read if it is compromised**, because the same process that
would run the auth code also holds the KEK in memory and a Postgres pool with full rights to
`user_oauth_connections`.

There are three genuinely different blast radii, and they are not points on a spectrum:

**1. Hosted service (WorkOS, Clerk, Stytch, Auth0, ...).** Runs on someone else's machines. Reaches
us only through HTTPS responses we parse and a signed webhook we verify. A total compromise of the
vendor gives an attacker the ability to mint identities and to lie to us about who is calling. That
is severe: they could impersonate any user and, through a normal authenticated session, read that
user's decrypted credentials. But it is **one user at a time, through the front door, subject to our
rate limits, audit log and BOLA checks**. It does not yield the KEK, it does not yield the
ciphertext table, and it does not yield every user at once.

**2. Self-hosted service (Kratos, Zitadel, Keycloak, Logto, ...).** Same isolation property, no
vendor. Runs as its own process, usually with its own database or at least its own schema and its
own credentials. A compromise of the auth service is still bounded by the network and by whatever
database grants it holds. The cost is that patching it is now our job, at 2am, with no on-call.

**3. In-process library (Better Auth, Auth.js, Lucia, ...).** Runs inside the BFF. Shares the
process, the environment, the heap and the connection pool. A compromise of the library, or of any
of its transitive dependencies, or a bug in its request parsing, executes in a context that can read
`process.env`, the KEK, and every row of ciphertext at once. This is precisely THREAT-MODEL AT-4:

> **VERBATIM** (`security/THREAT-MODEL.md`, AT-4)
> "GOAL: execute attacker code in a context that can read the KEK"

The threat model already states which of these matters more:

> **VERBATIM** (`security/THREAT-MODEL.md`)
> "defend the envelope." Investment should follow that order, which is why AT-4 gets its own tree
> despite being "just dependencies".

**The honest counter-argument**, which deserves stating before the table rather than after: the BFF
_already_ runs `fastify`, `pg`, `ioredis`, `jose`, `zod`, `pino` and a dozen `@fastify/*` plugins
in that same process. A malicious release of any of them has identical reach. Adding one more
well-maintained library does not create a new category of risk, it enlarges an existing one. So the
in-process objection is a matter of **degree and of what the dependency does**, not an absolute bar.

Two things make it more than a rounding error here. First, auth libraries are a high-value
supply-chain target in a way that a logging library is not, because compromising one yields
credentials at scale across many victims. Second, and more concretely, the marginal benefit is
small: we would be adding a dependency in order to replace a vendor that currently costs nothing
and holds nothing of ours.

**The strongest evidence on this axis is not ours.** Lucia was the best-regarded in-process
TypeScript session library of its generation. Its maintainer deprecated it and explained why:

> **VERBATIM** (github.com/lucia-auth/lucia discussion #1707)
> "It has become abundantly clear to me that Lucia, in the current state, is not working. I now implement sessions from scratch and don't use the library for my personal projects."

and, asked directly why a library was not the answer:

> **VERBATIM** (github.com/lucia-auth/lucia discussion #1714)
> "But why wouldn't a library be the answer? It seems like a such an obvious answer. One word - database."

That is not an outside opinion about the in-process model. It is somebody who built one concluding
that coupling auth to the application's own database was the thing that made it the wrong shape. It
is the single most relevant data point in this review, because it is the same coupling being
proposed here, against a database that also holds every user's encrypted credentials.

---

## Category 1: hosted, network-isolated

### WorkOS, the incumbent, given a fair hearing

The brief is sceptical of WorkOS on three counts: that it is a B2B company whose free consumer tier
is an acquisition funnel, that it does not export password hashes, and that it costs $99/mo to avoid
a login page on a domain users do not recognise. Two of those survive scrutiny and one dissolves.

**Pricing, verified from the live pricing page on 2026-07-28.**

> **VERBATIM** (https://workos.com/pricing)
> "First 1M MAUs" included at no cost; "Each additional 1M MAUs" at "$2,500/mo"; "Custom domain" at "$99/mo".

So at 10,000 MAU and at 50,000 MAU the cost is **$0**, and it stays $0 until Pull.fm has a million
monthly actives, which for a non-commercial hobby project is effectively never. The $99/mo is real
but it buys **cosmetics**: a login page on our own domain. It is not a security control, it is not a
data-residency control, and declining to pay it costs us nothing except an unfamiliar hostname during
sign-in. It should not be weighed as a recurring cost of staying, because staying does not require
paying it.

**The password-hash objection is already resolved and should stop being cited.** `docs/PLAN.md`
section 4 closed it:

> **VERBATIM** (`docs/PLAN.md` section 4)
> "**Resolution: never issue a password.** Google + Apple OAuth and magic-link only."

and:

> **VERBATIM** (`docs/PLAN.md` section 4)
> "**No hashes exist**, so there is nothing to be held hostage. Lock-in structurally evaporates: users re-link by email address at any future provider."

That reasoning is sound and it is the reason lock-in is weak here. The only thing WorkOS holds that
we would need on exit is the mapping from `workos_user_id` to email, and `PLAN.md` already mandates a
scheduled export of the user list into our own backups (M23, against T25). **Migration away from
WorkOS is a supported operation on any day we choose**, which is precisely what makes staying a
low-regret decision rather than a lock-in.

**Security assurance is the strongest of anything surveyed. [verified]** From
https://workos.com/security: SOC 2 Type 2, GDPR and CCPA compliance, HIPAA BAAs on enterprise plans,
"Annual 3rd-party security penetration tests" and "External code audits" [VERBATIM], a trust portal
at trust.workos.com, and a responsible-disclosure process. No self-hosted or in-process option in
this review can match "somebody else is paid to pentest this annually".

**The honest weaknesses.**

- **There is no EU region. Not "undocumented": absent.** I initially recorded this as unverified
  because `workos.com/docs/data-residency` and `workos.com/docs/security` both return **HTTP 404**.
  The answer is in the DPA instead: **Exhibit B names the United States as the sole storage and
  access country**, with EU transfers handled by Standard Contractual Clauses in Exhibit C. WorkOS
  argues publicly that authentication is a control-plane function that can be processed globally.
  So our privacy policy's "United States" entry is correct and permanent, not a gap awaiting a region
  toggle. **This is the single strongest argument for moving, and it is a compliance argument, not a
  security one.**
- **The Article 28 gap is closable today, and should be closed regardless.** Our policy carries
  `[OPEN: the WorkOS DPA is not yet on file. Gate L requires it.]` and gap 7 says
  > **VERBATIM** (`legal/privacy-policy.md`, gap 7)
  > "The US-access transfer mechanism is undecided."
  > WorkOS publishes a DPA covering EEA, Swiss and UK transfers via SCCs ("the parties agree that the
  > transfer shall be governed by the Standard Contractual Clauses attached hereto as **Exhibit C**",
  > VERBATIM), with nothing on the page conditioning it on a paid plan. **SCCs are a lawful transfer
  > mechanism, so this is paperwork, not a migration.** Executing it closes gap 4 and answers gap 7 in
  > the same stroke.
- **WorkOS is explicitly a B2B company.** Homepage VERBATIM: "Your app, Enterprise Ready." /
  "Start selling to enterprise customers with just a few lines of code." There is no consumer-facing
  positioning at all. The 1M-MAU free tier is plainly a funnel into per-connection enterprise SSO
  revenue. That is a business-continuity risk, not a security one, and it is already mitigated by
  M23 and by the no-password decision. It has also moved in customers' favour, not against: the tier
  has not been cut, and WorkOS raised a **$100M Series C at a $2B valuation in March 2026**, so it is
  not a vendor at risk of disappearing.
- **Eight CVEs, and one was in the hosted service itself.** Most are in framework SDKs we do not use
  (`authkit-nextjs`, `authkit-remix`, `authkit-react-router`), and the recurring class is
  **session tokens leaking through caches**: CVE-2025-64762 (High 8.0, Nov 2025) was missing
  anti-caching headers risking "session tokens being included in cached responses and subsequently
  served to multiple users" behind a CDN. But **CVE-2025-23017** (Moderate 6.0, Feb 2025) was a flaw
  in **WorkOS Hosted AuthKit**, the service: an MFA bypass by enrolling a new factor. Patched by the
  vendor without action from us, which is precisely the benefit of the hosted model, but it is a
  reminder that "hosted" means "someone else's bugs", not "no bugs".

### The other eight hosted vendors

|                   | 10k MAU | 50k MAU           | Free ceiling      | Consumer?     | EU region                           | Magic link               | Custom domain | CVEs                                |
| ----------------- | ------- | ----------------- | ----------------- | ------------- | ----------------------------------- | ------------------------ | ------------- | ----------------------------------- |
| **WorkOS**        | $0      | **$0**            | 1M MAU            | B2B           | **No (US only, per DPA)**           | Yes                      | $99/mo        | 8, one in the service               |
| **Clerk**         | $0      | **$0**            | 50k MRU           | Hedged        | **No**                              | Yes                      | Free          | **6, two Critical, 5 in 13 months** |
| **Stytch**        | $0      | not published     | 10k MAU           | B2B / agents  | **No (US only)**                    | Yes                      | $99           | **0** (now Twilio)                  |
| **Kinde**         | $0      | $716/mo           | 10,500 MAU        | Dev/SaaS      | **Yes (Dublin), free**              | **No, OTP only**         | Free          | **0**                               |
| **Descope**       | $249/mo | $2,049/mo         | 7,500 MAU         | **Yes, both** | **Yes (Frankfurt), Growth $799**    | **Yes + Enchanted Link** | $249/mo       | **0**                               |
| **Auth0**         | $0      | **not published** | **25k MAU**       | Yes           | Yes (EU, sub-region not selectable) | Yes                      | **Free**      | Many, session/CDN class             |
| **PropelAuth**    | $0      | ~$2,150/mo        | 10k MAU           | **B2B only**  | **Not found**                       | Yes                      | Free          | 0                                   |
| **Firebase Auth** | $0      | **$0**            | 50k MAU           | Yes           | **No, US only, documented**         | Yes                      | Free          | CVE-2024-11023                      |
| **AWS Cognito**   | $0      | $600/mo           | 10k MAU (was 50k) | Both          | **Yes (Frankfurt)**                 | **No**                   | Free          | CVE-2024-28056 (Amplify)            |

**The structural finding, which is the most useful output of this whole survey: no vendor offers all
four of {magic link, EU residency, login page on our own domain, roughly $0}.**

- EU residency eliminates **WorkOS, Clerk, Stytch, Firebase and PropelAuth** outright. Three of them
  state US-only processing in their own documentation. Firebase is the bluntest:
  > **VERBATIM** (https://firebase.google.com/support/privacy)
  > "The Firebase Authentication service is run only from US data centers. As a result, Firebase Authentication processes data exclusively in the United States."
- Of the EU-capable options, **Kinde and Cognito do not do magic links.** Kinde declines by policy:
  > **VERBATIM** (https://docs.kinde.com/authenticate/authentication-methods/passwordless-authentication/)
  > "Kinde does not support magic links as a password alternative, instead, we prefer to use one-time passcodes (OTPs) as they are more secure, and require manual entry as opposed to a single click."
  > A full-text search of the Cognito Developer Guide for "magic link" returns zero hits.
- That leaves **Descope** and **Auth0** as the only hosted vendors that can do magic link in the EU.

**Descope** is the best functional fit. Its assurance posture needs a caveat that two independent
research passes disagreed on: **FedRAMP High Authorized is confirmed** from Descope's own docs, and
**zero CVEs** is confirmed across 14 npm packages plus the Python and Go SDKs. SOC 2 Type 2, ISO
27001, CSA STAR and PCI DSS are **claimed but unverified**: `trust.descope.com` returns 403 to
automated fetch and `descope.com/security`, `/trust`, `/legal/dpa` and `/subprocessors` all return 404. FedRAMP High implies a serious control set, so this is probably a fetchability problem rather
than an absence, but it should be confirmed by a human before it is relied on. It offers Frankfurt,
and its **Enchanted Link** keeps the
session in the originating tab so opening the link from another device or mailbox does not hand over
a session, which is a genuinely better answer to the "magic link is a bearer credential in an inbox"
problem than anything else here. The costs are real: Frankfurt is gated to Growth at $799/mo, custom
domain to Pro at $249/mo, and the Free tier tops out at 7,500 MAU with no overage. Two mitigations
are invited by Descope's own FAQ and are worth chasing: **non-profit/charity pricing**, and a
**Hello World startup plan giving Pro free for a year**. There is also a discretionary Free-tier EU
exception ("If you are interested in EU data residency and on a Free Forever plan, reach out to
Descope support", VERBATIM), which is one sentence with no entitlement behind it and should not be
planned around.

**Auth0** is the cheap EU-capable option: free to **25,000 MAU**, free custom domain, magic link and
unlimited social on the free tier, EU locality. Against it: the sub-region is not selectable so
Frankfurt cannot be pinned; **pricing at 50,000 MAU is not published** (self-serve tiers stop at
30,000, then "Contact us", and the two research passes disagreed, one quoting $3,500/mo on Essentials
and the other finding no public figure, so treat 50k as unpriced); password-hash export is barred on
Free, which is irrelevant to us since we hold no passwords but tells you the free tier cannot fully
exit; and it is Okta. The breach record the brief asked about is real and it is a pattern:
Lapsus$/Sitel (Jan 2022, disclosed two months late), the support case management breach (Sept-Oct
2023, which reached 1Password, BeyondTrust and Cloudflare and eventually exposed the names and emails
of **all** Okta support users), and the AD/LDAP bcrypt cache bug (Oct 2024). One nuance matters and
cuts in Auth0's favour:

> **VERBATIM** (Okta, Nov 2023)
> "The Auth0/CIC support case management system was also not impacted by this incident."
> The 2024 bcrypt bug was Workforce/AD-LDAP only and does not touch social or magic link. The honest
> summary is that Okta's **support plane** has been breached three times while the Auth0 identity plane
> has not, and that Okta is the most phished identity brand on the internet.

**Stytch is no longer independent, and that changes its risk profile.** Twilio announced the
acquisition on 2025-10-30 and completed it on 2025-11-14. Stytch's own wording is

> **VERBATIM** (https://changelog.stytch.com/announcements/2025-11-14-a-new-chapter-begins-stytch-joins-twilio)
> "No immediate changes to your contracts, pricing, SDKs, API keys, or integrations"

Note "immediate". Stytch's security policy URL now 307-redirects to Twilio legal pages, so the
integration is already load-bearing. Two consequences. In its favour, Stytch inherits **the only
verified public bug bounty in this survey**: Twilio runs one through HackerOne, alongside SOC 2 Type
2 and ISO 27001/27017/27018. Against it, a free 10,000-MAU consumer tier sitting inside Twilio is a
plausible future casualty, and Stytch's per-MAU rate above 10,000 is **not published**, so the cost
of being wrong cannot be modelled in advance. Stytch fails the residency test anyway.

**Clerk deserves one specific warning.** Its billing unit is the most generous here (50,000 free
monthly retained users, and signups who never return are free), and custom domain is free on all
tiers. But it has **five CVEs in thirteen months, two of them Critical**, and the classes are
middleware route-protection bypass, authorisation bypass on role and permission checks, SSRF leaking
`Clerk-Secret-Key`, OAuth bypass via OTP manipulation, and IDOR in `auth()`. Those are auth-bypass
classes, not information leaks. For a solo operator with no on-call, that is a patching treadmill in
a hosted vendor's SDKs, which is the worst of both models. It is also US-only, so it fails the
residency test anyway. Clerk is unusually straight about its own limits, which is worth crediting
even while declining it:

> **VERBATIM** (https://clerk.com/articles/clerk-security-how-we-protect-your-users)
> "Clerk is not ISO 27001 certified. Its infrastructure providers, Google Cloud and Cloudflare, are"

> **VERBATIM** (same page)
> "Clerk does not run a paid bug-bounty program."

**Exit paths differ far more than the marketing does.** Kinde offers self-service export of
`users.ndjson` including hashed passwords and hash parameters, AES-256 encrypted, owner-approved, at
no cost and with no support ticket. Clerk offers a dashboard CSV including `password_digest` and
`password_hasher`. Stytch and Descope release hashes only via a support ticket. Auth0 requires a
ticket **and blocks the operation entirely on the Free plan**. Cognito documents hash _import_ in
detail and has **no documented hash export** at all. WorkOS states plainly that it does not export
hashes while shipping first-party importers that ingest them from competitors.

For Pull.fm this ordering is **almost entirely moot**, because `docs/PLAN.md` section 4 already
resolved never to issue a password, so there are no hashes to export from anywhere. It is recorded
because it is the single best predictor of how a vendor behaves when you try to leave, and because it
would matter immediately if the no-password decision were ever revisited.

**One cross-cutting recommendation regardless of vendor.** Descope ("Outbound Apps") and Kinde
("Connected Apps") both offer to store users' third-party OAuth tokens in the IdP's own vault. **Do
not use those.** Neither documents its encryption model to the standard of
`packages/crypto/src/envelope.ts`, and taking them up would concentrate two independent credential
stores behind a single tenant compromise, which is the exact opposite of what this review is for.
The token vault stays in our Postgres under our own KEK.

---

## Category 2: database-integrated

### Neon Auth is now "Managed Better Auth", and it is pinned to a vulnerable version

This was the most surprising finding of the review, and it collapses what looked like two separate
options into one.

> **VERBATIM** (https://neon.com/docs/auth/overview)
> "Managed Better Auth is powered by Better Auth"

> **VERBATIM** (https://neon.com/docs/auth/overview)
> "Managed Better Auth runs as a managed REST API service."

> **VERBATIM** (https://neon.com/docs/auth/overview)
> "All authentication data is stored in the `neon_auth` schema."

On paper this is close to ideal for us. It is Better Auth's feature set delivered as a **network-
isolated service** rather than an in-process library, with the user rows in **our own Neon Postgres**,
from a vendor we already depend on, in the Frankfurt region, at no extra cost (Neon's own plans page
covers up to 60,000 MAU on Free and 1M MAU on paid, so 10k and 50k MAU are both $0 incremental).
It appears to dominate both ends of the isolation axis.

**Four verified facts sink it.**

**1. The pinned version is inside the affected range of a live High-severity advisory. [verified]**

> **VERBATIM** (https://neon.com/docs/auth/overview)
> "Managed Better Auth currently supports Better Auth version 1.4.18."

Better Auth 1.4.18 was published **2026-01-29**, which is **37 stable releases** behind current
[verified via the npm registry]. GHSA-qq9h-g4jm-xgf3 ("Account takeover via pre-account hijacking on
magic-link and email-OTP sign-in", CVSS 8.3) declares affected versions `>= 1.1.3, < 1.6.22`, fixed in
1.6.22 on 2026-06-26. **1.4.18 falls inside that range.**

Two honest caveats. That advisory's attack requires password sign-up to be enabled to plant the
password, and a managed service may well not expose `emailAndPassword`. And Neon may have backported
the fix without moving the version string. Neither is verifiable from outside. But Better Auth's own
policy leaves no room to assume a backport:

> **VERBATIM** (https://github.com/better-auth/better-auth/security/policy)
> "We only support the latest version of Better Auth. Older versions are not supported."

A managed service running six-month-old code on an upstream that explicitly does not support old
versions is a patch-lag risk we would be accepting on someone else's schedule, with no visibility.
That is worse than the in-process option in one specific way: at least in-process we control when we
patch.

**2. Our architecture is on the documented unsupported list. [verified]**

> **VERBATIM** (https://neon.com/docs/auth/roadmap)
> "Architectures where frontend and backend are separate deployments (for example, Create-React-App with a separate Node/Express backend) are not yet supported."

Pull.fm is a separate web frontend and a Fastify BFF. That is exactly the described shape. This is a
present blocker, not a preference.

**3. It is Beta, with MFA not shipped.** GA is "targeting general availability this quarter"
[VERBATIM, same roadmap page]. Beta authentication on the service holding other people's credentials
is not a risk reduction.

**4. The engine has already been swapped once, and the previous vendor rebranded mid-flight.**
The prior Neon Auth was built on Stack Auth and is now closed to new projects:

> **VERBATIM** (https://neon.com/docs/auth/legacy/overview)
> "**This is the documentation for the previous Neon Auth implementation built with Stack Auth.** It is no longer available for new projects but remains supported for existing users."

Stack Auth itself became **Hexclave**: `stack-auth.com` now returns a **308 Permanent Redirect to
`www.hexclave.com`** [verified directly], which describes itself as "the open-source platform for
everything user" [VERBATIM, hexclave.com] and has broadened from auth into payments, analytics, RBAC
and data vaults. The rebrand commits landed 2026-05-23 through 2026-07-27, i.e. it was **still being
completed the day before this review**. The company is a 7-person YC S24 startup with one dominant
committer and no disclosed funding [unverified funding].

The brief asked to treat that churn as a signal. It is a strong one: an identity layer we would have
adopted 12 months ago would since have had its vendor renamed, its npm scope changed, its
environment variables renamed, and then been replaced wholesale by a different engine. Neon's own
willingness to swap the engine under a shipping product is the same signal from the other side.

### Supabase Auth (GoTrue): plausible, but an unsupported integration we would own

MIT, corporate-backed, `v2.194.0` published 2026-07-27, 2,511 stars, a **separate Go process** that
speaks HTTP and never enters our Fastify process. Frankfurt `eu-central-1` is available. Supabase
publishes SOC 2 Type 2 and ISO 27001 claims and states it runs regular third-party penetration tests
(reports gated, not publicly downloadable).

Two problems. First, using it standalone against Neon is **not an officially documented
configuration**: the docs cover self-hosting the whole Docker stack, and the auth server expects
Supabase-specific Postgres roles that we would bootstrap and maintain by hand. Second, it has the
longest advisory history in this category, including **CVE-2026-31813 / GHSA-v36f-qvww-8w8m**
(2026-03-11, auth bypass by spoofing: crafted OIDC ID tokens could mint sessions for arbitrary users
when the Apple or Azure providers were enabled). We use Apple sign-in. Fixed in 2.185.0.

Using Supabase's _hosted_ auth instead removes the integration burden but puts users back in a
vendor's database, which forfeits the only real advantage this category had over WorkOS.

---

## Category 3: self-hosted services (separate process, no vendor)

This is the category the brief asked me to take seriously, on the grounds that it may dominate both
ends: no vendor, but still process-isolated. It does have that property, and it is the right shape in
the abstract. It loses on a single constraint that no amount of architecture fixes.

**Project health, verified via the GitHub API on 2026-07-29.** Every one of these is alive. None is
a Lucia-style trap.

| Project          | Licence                        | Latest release              | Open issues | Stars  |
| ---------------- | ------------------------------ | --------------------------- | ----------- | ------ |
| Keycloak         | Apache-2.0                     | 26.7.0 (2026-07-09)         | **3,060**   | 35,876 |
| Authentik        | NOASSERTION (split)            | 2026.5.6 (2026-07-22)       | 1,194       | 22,528 |
| SuperTokens core | NOASSERTION (split)            | v12.0.8 (2026-07-28)        | 152         | 15,239 |
| Zitadel          | **AGPL-3.0**                   | v4.16.1 (2026-07-17)        | **1,097**   | 14,568 |
| Logto            | MPL-2.0                        | v1.41.0 (2026-06-30)        | 168         | 14,251 |
| Casdoor          | Apache-2.0                     | v3.125.0 (2026-07-24)       | 118         | 14,075 |
| Ory Kratos       | Apache-2.0                     | v26.2.0 (**2026-03-20**)    | 218         | 13,794 |
| Hanko            | NOASSERTION (AGPL-3.0 backend) | backend/v3.0.4 (2026-07-27) | 50          | 8,990  |

Two observations from that table alone. Kratos's last tagged release is **four months old** while its
default branch is current, which is a release-cadence question worth answering before adoption. And
the licences are not uniform: **Zitadel is AGPL-3.0** and Hanko's backend is AGPL-3.0, which is fine
if we neither modify nor redistribute, but is a condition to be aware of rather than a detail.

**NOT RESEARCHED in this pass:** per-project CVE history (Keycloak, Authentik and Casdoor were
expected to carry auth-bypass CVEs), third-party audit status, and the precise Apache-2.0-versus-Ory-
Network feature split for Kratos including whether passwordless magic link is in the OSS build. The
delegated survey did not return before the search budget was exhausted. These are **not assumed**,
and the absence of a CVE list here must not be read as an absence of CVEs. Given the Lucia lesson,
the opposite is more likely: a mature identity server with no disclosed CVEs would be the surprising
result.

**Why the whole category loses anyway.** The constraint is in the brief: **solo operator, no
on-call.** Self-hosting an identity service means owning the patch cycle for the component that
guards other people's credentials. Keycloak's 3,060 open issues and Zitadel's 1,097 are not
indictments, they are the normal surface area of software this size, and that is the point: it is a
lot of software to keep current, at 2am, alone, for a donation-funded hobby project. Trading a vendor
risk that is already mitigated (M23 export, no password hashes, $0 cost) for an unbounded operational
obligation is not a reduction in exposure. It is a transfer of exposure from a party that is paid to
carry it to one who has no capacity to.

The one exception worth naming is **Hanko**, and only because of a property none of the others share:
self-hosted, it runs with **its own separate Postgres**, so a compromise of the auth service does not
hand over the database containing the credential vault. Every other option in this table would either
share our Postgres or need credentials to it. That is a real architectural advantage and it is why
Hanko, not Kratos, is second on the shortlist.

---

## Category 4: passkey-first

Assessed briefly, because none of them changes the shape of the decision.

**Passage: dead. Eliminated. [verified]** The GitHub organisation is now titled
"[deprecated] Passage by 1Password" and states VERBATIM "Passage will be retired on January 16,
2026." and "Passage has been deprecated as of January 16, 2026." `passage.id` and
`docs.passage.id` are **unreachable (connection refused)**; the surviving sources are the GitHub org
page and 1Password's community forum. Shutdown was six months ago.

**Corbado: does not solve the problem. Eliminated.** It is explicitly a layer on top of an existing
IdP, VERBATIM "the missing client-side intelligence layer across commercial IDPs" and "Your IDP stays
either way." We would still need an IdP underneath. Pricing is not published for either product
(custom only), so no 10k/50k figure can be stated. Good compliance posture (ISO 27001, SOC 2 Type II
badges displayed), German company (Corbado GmbH, Munich).

**Hanko: the best process isolation of anything surveyed, and worth keeping on the list.** German
company (HANKO GmbH, Kiel, verified from the legal notice), `backend/v3.0.4` published 2026-07-27,
8,990 stars, **no published security advisories**. Backend is AGPL-3.0, frontend components MIT.
Supports passkeys, **email passcodes and social sign-in without passwords**, which matches our
constraint. Self-hosted it runs as a separate Go process **with its own separate Postgres**, so
unlike every other self-hostable option it never receives credentials to the database holding our
credential vault. Cloud pricing is $0 up to 10,000 MAU, then $29/mo + $0.01/MAU, so roughly **$429/mo
at 50k MAU** [verified from the pricing page], which is real money for a donation-funded project.
No published third-party audit was found [unverified]. Four to five active contributors.

---

## Category 5: in-process TypeScript libraries

Checked by querying the npm registry and the GitHub API directly on 2026-07-28, rather than
trusting project websites. That method was chosen deliberately, because a project site is the last
thing to be updated when a project dies.

| Package            | Latest             | Last publish | Status                          |
| ------------------ | ------------------ | ------------ | ------------------------------- |
| `better-auth`      | 1.6.25             | 2026-07-23   | Active                          |
| `supertokens-node` | 24.0.3             | 2026-07-24   | Active                          |
| `@auth/core`       | **0.41.3**         | 2026-07-20   | Active, still 0.x after 4 years |
| `next-auth`        | 4.24.15 (`latest`) | 2026-07-20   | v5 still beta                   |
| `lucia`            | 3.2.2              | 2024-10-20   | **Deprecated**                  |
| `arctic`           | 3.7.0              | 2025-05-21   | Stale ~14 months                |
| `@oslojs/crypto`   | 1.0.1              | 2024-09-21   | Stale ~22 months                |

**Lucia: eliminated, and the reason is the most useful finding in this review. [verified]** Every
published version of `lucia` carries a deprecation notice in its npm metadata (verified via
`npm view lucia deprecated`), pointing at a migration page. There is no successor package; the
replacement is documentation you copy code out of. The maintainer's reasoning is quoted in the
process-isolation section above and is the reason it appears there rather than here.

There were **no CVEs** for `lucia`, `arctic` or `@oslojs/*` in the GitHub Advisory DB, OSV or NVD.
The risk was never a vulnerability. It was depending on a package with no upstream left to ship a
future fix. That distinction matters when scoring everything else in this document: a clean CVE
record on an abandoned project is worthless, and a long CVE record on an actively patched one is
often a sign of scrutiny rather than of weakness.

A related caution, learned the same way: `arcticjs.dev` and `oslojs.dev` still carry **no deprecation
banner** while their packages have not shipped in over a year, and the maintainer has quietly moved
both to "past projects". **Absence of a deprecation notice is not evidence of maintenance.**

**Auth.js / NextAuth: eliminated, and worse than expected. [verified]** `@auth/core` is still on
**0.41.3**, i.e. it has never declared a 1.0 in roughly four years. NextAuth v5 has **33 beta
releases** and no stable one: `npm view next-auth dist-tags` returns `latest: 4.24.15` and
`beta: 5.0.0-beta.32`, with no non-prerelease 5.x published at all. Four more findings settle it:

- **Its own security policy disclaims production readiness**, VERBATIM from https://authjs.dev/security:
  "`@auth/*` packages (other than the database adapters) are currently under development and - unless
  stated otherwise - they are not considered ready for production yet."
- **There is no Fastify integration.** `@auth/fastify` does not exist on npm; the integrations table
  lists it as "Open PR", and that PR has been open since **2024-01-09**.
- **`@auth/pg-adapter` stores session tokens in plaintext, with no override.** `init.ts` sets
  `generateSessionToken: () => crypto.randomUUID()` (about 122 bits, no hashing), the adapter writes
  it directly and reads it back with an exact-equality lookup, and the same value is the browser
  cookie. Note also that merely adding an adapter silently switches the strategy from JWT to database
  sessions. This is the same defect as Better Auth's, with a third of the entropy.
- **Two Criticals on 2026-07-23**, one of which is an advisory against the project's own
  documentation: GHSA-8fpg-xm3f-6cx3 (9.1) means the officially documented `!!auth` middleware check
  **fails open** for every request, and the doc pattern is still in the repo. GHSA-7rqj-j65f-68wh
  (9.1) is a Unicode homoglyph bypass that sends the magic link to an attacker's mailbox.

The maintainer handover post is candid about capacity, VERBATIM from discussion #13252:
"We also want to acknowledge the obvious: our pace slowed over the past year. Maintainers moved
roles, time was tight, and the surface area outgrew what we could responsibly support."

**SuperTokens: the SDK is a client, not the auth logic. [verified]** `supertokens-node` is actively
released (24.0.3, 2026-07-24), but the SDK is a thin HTTP client over a separate **Java SuperTokens
core** that owns the database connection. VERBATIM: "**SuperTokens Core**: A HTTP service that
contains the core business logic for authentication. It interfaces with the database and gets queried
by the backend SDK." There is no embedded mode. That places SuperTokens in the self-hosted-service
category, and it means adopting it adds a second stateful service. **MFA and account linking are
behind a paid enterprise licence** (`ee/` carve-out). Its Node SDK went **four months without a
commit** (2026-03-23 to 2026-07-13) while the core shipped 383. Fastify support is genuinely
first-class, which is more than Auth.js manages. Zero advisories anywhere, which given 328 stars on
the SDK is more plausibly low researcher attention than exceptional quality.

**Better Auth: the only serious in-process candidate, and still not recommended.** 29,372 stars, MIT,
created 2024-05-19, pushed the day of this review. **Bus factor is the best in this category**: over
the last 12 months no single contributor exceeds 22% (himself65 21.6%, bytaesu 15.8%, Bekacru 11.9%,
ping-maxwell 7.4%), and merge authority is genuinely spread across four people with the founder
merging only 3 of the last 100 PRs. It is properly funded: **$5M seed announced 2026-06-24** led by
Peak XV, and on **2026-07-07 it announced it is joining Vercel**. It publishes **SLSA provenance
attestations** on npm, which neither Auth.js nor SuperTokens does.

The counterweights are what disqualify it, and they are in Appendix A: 31 advisories with 4
Criticals, no third-party audit ever, no documented stability or deprecation policy despite being on
1.x, a **single npm publisher account** (`bekacru`) for a package with 6.18M weekly downloads, two
sole-maintainer micro-dependencies (`better-call`, `@better-fetch/fetch`) sitting on the request path,
and plaintext session tokens at rest.

---

## Appendix A: Better Auth, verified against source

This section exists because Better Auth was the specific proposal on the table, and because vendor
and project assumptions have been wrong repeatedly on this project. Every claim below was read out
of the published package, with the file and line identified so it can be re-checked.

Package under test: `better-auth@1.6.25`, published 2026-07-23, MIT licence, repository
`github.com/better-auth/better-auth`. Verified via `npm view better-auth` on 2026-07-28.

### A1. Session storage and the eviction question

**Redis-backed sessions are supported, and can point at a separate instance. [verified]**

Better Auth exposes a single `secondaryStorage` interface. When it is configured and
`session.storeSessionInDatabase` is left at its default, sessions live **only** in that store, not in
Postgres. From `dist/db/internal-adapter.mjs`, `createSession`:

```js
if (sessionTTL > 0)
  await secondaryStorage.set(
    data.token,
    JSON.stringify({
      session: sessionData,
      user,
    }),
    sessionTTL,
  );
```

The official adapter `@better-auth/redis-storage` takes an arbitrary `ioredis` client, so pointing
sessions at the `noeviction` quota instance (`REDIS_QUOTA_URL`, port 6380) rather than the
`allkeys-lru` cache instance is a one-line configuration choice. Rate limiting can be pointed
somewhere else independently via `rateLimit.customStorage`, so the two do not have to share an
instance. **The non-negotiable requirement in the brief is satisfiable. [verified]**

**But the eviction failure mode is the opposite polarity from ours, and that is good news. [verified]**

Our revocation list is a **deny-list**: `revoked:sid:<id>` present means "signed out". Evicting that
key silently un-revokes the session, which is why `apps/bff/src/plugins/auth.ts` puts it on the
`noeviction` instance and why THREAT-MODEL T11 exists.

Better Auth's Redis usage is an **allow-list**: the session record itself lives in Redis, keyed by
the session token. Eviction deletes the session, which logs the user out. Annoying, not dangerous.
`findSession` returns null on a miss rather than falling through:

```js
findSession: async (token) => {
  if (secondaryStorage) {
    const sessionStringified = await secondaryStorage.get(token);
    if (!sessionStringified && (!options.session?.storeSessionInDatabase || ctx.options.session?.preserveSessionInDatabase)) return null;
```

So on the specific T11 question, Better Auth is structurally safer than our own deny-list, because
losing state fails closed instead of open. That is worth stating plainly even though it does not
change the overall recommendation.

**The real T11-class trap in Better Auth is `session.cookieCache`, not Redis. [verified]**

`cookieCache` is **off by default** [verified: `setCookieCache` returns early unless
`options.session.cookieCache.enabled`], but it is the obvious performance knob and the docs
advertise it. When enabled, `getSession` reconstructs the session from a signed cookie and returns
it **without consulting Redis or Postgres at all** (`dist/api/routes/session.mjs`, the
`sessionDataPayload?.session && ...cookieCache?.enabled` branch). The documentation is candid:

> **VERBATIM** (https://www.better-auth.com/docs/concepts/session-management)
> "revoked sessions may remain active on other devices until the cookie cache expires (`maxAge`)"

Default `maxAge` is 300 seconds. That is a five-minute window in which a signed-out session is still
accepted, and no amount of `noeviction` fixes it because the store is never consulted. If Better
Auth were ever adopted, `cookieCache` must stay off, and that must be an asserted test rather than a
comment.

**Two further consequences of Redis-only sessions. [verified, then inferred]**

- The Redis **key is the raw session token** (`secondaryStorage.set(data.token, ...)`, prefixed
  `better-auth:` by the official adapter). Anyone who can run `KEYS better-auth:*` or read an RDB
  snapshot holds every live bearer credential. [verified]
- The Redis **value contains the full user record**, because `createSession` fetches the user row
  and stores `{ session, user }` together. Redis stops being a cache of derived data and becomes a
  store of identity PII, which changes its backup, retention and residency treatment. [verified]
- Redis becomes a hard dependency of authentication rather than an optimisation: it going away logs
  out every user at once. [inferred]

### A2. Token handling at rest

**Session tokens are stored in plaintext. This is the material downgrade. [verified]**

From `createSession` in `dist/db/internal-adapter.mjs`:

```js
token: generateId(32),
```

and `generateId` in `@better-auth/core/utils/id`:

```js
const generateId = (size) => {
  return createRandomStringGenerator("a-z", "A-Z", "0-9")(size || 32);
};
```

That value is written verbatim into `session.token` (Postgres) or used verbatim as the Redis key,
and lookup is a plain equality match on it. There is **no hashing option for session tokens**: the
`storeToken` / `storeIdentifier` hashing machinery in `dist/db/verification-token-storage.mjs`
applies to verification values (magic links, OTPs, password resets), not to sessions.

Entropy is fine: 32 characters over a 62-symbol alphabet is roughly 190 bits, drawn from
`crypto.getRandomValues` with modulo-bias rejection (`@better-auth/utils/random`, verified). The
problem is not guessability, it is that **a database read is a full account takeover**, for every
live session at once.

Contrast with what we already run. `apps/bff/src/services/tokens.ts` stores `sha256(token)` and
nothing else, `packages/db/migrations/0002_api_tokens.sql` enforces the digest shape with
`api_tokens_hash_shape_chk CHECK (token_hash ~ '^[0-9a-f]{64}$')` specifically as a guard against a
bug writing the plaintext, and verification uses `timingSafeEqual`. And WorkOS holds no session
material in our database at all, because we verify a JWT signature against their JWKS and store
nothing.

So on this axis the ordering is unambiguous: **WorkOS (nothing to steal) > our API tokens (digest
only) > Better Auth (plaintext bearer tokens)**. Given that the same Postgres holds the encrypted
credential vault, a read primitive that also hands over every live session is a strictly worse
position than today.

**Comparisons are not constant-time, but that is defensible. [verified]**

Session lookup is an indexed equality match, and magic-link lookup is an equality match on
`verification.identifier`. Better Auth does have a `constantTimeEqual` and uses it where it matters
most (`dist/plugins/email-otp/otp-token.mjs`, `dist/plugins/oidc-provider/index.mjs`,
`dist/plugins/mcp/index.mjs`), but not on the session path. With ~190 bits of entropy and a B-tree
probe, a remote timing oracle is not a practical attack. This is a smaller finding than the
plaintext-at-rest one and should not be conflated with it.

### A3. Refresh rotation and reuse detection

**Neither exists for Better Auth's own sessions. [verified]**

Better Auth does not issue refresh tokens for its sessions. It uses a **sliding expiry**: default
`expiresIn` 7 days, `updateAge` 1 day (`dist/context/create-context.mjs` lines 146-148), and
`updateSession` extends `expiresAt` while keeping the **same token value**. There is no token family,
no rotation counter, and no reuse detection. A grep of the whole distribution for reuse-detection
vocabulary returns only unrelated matches. [verified]

Practically: a stolen session token is valid until it expires or is explicitly revoked, and
presenting it twice from two places is indistinguishable from normal use. That is the same posture
as most cookie-session systems, and it is weaker than an OAuth refresh-rotation design. Our current
WorkOS setup does issue refresh tokens; whether WorkOS performs reuse detection on them was not
verified in this review and should not be assumed.

`refreshToken` in the Better Auth schema refers to **provider** OAuth tokens on the `account` table,
which is a different thing. Those are stored in plaintext unless `account.encryptOAuthTokens` is set
(`dist/oauth2/utils.mjs`) [verified]. We would never route our ListenBrainz or Last.fm credentials
through that path, since `packages/crypto/src/envelope.ts` already does per-row DEKs, length-prefixed
AAD binding and KEK rotation that this option does not.

### A4. Cookies and CSRF

**Defaults, read from `dist/cookies/index.mjs`. [verified]**

| Attribute   | Default                                                      | Note                                                       |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `httpOnly`  | `true`                                                       | unconditional                                              |
| `secure`    | `true` when `baseURL` is `https://` or `NODE_ENV=production` | overridable with `advanced.useSecureCookies`               |
| `sameSite`  | `"lax"`                                                      |                                                            |
| `path`      | `"/"`                                                        |                                                            |
| `domain`    | **unset (host-only)**                                        | only set when `advanced.crossSubDomainCookies.enabled`     |
| name prefix | `__Secure-` when secure                                      | `__Host-` prefix exists in the code but is not the default |
| signing     | HMAC-SHA256 over the value with `BETTER_AUTH_SECRET`         |                                                            |

Host-only by default is the correct choice and worth crediting.

**CSRF protection is on by default and is origin-based, not token-based. [verified]**

`originCheckMiddleware` is registered as a router-wide middleware on `/**`
(`dist/api/index.mjs`). It returns immediately for `GET`, `OPTIONS` and `HEAD`, then validates the
`Origin` (falling back to `Referer`) against `trustedOrigins`, but **only when the request carries a
Cookie header**:

```js
if (!(forceValidate || useCookies)) return;
if (!originHeader || originHeader === "null")
  throw APIError.from("FORBIDDEN", BASE_ERROR_CODES.MISSING_OR_NULL_ORIGIN);
```

There is additionally a Fetch-Metadata check (`Sec-Fetch-Site: cross-site` + `Sec-Fetch-Mode:
navigate` is blocked) for first-login flows that arrive without cookies. This is a modern,
reasonable design. There is no double-submit or synchroniser token, so it inherits the usual caveat
that a same-site subdomain XSS or an origin-header-stripping proxy defeats it.

**Adopting it would introduce cookies into an API that deliberately has none. [verified, then inferred]**

`apps/bff/src/routes/v1/me.ts` states the current position: the API is Bearer-only, "token, never a
cookie, so a cross-site form post carries no credential". There is no `@fastify/cookie` in
`apps/bff/package.json`. Moving to Better Auth's cookie flow adds a credential type that is
automatically attached by the browser, and therefore adds a CSRF surface that currently cannot
exist. The `bearer` plugin avoids that, but its own documentation is a warning label:

> **VERBATIM** (https://www.better-auth.com/docs/plugins/bearer)
> "Use this cautiously; it is intended only for APIs that don't support cookies or require Bearer tokens for authentication. Improper implementation could easily lead to security vulnerabilities."

and `requireSignature` defaults to `false`, with the documented client pattern being to keep the
token in `localStorage`, which is XSS-readable. [verified]

### A5. Magic links

Read from `dist/plugins/magic-link/index.mjs`. [verified]

| Property              | Finding                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expiry                | 300 seconds default (`opts.expiresIn \|\| 300`)                                                                                                                 |
| Single use            | **Yes, atomically.** `consumeVerificationValue` runs `consumeOne` inside `runWithTransaction` plus an in-process lock, deletes siblings, and rejects if expired |
| Stored hashed         | **No. `storeToken: "plain"` is the default**                                                                                                                    |
| Constant-time compare | No (equality lookup on `verification.identifier`)                                                                                                               |
| Token entropy         | `generateRandomString(32, "a-z", "A-Z")`, ~183 bits from `crypto.getRandomValues`                                                                               |
| Rate limit            | 5 requests per 60 seconds per IP+path, default                                                                                                                  |
| Multi-instance caveat | Documented: atomic consumption over secondary storage requires `getAndDelete`; the official Redis adapter implements it with `GETDEL`                           |

The single-use implementation is genuinely well built and better than a naive find-then-delete. The
default of storing the link token in plaintext is the problem: a magic-link token is a **bearer
credential that grants a session**, and for its 5-minute life it sits in the `verification` table in
the clear. `storeToken: "hashed"` is one line and must be set. That it is not the default, on a
credential of that power, is a defaults-philosophy signal.

### A6. Rate limiting

Built in, and it can be backed by our existing Redis. [verified, `dist/api/rate-limiter/index.mjs`]

- Enabled by default **only in production** (`enabled: options.rateLimit?.enabled ?? isProduction`).
- Defaults: 10-second window, 100 requests, keyed on client IP + path.
- Stricter built-in rules: `/sign-in`, `/sign-up`, `/change-password`, `/change-email` at 3 per 10s;
  `/request-password-reset`, `/send-verification-email`, `/forget-password`, the email-OTP paths at
  3 per 60s.
- Default storage is **in-process memory** unless `secondaryStorage` is configured, in which case it
  defaults to `"secondary-storage"`. `rateLimit.customStorage` accepts an arbitrary implementation,
  so it can be pointed at the existing quota Redis.
- **It fails closed, by accident but correctly.** A throw from the storage propagates out of
  `onRequest` into the router's `onError`, so a Redis outage produces an error response rather than
  an unlimited one. [verified: no try/catch around `onRequestRateLimit` at
  `dist/api/index.mjs:168`]
- **Atomicity depends on the adapter.** Without an atomic `consume`, it degrades to a non-atomic
  check-then-increment with a logged warning. The official Redis adapter supplies atomic `increment`
  via `INCR` + `EXPIRE` in a Lua script, so this is fine in practice. [verified]

The memory default is the trap: two BFF instances would each enforce their own budget. Our own
`enforceTokenRateLimit` already fails closed against the `noeviction` instance deliberately, so
nothing here is an upgrade, but nothing here is an obstacle either.

### A7. Schema management

**No automatic migration at runtime. [verified]**

`runMigrations` exists on the auth context (`dist/context/init.mjs`), but nothing in the request
path or startup path calls it; it is driven by the CLI. From the docs:

> **VERBATIM** (https://www.better-auth.com/docs/concepts/database)
> "getMigrations only works with the built-in Kysely adapter (SQLite/D1, PostgreSQL, MySQL, MSSQL). It does not work with Prisma or Drizzle ORM adapters"

(quote trimmed at the clause boundary; the sentence continues by directing Prisma and Drizzle users
to CLI migrations.)

The `generate` command emits SQL that can be committed as a normal migration. So its tables can go
through `packages/db/migrations/` and `verify-migrations.mjs` unchanged, including the two-cycle
up/down reversibility check and the account-deletion cascade assertion.

One caveat worth stating, and it is sharper than it first looks. Gate L in
`packages/db/scripts/verify-migrations.mjs` checks the account-deletion cascade by counting rows in
a **hardcoded list of three tables** (`wishlist_items`, `user_connections`, `idempotency_keys`,
lines 151-153). Better Auth's `session`, `account` and `verification` tables would therefore be
**silently outside the gate**: they could fail to cascade on `DELETE FROM users` and the suite would
still pass green. Adopting it means extending that assertion by hand, and remembering to, which is
exactly the kind of quiet coverage gap this project builds gates to prevent. [verified: the table
list is literal in the script]

### A8. Supply chain

**The dependency tree is small and genuinely high quality, which is the opposite of what I expected
and is worth recording. [verified]**

A clean production install of `better-auth@1.6.25` resolves to **22 packages, all at depth 1**
(measured 2026-07-28 with `npm install --omit=dev`):

`@better-auth/core`, `@better-auth/drizzle-adapter`, `@better-auth/kysely-adapter`,
`@better-auth/memory-adapter`, `@better-auth/mongo-adapter`, `@better-auth/prisma-adapter`,
`@better-auth/telemetry`, `@better-auth/utils`, `@better-fetch/fetch`, `@noble/ciphers`,
`@noble/hashes`, `@opentelemetry/semantic-conventions`, `@standard-schema/spec`, `better-call`,
`defu`, `jose`, `kysely`, `nanostores`, `rou3`, `set-cookie-parser`, `zod`.

Eight of those are first-party. The third-party ones are `@noble/*` (paulmillr, audited crypto),
`jose` (panva, which we already depend on directly), `zod` (already a direct dependency), `kysely`,
and small unjs utilities. There is no left-pad tail and no transitive depth to hide in. Against
AT-4 (supply chain to the KEK) this is a much better tree than a typical auth library, and the flat
depth means `pnpm audit` output is actually actionable.

**Telemetry is off by default. [verified]** `@better-auth/telemetry` is a dependency, but
`dist/index.mjs` resolves `telemetryEnabled` to `false` unless `telemetry.enabled` is set or
`BETTER_AUTH_TELEMETRY` is exported. This corrects a reasonable suspicion; the dependency being
present is not the same as it phoning home.

**Two qualifications on the "small, high quality tree" conclusion.**

First, **`better-call` and `@better-fetch/fetch` are the founder's own sole-maintainer micro-packages
and they sit on the request path.** `better-call` is what pulls in `rou3` and `set-cookie-parser`.
That is not hypothetical exposure: **GHSA-x732-6j76-qmhm** (High 8.6, Dec 2025) was a `rou3`
double-slash path-normalisation bug that bypassed `disabledPaths` **and the rate limiter**. A tree
can be small, modern and still route a security control through a transitive dependency.

Second, **npm publishing is a single-account chokepoint.** `better-auth@1.6.25` lists exactly one npm
maintainer, `bekacru`, as do `better-call` and `@better-fetch/fetch`. One compromised account
publishes to a package with **6.18M weekly downloads**. The mitigating control is real and worth
crediting: Better Auth **publishes SLSA v1 provenance attestations** and releases through CI, which
is materially better than Auth.js or SuperTokens, neither of which attests at all. But provenance
proves where a build came from, not that the account authorising it was not stolen.

**Governance is the open question. [verified]** Better Auth raised a **$5M seed on 2026-06-24** led
by Peak XV, and announced on **2026-07-07** that it is joining Vercel. The announcement says

> **VERBATIM** (https://www.better-auth.com/blog/better-auth-joins-vercel)
> "Vercel shares our commitment to keeping auth open source, framework and platform agnostic."

It never uses the word "acquisition", and it says nothing about the MIT licence, the trademark,
project governance, or who becomes a Vercel employee. It also confirms VERBATIM "We acquired Auth.js
/ NextAuth.js". For a solo operator choosing a dependency to sit on the authentication path for
several years, an unresolved governance change at the vendor is a risk in its own right, and it is
the reason the "we could always fork it, it's MIT" answer is weaker than it sounds: forking an auth
library means owning its security response.

**The decisive supply-chain fact is not the tree, it is the trust boundary.** WorkOS runs on
WorkOS's machines and talks to us over HTTPS; it cannot read `user_oauth_connections`, it cannot read
`process.env`, and it cannot reach the KEK. Better Auth runs **inside the BFF process**, which holds
the KEK in memory and a connection pool with full rights to the credential vault. Any compromise of
Better Auth or of its 22 dependencies is a compromise of the vault, not a compromise of the login
page. THREAT-MODEL AT-4 says the same thing about dependencies generally:

> **VERBATIM** (`security/THREAT-MODEL.md`)
> "GOAL: execute attacker code in a context that can read the KEK"

That is a category change in blast radius, and it is the reason the maintainer, audit and advisory
questions below carry more weight for this library than they would for a logging package.

### A9. Advisory history, and the disclosure policy

There is a documented private channel with a stated SLA:

> **VERBATIM** (https://www.better-auth.com/docs/reference/security)
> "If you discover a security vulnerability in Better Auth, please report it to security@better-auth.com."

> **VERBATIM** (https://github.com/better-auth/better-auth/security/policy)
> "We will respond to your report within 72 hours."

> **VERBATIM** (https://github.com/better-auth/better-auth/security/policy)
> "Once a patch is released, we will disclose the issue publicly. If 90 days has elapsed and we still don't have a fix, we will disclose the issue publicly."

That is a good policy, run properly. But two things in it matter more than the policy itself.

**Thirty-one advisories since December 2024, four of them Critical. [verified]** The repo's
advisories web page shows only the ten most recent; the full set comes from
`gh api repos/better-auth/better-auth/security-advisories` (30) unioned with the global GHSA
database (1 more). The most recent ten, all in the last two months:

| GHSA                | Severity         | Published  | Subject                                                                                |
| ------------------- | ---------------- | ---------- | -------------------------------------------------------------------------------------- |
| GHSA-rjg6-39jm-rgg4 | **Critical 9.9** | 2026-06-26 | `@better-auth/scim`: account takeover via SCIM provider-id collision                   |
| GHSA-qq9h-g4jm-xgf3 | High 8.3         | 2026-06-26 | **Account takeover via pre-account hijacking on magic-link and email-OTP sign-in**     |
| GHSA-prpr-5gj3-qqhg | High 8.1         | 2026-06-26 | `@better-auth/sso`: account takeover via four SSO flaws                                |
| GHSA-h3rm-78g3-j7cp | High 7.1         | 2026-06-26 | `@better-auth/stripe`: cross-organization billing tampering                            |
| GHSA-j8v8-g9cx-5qf4 | High 8.3         | 2026-05-31 | `@better-auth/scim`: user can regenerate the SCIM provider token                       |
| GHSA-gv74-j8m3-fg5f | High 7.1         | 2026-05-31 | `@better-auth/sso`: registration without an org role check                             |
| GHSA-392p-2q2v-4372 | High 8.1         | 2026-05-31 | `@better-auth/oauth-provider`: refresh-token rotation forks the token family           |
| GHSA-7w99-5wm4-3g79 | High 8.1         | 2026-05-31 | `@better-auth/oauth-provider`: auth-code concurrent redemption (find-then-delete race) |
| GHSA-p2fr-6hmx-4528 | Med 6.4          | 2026-05-31 | `@better-auth/oauth-provider`: token audience not bound to the grant (RFC 8707)        |
| GHSA-86j7-9j95-vpqj | High             | 2026-05-31 | `oidc-provider` (deprecated): stored XSS via `javascript:` `redirect_uri`              |

**The count alone is misleading, in Better Auth's favour and against it.**

_In its favour:_ roughly **19 of the 31 are confined to plugins** we would never enable (SSO, SCIM,
Stripe, OAuth/OIDC-provider, MCP, passkey, device-authorization, api-key, multi-session). The heavy
2026 cluster is concentrated in enterprise-facing plugins added during the company's move upmarket.
A plugin-free consumer install has a much smaller exposure surface than "31 advisories" suggests.

_Against it:_ about **12 land on a plugin-free core install**, and several are squarely on the paths
we would use. The ones that matter here:

| GHSA                                 | Severity     | Why it matters to us                                                                                                                                    |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-g38m-r43w-p2q7 (CVE-2026-53516) | High 8.3     | **Core**: pre-account hijacking via OAuth implicit linking to an unverified pre-registered email (nOAuth class). We are social-login-only. Fixed 1.6.11 |
| GHSA-xg6x-h9c9-2m83                  | **Critical** | **2FA bypass via premature session caching in `session.cookieCache`**                                                                                   |
| GHSA-wxw3-q3m9-c3jr                  | Med 5.3      | **Core**: OAuth callback accepts a mismatched `state` with cookie-backed state storage and no PKCE                                                      |
| GHSA-p6v2-xcpg-h6xw (CVE-2026-45364) | High 7.3     | **Core**: rate limiter keys IPv6 addresses individually, bypassable by prefix rotation                                                                  |
| GHSA-x732-6j76-qmhm                  | High 8.6     | **Transitive**: `rou3` double-slash path normalisation bypassed `disabledPaths` and rate limits                                                         |
| GHSA-vp58-j275-797x                  | High 7.1     | **Core**: `trustedOrigins` bypass leading to account takeover                                                                                           |

Three of those deserve comment because they intersect this review's own findings.

**GHSA-xg6x-h9c9-2m83 is empirical confirmation of the `cookieCache` analysis above.** I flagged
`session.cookieCache` from source as the T11-class trap because it answers `getSession` without
consulting the session store. That is not a theoretical concern: it has already produced a **Critical
2FA bypass** in this codebase. The recommendation to keep `cookieCache` off is now backed by an
incident, not just by reading the code.

**GHSA-x732-6j76-qmhm is the AT-4 argument made concrete.** The vulnerable component was `rou3`, a
transitive dependency pulled in through `better-call`. My Appendix A8 finding that the 22-package
tree is small and high quality remains true, but "small and high quality" did not prevent a
transitive routing library from bypassing `disabledPaths` and the rate limiter. `better-call` and
`@better-fetch/fetch` are the maintainer's own sole-maintainer micro-packages, and they sit **on the
request path**.

**GHSA-p6v2-xcpg-h6xw undercuts the rate-limiting assessment in A6.** The built-in limiter is
usable, but it has already shipped an IPv6 keying bug that made it bypassable by rotating within a
prefix. Our own `enforceTokenRateLimit` keys on token id, not IP, and is therefore not vulnerable to
that class at all.

**One advisory is invisible to automated scanning, and that is a solo-operator problem. [verified]**
`GHSA-prpr-5gj3-qqhg` (High 8.1, SSO account takeover) renders as Published on the repo but
`gh api advisories/GHSA-prpr-5gj3-qqhg` returns **HTTP 404**: it never reached the global GitHub
Advisory Database. It will therefore not surface in `npm audit`, OSV, or Dependabot. For an operator
with no on-call whose vulnerability management is necessarily automated, an advisory class that
scanners cannot see is a material gap. Severity labels also disagree between the repo and the global
database in at least three cases, so the repo's own numbers should not be treated as authoritative.

The one on our path that is fully public is **GHSA-qq9h-g4jm-xgf3**, CVSS **8.3**:

> **VERBATIM** (https://github.com/better-auth/better-auth/security/advisories/GHSA-qq9h-g4jm-xgf3)
> "An attacker can keep password access to a victim's account after the victim starts using it. The attack runs in three steps. First, with open registration, the attacker signs up using the victim's email and a password the attacker picks."

Affected: `>= 1.1.3, < 1.6.22`. That is essentially **the entire 1.x line up to three releases before
current**, disclosed one month ago.

**The fair reading, both ways.** This specific bug needs `emailAndPassword` enabled to plant the
password, and Pull.fm issues no passwords by policy (`docs/PLAN.md` section 4), so we would not have
been exploitable by it. The fix is present in the version reviewed here: `revokeUnprovenAccountAccess`
is called on the magic-link verify path in 1.6.25 [verified in source]. And a project publishing ten
advisories in two months with CVSS scores and clean version ranges is a project that is **looking**,
which is better than silence.

Against that: the vulnerable class is "passwordless sign-in does not revoke pre-existing state on an
unverified account", which is squarely the magic-link flow we would depend on. Two of the OAuth
advisories are find-then-delete races and token-family forking, which are the same primitives our own
`connect_states` design deliberately got right with `DELETE ... RETURNING`. These are core-flow
mistakes, not peripheral ones.

**No public third-party security audit was found.** Stated explicitly rather than left ambiguous:
**no public third-party audit of Better Auth was found as of 2026-07-29.** The negative was tested,
not assumed: code search across `org:better-auth` for "Cure53", "Trail of Bits", "bug bounty",
"penetration test" and "audited by" returns **zero results each**; neither the June nor the July 2026
security blog post names any firm; and the docs security reference covers features and never mentions
an audit. The advisory clusters are an **internal** security-review workstream, described by the
project itself as covering "report triage, focused code review, automated and manual scanning,
variant analysis, patch review, release coordination, and advisory publication" [VERBATIM].

**The closest thing to independent scrutiny is automated, and the response to it was excellent.**
ZeroPath found CVE-2025-61928 (unauthenticated API key creation) by static dataflow analysis:
discovered 2025-10-01, disclosed 2025-10-02, **patch released 2025-10-03**. A one-day turnaround on a
High-severity report is a genuinely good signal about the team, and it should be weighed against the
advisory count rather than buried under it.

**The support policy is the operational sting. [verified]**

> **VERBATIM** (https://github.com/better-auth/better-auth/security/policy)
> "We only support the latest version of Better Auth. Older versions are not supported."

There is no LTS line and no backported patches. Adopting Better Auth means committing to track the
newest release on the authentication path indefinitely, on a project with 915 published versions and
a release roughly every few days. For a solo operator with no on-call, that is a **standing,
non-deferrable patch obligation on the most security-sensitive code in the system**, and it is the
single strongest operational argument against adoption.

### A10. Integration cost against what already exists

Not a security finding, but it bears on risk, because rewriting working security code is itself a
risk. The Fastify integration is a catch-all route that rebuilds a Fetch `Request` from the Fastify
request, including `JSON.stringify(request.body)`. [verified, docs]

Everything in the following list is code we already own, have tested, and would have to re-verify
against a new session model: the `requireAuth` credential-type asymmetry in
`apps/bff/src/plugins/auth.ts`, the dual upstream+local revocation in
`apps/bff/src/routes/v1/auth.ts`, the `noeviction` deny-list, the 99-case BOLA suite in
`apps/bff/test/security/bola.test.ts` (which asserts credential shapes never appear in any
response), the `X-User-Id` and `user_id` rejection tests, and the redaction paths in
`apps/bff/src/lib/logger.ts`. The brief says anything adopted must slot under those. Better Auth
can be made to, but only by disabling or bypassing a good deal of what it offers.

---

## Appendix B: source reachability

Recorded so that a later reader can tell what was checked from what was assumed.

| Source                                                                               | URL                                                                                                | Result                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Better Auth package                                                                  | `npm pack better-auth@1.6.25`                                                                      | 200, 372,935 bytes, source read directly                     |
| Better Auth core / utils / redis-storage                                             | `npm pack @better-auth/{core,utils,redis-storage}`                                                 | 200, source read directly                                    |
| Better Auth dependency tree                                                          | `npm install better-auth --omit=dev`                                                               | 22 packages, all depth 1                                     |
| Better Auth advisories                                                               | `github.com/better-auth/better-auth/security/advisories`                                           | 200, 10 advisories listed                                    |
| GHSA-qq9h-g4jm-xgf3 detail                                                           | `github.com/.../security/advisories/GHSA-qq9h-g4jm-xgf3`                                           | 200, CVSS 8.3, ranges confirmed                              |
| Better Auth security policy                                                          | `github.com/better-auth/better-auth/security/policy`                                               | 200                                                          |
| Better Auth repo + contributors                                                      | `gh api repos/better-auth/better-auth`                                                             | 200                                                          |
| Better Auth docs: sessions, cookies, database, security, magic-link, bearer, fastify | `better-auth.com/docs/...`                                                                         | 200 throughout                                               |
| WorkOS pricing                                                                       | `workos.com/pricing`                                                                               | 200                                                          |
| WorkOS security                                                                      | `workos.com/security`                                                                              | 200                                                          |
| WorkOS DPA                                                                           | `workos.com/legal/dpa`                                                                             | 200                                                          |
| WorkOS data residency                                                                | `workos.com/docs/data-residency`                                                                   | **404**                                                      |
| WorkOS security docs                                                                 | `workos.com/docs/security`                                                                         | **404**                                                      |
| Neon Auth overview                                                                   | `neon.com/docs/auth/overview`                                                                      | 200                                                          |
| Neon Auth roadmap                                                                    | `neon.com/docs/auth/roadmap`                                                                       | 200                                                          |
| Neon Auth legacy (Stack Auth)                                                        | `neon.com/docs/auth/legacy/overview`                                                               | 200                                                          |
| Neon Auth quick-start / api-reference / neon-auth-legacy                             | `neon.com/docs/neon-auth/...`                                                                      | **404** (three URLs)                                         |
| Stack Auth                                                                           | `stack-auth.com`                                                                                   | **308 redirect to www.hexclave.com**                         |
| Hexclave                                                                             | `www.hexclave.com`                                                                                 | 200, landing copy only                                       |
| Lucia                                                                                | `lucia-auth.com`                                                                                   | 200, now a resource site not a library                       |
| npm registry recency checks                                                          | `npm view <pkg> version time deprecated`                                                           | 200 for all seven packages checked                           |
| Self-hosted project health                                                           | `gh api repos/{ory/kratos, zitadel, keycloak, logto, authentik, supertokens-core, casdoor, hanko}` | 200 for all                                                  |
| Passage                                                                              | `passage.id`, `docs.passage.id`                                                                    | **connection refused** (both)                                |
| Better Auth full advisory set                                                        | `gh api repos/better-auth/better-auth/security-advisories`                                         | 200, 30 records (the web page shows only 10)                 |
| GHSA-prpr-5gj3-qqhg in the global DB                                                 | `gh api advisories/GHSA-prpr-5gj3-qqhg`                                                            | **404** while the repo shows it Published                    |
| WorkOS DPA, Exhibit B                                                                | `workos.com/legal/data-processing-addendum`                                                        | 200, US named as sole storage/access country                 |
| WorkOS trust centre                                                                  | `trust.workos.com`                                                                                 | 200 but **JS-only, unreadable**; ISO 27001 status unverified |
| Clerk security                                                                       | `clerk.com/security`, `trust.clerk.com`                                                            | **404** and **403**                                          |
| Stytch security / trust                                                              | `stytch.com/security`, `stytch.com/trust`                                                          | **404** (both)                                               |
| Stytch per-MAU overage                                                               | `stytch.com/pricing`                                                                               | 200 but the rate is **not published**                        |
| Descope sub-processors and DPA                                                       | `descope.com/subprocessors`, `/legal/dpa`                                                          | **404** (both)                                               |
| Descope trust centre                                                                 | `trust.descope.com`                                                                                | **403** to automated fetch                                   |
| PropelAuth privacy policy                                                            | privacy-policy URL                                                                                 | **404**                                                      |
| Firebase Auth residency                                                              | `firebase.google.com/support/privacy`                                                              | 200, US-only stated explicitly                               |
| npm dist-tags / maintainers / provenance                                             | `registry.npmjs.org`                                                                               | 200 throughout                                               |
| WebSearch                                                                            | n/a                                                                                                | **budget exhausted mid-review (200/200)**                    |

Claims that remain **unverified** and are flagged as such in the text: WorkOS ISO 27001 status
(trust centre is JS-only); Stytch's per-MAU overage above 10k (not published); **Auth0's price at
50,000 MAU** (self-serve tiers stop at 30,000); **Descope's SOC 2 / ISO 27001 / CSA STAR / PCI DSS**
(trust centre 403, several security URLs 404; only FedRAMP High was confirmable); Descope's Pro-tier
MAU inclusion and its sub-processor list (no public page); **whether Descope's EU region is actually
plan-gated** (the docs say Growth-and-above, the pricing page lists multi-region as included across
tiers, and the two flatly contradict each other, so get it in writing); Kinde's SOC 2 report tier
(pricing table and compliance doc disagree) and its overage
arithmetic (the on-page calculator disagrees with the stated 10,500 allowance); PropelAuth's data
location, export path and company history; whether Neon backported the Better Auth fix without moving
its version string; Firebase's per-MAU bands above 50k and whether its auth regionalisation preview
ever shipped; Cognito's certifications and whether a true clickable magic link is achievable
natively; Better Auth's and Hanko's audit status beyond "none found"; and two aggregator-sourced Okta
incident claims (Oct 2025, Jun 2026) that no primary source corroborated.

**Where two independent research passes disagreed**, both figures are reported rather than one being
silently chosen: Auth0 at 50k MAU ($3,500/mo on Essentials versus "not public"), and Descope's
commercial attestations (claimed versus unfetchable). Disagreement between passes is itself a signal
that the underlying page is ambiguous or gated, and is treated that way here.

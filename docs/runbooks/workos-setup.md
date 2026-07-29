# Runbook: configuring WorkOS from scratch

Operator runbook for standing up the WorkOS account that Pull.fm authenticates
against, from an empty workspace to a working sign-in in both environments.

**Audience:** the operator. **Duration:** about 40 minutes, plus DNS propagation
if the production email domain is configured in the same sitting.

> **This repository is public.** No API key, secret, or signing secret may ever
> be written into a file in this repo, including `.env`. Every credential in this
> runbook lands in 1Password and is resolved at runtime through `op://`
> references. Step 7 is not optional and gitleaks will block a commit that
> ignores it.

## 0. The launch configuration, and what is deliberately switched off

Decide this before touching the dashboard, because two of the three are hard to
reverse later.

| Factor            | At launch      | Why                                                                                                                          |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Magic Auth**    | **Enabled**    | The only sign-in method at launch. Emailed one-time code, no password ever created                                           |
| **Passwords**     | Never          | WorkOS does not export password hashes. Never creating one is what keeps a migration path open. See `docs/PLAN.md` section 4 |
| **Social login**  | **Off**        | See below                                                                                                                    |
| **Passkeys**      | **Off**        | See below                                                                                                                    |
| **Custom domain** | **Not bought** | $99/mo, and nothing at launch requires it                                                                                    |

**Why social login is off.** Google and Apple OAuth run through a WorkOS-hosted
redirect. WorkOS documents that with the default credentials "Google's
authentication flow will display WorkOS' name, logo, and other information to
users", and the redirect URI registered in Google Cloud is a WorkOS domain until
a custom auth domain replaces it. Fixing that means the custom domain add-on at
**$99/mo**, which is roughly the entire target run rate of the service. Magic
Auth has no such hosted-branding surface: the user sees an email and a code.
Social login can be enabled later at any time with no migration, because nothing
about a magic-link account forecloses linking a Google identity to the same email
afterwards. It is **deferred, not rejected**, and the decision plus what would
have to become true to revisit it lives in
[`docs/PLAN.md` section 4a](../PLAN.md).

**Why passkeys are off, and this is the one that would be permanent.** WorkOS
states plainly:

> "Passkeys are bound to the domain they were registered on."

and, on adding a custom domain after the fact:

> "Adding the domain later would prevent the usage of passkeys that were
> registered on the old domain."

So enrolling passkeys on the default WorkOS domain, then later moving to
`auth.pull.fm`, **invalidates every passkey that exists** and locks out any user
who has no other factor. Passkeys are a good feature and we want them. They are a
feature to enable **after** the custom domain is bought and verified, never
before. Do not turn this on to try it.

Record the decision in the environment: if any of this changes,
`legal/privacy-policy.md` section 3.1 changes with it, because it states which
sign-in methods exist and therefore what identity data we receive.

## 1. Workspace and environments

Every workspace ships with two environments and they do not share anything:

> "Every WorkOS workspace includes a staging environment and a production
> environment."

> "API keys, organizations, connections, users, webhook endpoints, and branding
> are all scoped to a single environment and don't carry over between them."

> "Staging and production are fully isolated, and there isn't a built-in way to
> promote or migrate organizations, connections, or users between them."

Practical consequences, all of which have bitten someone:

- **Every step in this runbook is performed twice**, once per environment.
  Nothing you configure in staging appears in production.
- The environment switcher is in the dashboard header. Check it before every
  change. A redirect URI added to the wrong environment produces an
  `invalid_redirect_uri` error that looks like a code bug.
- Test users created in staging do not exist in production. The first production
  sign-in creates the first production user.
- Branding is the single exception and can be copied between environments.

Map the environments to Pull.fm's `DEPLOY_ENV`:

| WorkOS environment | `DEPLOY_ENV`          | API host              | Notes                                                                      |
| ------------------ | --------------------- | --------------------- | -------------------------------------------------------------------------- |
| Staging            | `local` and `staging` | `api-staging.pull.fm` | Local development points at the staging environment. Do not create a third |
| Production         | `production`          | `api.pull.fm`         | Real users only                                                            |

Local development sharing the staging WorkOS environment is deliberate: it keeps
the number of environments that can drift down to two, and the staging API key is
reviewable in the dashboard rather than shown once, so a lost laptop key is
recoverable without rotation.

## 2. API key and Client ID

Both live in the dashboard, per environment, under **API Keys** (developer
settings). The Client ID has the form `client_...`; the secret key has the form
`sk_test_...` in staging and `sk_live_...` in production.

- **`WORKOS_CLIENT_ID` is not a secret.** It is shipped to clients and is already
  committed in `.env.example`. Do not treat it as a credential and do not rotate
  it casually: it is what the BFF derives the JWKS URL from in production.
- **`WORKOS_API_KEY` is a secret** and grants full account authority, including
  deleting users.
- Visibility differs by environment. Staging keys are reviewable in the dashboard
  at any time; the production key is **"Shown once at creation - store
  securely"**. Put the production key into 1Password in the same browser session
  you create it in, before navigating away. If it is lost, the only remedy is to
  create a new one and roll the deployment.

Copy both into 1Password now (step 7), then continue.

## 3. Redirect URIs

Dashboard section: **Redirects**. This page holds four separate settings and
three of them are commonly missed.

**Redirect URIs.** The callback WorkOS sends the browser to after an interactive
sign-in. Pull.fm's callback is `GET /v1/auth/callback`
(`apps/bff/src/routes/v1/auth.ts`), so the value is always
`{PUBLIC_BASE_URL}/v1/auth/callback`:

| Environment         | Redirect URI                                   |
| ------------------- | ---------------------------------------------- |
| Staging (local dev) | `http://localhost:3000/v1/auth/callback`       |
| Staging (deployed)  | `https://api-staging.pull.fm/v1/auth/callback` |
| Production          | `https://api.pull.fm/v1/auth/callback`         |

Notes that matter:

- `http://localhost` is accepted for development. Everything else must be HTTPS.
- The comparison is **exact**. `127.0.0.1` and `localhost` are different values,
  and `.env.example` ships `PUBLIC_BASE_URL=http://127.0.0.1:3000`. Pick one
  spelling and use it in both places, or the callback fails at the last step of
  an otherwise successful sign-in.
- WorkOS supports wildcards in redirect URIs **but not for the default redirect
  URI**. We do not need wildcards; do not add one.

**Default redirect URI.** Used when a sign-in begins without an explicit
redirect. Set it to the deployed URI of that environment, not the localhost one,
or a production sign-in initiated from an email link can be sent to a machine
that is not running.

**Sign-in endpoint.** Where WorkOS sends a user whose authentication request did
not start in our app. Point it at the app sign-in entry point
(`https://app-staging.pull.fm` / `https://app.pull.fm`).

**Sign-out redirect.** Set it. WorkOS's own documentation warns: "If you haven't
configured a Sign-out redirect in the WorkOS dashboard, users will see an error
when logging out." This is the single most common omission in a fresh
environment.

## 4. Enable Magic Auth

Dashboard section: **Authentication**. Enable **Magic Auth**. Leave every other
method off, per section 0.

- One-time codes **expire after 10 minutes**. This is WorkOS's fixed behaviour,
  not a setting, and it is worth knowing when a user reports "the code didn't
  work" twenty minutes later.
- Once enabled, Magic Auth appears immediately as a sign-in and sign-up option on
  the AuthKit screen. No deploy is needed on our side.
- Verify by signing in from the staging environment with a real mailbox you
  control before touching production.

### 4a. Sending a code CREATES a user. Plan for the directory to be dirty.

**Verified against the live staging API on 2026-07-29**, not taken from the
documentation: `POST /user_management/magic_auth/send` **auto-creates a WorkOS
user** when the address does not already have one, with `email_verified: false`,
and returns **200**. It does not refuse an unknown address. A probe sent to a
nonexistent address at `example.com` produced a real `user_...` record in the
directory, which then had to be deleted by hand.

This matters because `POST /v1/auth/start` is **unauthenticated**. Anyone can
cause a directory record to exist for any address they can type, including the
address of a real person who has never heard of Pull.fm. That is not merely
untidy: holding an email address for someone who never consented and has no
relationship with the service has no lawful basis under **GDPR Article 6**, and
the affected person is not a user, so they would have no reason to come looking
for us to exercise a right over it.

Two controls compensate, and they are independent. Neither is sufficient alone,
because one bounds the rate and the other bounds the duration:

| Control                                                          | Bounds                      | Where                                       |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| `AUTH_MAGIC_AUTH_PER_IP_MAX` and `AUTH_MAGIC_AUTH_PER_EMAIL_MAX` | how FAST records can appear | `apps/bff/src/services/magic-auth.ts`       |
| The directory reaper                                             | how LONG one survives       | `apps/bff/src/services/directory-reaper.ts` |

**The send budgets are not only abuse protection.** They are the primary bound
on directory pollution. Anyone retuning them upward needs to know that, and it
is written into the code at both call sites for that reason.

**The reaper** deletes records that were auto-created and never verified. It is a
command, not something the API does on a request:

```
pnpm --filter @pull-fm/bff reap:unverified
```

**Nothing in this repository schedules it, and putting it on a schedule is a step
of this runbook, not something that has already happened.** Until it is
scheduled, `AUTH_UNVERIFIED_REAP_AFTER_S` bounds how long an unconsented record
survives _a run_, not how long it exists. This is the same gap recorded as item 1
of the appendix in `legal/privacy-policy.md`, which covers the other two
retention jobs.

Run it **hourly or daily**. The window is a duration, not a cadence, so running
it more often reaps nothing extra; running it less often than daily means
`AUTH_UNVERIFIED_REAP_AFTER_S` stops being an upper bound at all.

It deletes a record only when **all four** hold, and the first is the one that
makes it safe: WorkOS reports `email_verified` **strictly false**; the record is
older than the window; we hold **no local `users` row** for it, including a
soft-deleted one; and nothing about the record is unknown. An absent
`email_verified` or an unparseable `created_at` means skip, never delete.

Exit codes are meant for the scheduler: **0** ran or declined because another
run held the lock, **1** could not run and deleted nothing (the case worth
alerting on, because the directory is unbounded until it succeeds), **2** ran
but a deletion failed or the blast-radius cap was hit (self-healing next run).

**Consequence for counting users.** Directory size is not signup count. A record
with `email_verified: false` is somebody who was sent a code, which includes
every address an attacker typed. Count verified records, or count rows in our
own `users` table, which only gains a row on a completed verification.

## 5. Email sender

Until a custom email domain is configured, WorkOS sends from its own domains:
**`workos.dev` in staging** and **`workos-mail.com` in production**. Staging is
fine as it is and cannot be changed; the custom-domain options are production
only ("In the staging environment these will always use a WorkOS domain, however
in production you have the option to provide your own custom domain").

For production, decide between two positions:

| Option                                       | Cost                                      | Consequence                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leave the default** (`workos-mail.com`)    | $0                                        | Sign-in codes arrive from a domain the user has never heard of. Measurably worse deliverability and a phishing-shaped first impression, on the one email the product cannot afford to have filtered |
| **Custom email domain** (`no-reply@pull.fm`) | Paid add-on. Price `[CONFIRM]`, see below | Sign-in codes come from our own domain                                                                                                                                                              |

To configure the custom email domain: dashboard **Domains** section, in the
**production** environment, add the domain, create the **3 CNAME records** WorkOS
displays with the DNS provider (Cloudflare, in the `pull.fm` zone), then click
**Verify now**. Verification is retried for up to 72 hours if it does not succeed
immediately. Once verified, authentication emails are sent from
`no-reply@pull.fm`.

**It is not free.** Re-checked against the live documentation on 2026-07-29:
`workos.com/docs/custom-domains` lists **four** custom domain types (email,
AuthKit, Admin Portal, Authentication API) and says of the feature as a whole,
"This is a paid service, for which you can find additional details on our pricing
page". So a custom email domain is a paid add-on, and the "included in the plan"
half of the old question is answered: it is not.

`[CONFIRM]` **whether all four domain types are one $99/mo purchase or $99/mo
each.** `workos.com/pricing` lists exactly one "Custom domain $99/mo" line and
does not say which of the four it buys; the email-domain page states no price at
all. The two readings differ by $99/mo on a project whose entire target run rate
is about that, so this is worth an email to WorkOS rather than an assumption. Do
not budget a number until they answer.

Because Magic Auth is the **only** sign-in method at launch, email deliverability
is not a polish item, it is the availability of the login. If the default sender
is kept, add a deliverability check to the launch checklist: send to a Gmail, an
iCloud, an Outlook, and a Fastmail address and confirm none of them land in spam.

## 6. Webhook for `user.deleted`

Pull.fm exposes `POST /v1/webhooks/workos`. An identity deleted at WorkOS must
cascade here or it orphans the user's rows, including their encrypted
third-party credentials, forever.

1. Dashboard **Webhooks**, per environment. Create an endpoint:
   - Staging: `https://api-staging.pull.fm/v1/webhooks/workos`
   - Production: `https://api.pull.fm/v1/webhooks/workos`
2. Subscribe to `user.deleted`.
3. Copy the **signing secret** into 1Password as `WORKOS_WEBHOOK_SECRET`.

This secret is not optional in any deployed environment. From `.env.example`:
without it the route "answers 503 and processes nothing; in production the
process refuses to start at all". That is deliberate, because an unverified
webhook on this route is an unauthenticated mass-deletion endpoint.

## 7. Storing the credentials in 1Password

Vault: **MCP**. Follow the item names already referenced from `.env.example` so
there is exactly one naming scheme.

| Item                                       | Field        | Env var                 | Secret?                                                                              |
| ------------------------------------------ | ------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| `Pull.fm WorkOS Staging API Key`           | `credential` | `WORKOS_API_KEY`        | Yes                                                                                  |
| `Pull.fm WorkOS Production API Key`        | `credential` | `WORKOS_API_KEY`        | Yes                                                                                  |
| `Pull.fm WorkOS Webhook Secret`            | `credential` | `WORKOS_WEBHOOK_SECRET` | Yes (staging)                                                                        |
| `Pull.fm WorkOS Production Webhook Secret` | `credential` | `WORKOS_WEBHOOK_SECRET` | Yes                                                                                  |
| Client IDs                                 | -            | `WORKOS_CLIENT_ID`      | **No.** Public identifier, lives in `.env.example` and in deploy config in the clear |

Set the item's username field to the environment variable name and tag the items
`workos` and `pull-fm`, so a later audit can enumerate them.

**Local development.** Never write the value to `.env`. Use `direnv`, with an
`.envrc` that contains only `op://` references, which is safe to commit:

```bash
# .envrc  (contains references, never values)
export WORKOS_API_KEY="$(op read 'op://MCP/Pull.fm WorkOS Staging API Key/credential')"
export WORKOS_WEBHOOK_SECRET="$(op read 'op://MCP/Pull.fm WorkOS Webhook Secret/credential')"
export WORKOS_CLIENT_ID="client_..."   # public, fine in the clear
```

The secrets then exist only in 1Password and in the process environment, never on
disk.

**Deployed environments.** The same values are set as deployment secrets. Setting
a secret on any deploy platform without recording it in the MCP vault first is
not a shortcut, it is an unrecorded credential.

**Rotation.** Rotating the API key is: create a new key in the dashboard, update
the 1Password item, roll the deployment, then delete the old key **in that
order**. Deleting first is a self-inflicted outage on the sign-in path.

## 8. Verification checklist

Run per environment. Every line is a thing that has silently been wrong in a
fresh WorkOS environment.

- [ ] The environment switcher shows the environment you meant to configure
- [ ] `WORKOS_CLIENT_ID` in deploy config matches the Client ID on the **API
      Keys** page of that same environment
- [ ] Redirect URI is present, exact, and matches `{PUBLIC_BASE_URL}/v1/auth/callback`
- [ ] Default redirect URI is set, and is not the localhost one in production
- [ ] Sign-out redirect is set (otherwise logout errors)
- [ ] Magic Auth is on; password, social, and passkeys are all off
- [ ] A real sign-in completes: code arrives, `POST /v1/auth/verify` returns a
      session, and a row appears in `users`
- [ ] The reaper is scheduled (hourly or daily) and a manual run exits 0. Send a
      code to a throwaway address, confirm an unverified record appears in the
      directory, backdate or wait out `AUTH_UNVERIFIED_REAP_AFTER_S`, and
      confirm the record is gone while your own verified record is not
- [ ] An `auth.callback` row appears in `audit_log` with `outcome = 'ok'`
- [ ] Webhook endpoint is registered, subscribed to `user.deleted`, and the
      signing secret is in the environment. Send a test event and confirm it is
      accepted, then confirm a **tampered** body is rejected and produces a
      `webhook.rejected` audit row
- [ ] Production API key is in 1Password, verified by reading it back with
      `op read`, before the browser tab is closed
- [ ] `git grep -i "sk_live\|sk_test_[A-Za-z0-9]" -- ':!*.example'` returns nothing

## 9. What this costs

| Item                      | Cost                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AuthKit / User Management | **$0.** WorkOS prices the first 1M monthly active users free                                                                       |
| Custom domain add-on      | $99/mo. **Not purchased.** See section 0. Whether a custom email domain is that same $99 or a second one is `[CONFIRM]`, section 5 |
| Audit Logs product        | $99/mo per million events. **Not purchased**, and not needed: our audit trail is our own `audit_log` table                         |
| Radar (fraud protection)  | First 1,000 checks free, then $100/mo per 50,000. Not enabled                                                                      |

## 10. Sources

Every navigation label and quoted string in this runbook was checked against the
live documentation on **2026-07-29**.

| Claim                                                                                                                              | Source                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Staging and production isolation, per-environment keys, production key shown once, branding is the only copyable thing             | `workos.com/docs/environments`                                             |
| **Redirects** section, default redirect URI, wildcard limitation, sign-out redirect warning                                        | `workos.com/docs/authkit/nextjs`, `workos.com/docs/authkit/vanilla/nodejs` |
| Magic Auth enabled in the **Authentication** section; 10 minute code expiry                                                        | `workos.com/docs/user-management/magic-auth`                               |
| `magic_auth/send` auto-creates an unverified user and returns 200 for an unknown address                                           | **Live staging API probe, 2026-07-29.** Not documented; see section 4a     |
| Passkeys enabled in the **Authentication** section; domain binding quotes                                                          | `workos.com/docs/authkit/passkeys`                                         |
| Custom domains are production-only; four domain types (email, AuthKit, Admin Portal, Authentication API); "This is a paid service" | `workos.com/docs/custom-domains`                                           |
| **Domains** section, 3 CNAME records, **Verify now**, 72 hour retry, `workos-mail.com` / `workos.dev` defaults, `no-reply@` result | `workos.com/docs/custom-domains/email`                                     |
| Google consent screen shows WorkOS branding by default; custom domain yields a new redirect URI                                    | `workos.com/docs/integrations/google-oauth`                                |
| First 1M MAUs free; custom domain $99/mo; Audit Logs and Radar pricing                                                             | `workos.com/pricing`                                                       |

`[OPEN]` The exact dashboard label for the API keys page could not be read from
the public documentation (the framework guides say only "your WorkOS API Key and
Client ID"). It is the developer **API Keys** page in the dashboard. Correct this
line the first time someone runs the runbook.

`[CONFIRM]` Whether a custom **email** domain is billed under the same $99/mo
custom-domain add-on as the AuthKit auth domain, or as a second one. Narrowed but
not closed against the live documentation on 2026-07-29: custom domains are
confirmed to be a paid service, and the pricing page lists one $99/mo line
against four domain types without saying which. Full detail in section 5.

**The sign-in set is settled: magic link only.** The conflict this runbook used
to record is resolved.
[`docs/PLAN.md` section 4a](../PLAN.md) carries the full reasoning, supersedes
the earlier "Google + Apple OAuth and magic-link only" wording in section 4, and
is the place to argue with the decision rather than here.
`legal/privacy-policy.md` section 3.1 agrees, and always did.

Read section 4a before enabling anything in the **Authentication** dashboard
section. It is enforced by three independent controls, not just written down: a
test that fails if any password, social, passkey or SSO route is ever registered,
the `users_auth_method_chk` constraint in
`packages/db/migrations/0005_magic_auth_identity.sql`, and the route and service
headers. Adding a sign-in method means changing that section, a test, and a
migration, which is the intended cost.

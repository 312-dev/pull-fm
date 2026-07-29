# The staging prototype: how to drive it

**There is a running Pull.fm API. This page is how you talk to it.**

```
https://api-staging.pull.fm
```

It is a real deployment, not a mock: Cloudflare in front, nginx and an
origin-pull certificate on a Hetzner node in Helsinki, the BFF in a
digest-pinned container, Redis beside it, and Postgres in a Neon branch in
`aws-eu-central-1`. Everything below was executed against that URL on
2026-07-29 and the responses quoted are the ones it gave.

**It costs USD 23.59 a month while it is up** (section 8). Leaving it running
is deliberate. Tearing it down is one command when you are done.

---

## 1. Sixty seconds

```bash
curl -sS https://api-staging.pull.fm/healthz
# {"status":"ok","version":"2e2878322d0ec06cad1d6cd5e7bd59a95be06f04","uptimeSeconds":5}

curl -sS https://api-staging.pull.fm/readyz
# {"status":"ready","checks":{"database":"ok","redis":"ok"}}

curl -sS https://api-staging.pull.fm/v1/config
# {"minSupportedBuild":1,"maintenance":false,
#  "features":{"personalApiTokens":true,"wishlist":true,"discovery":true,"events":false},
#  "providers":{"listenbrainz":"ok","lastfm":"disabled","musicbrainz":"ok",
#               "previews":"ok","events":"disabled"}}
```

`events` is **false on purpose**, and it read `true` until 2026-07-29. See
section 4.

Those three need no credential. `version` is the commit that is serving, and it
is the answer to "did my change deploy": it should equal `git rev-parse
origin/main`.

Everything else needs authentication. Section 2 gets you a credential in one
command.

---

## 2. Authenticating

### The fast path: your personal API token

A token already exists, it is yours, and it is in 1Password. **It is never
written into this repository, and neither is anything else.**

```bash
export PULLFM_TOKEN="$(op read 'op://MCP/bsegiuwgdg4w5igbgyoteafgqq/password')"

curl -sS https://api-staging.pull.fm/v1/me \
  -H "Authorization: Bearer $PULLFM_TOKEN"
```

```json
{
  "id": "0ede7b7f-9c92-4914-8182-4509aae1656b",
  "createdAt": "2026-07-29T08:49:15.304Z",
  "authMethod": "token",
  "signInMethod": "magic_auth",
  "email": "gray@grayada.ms",
  "displayName": null,
  "emailVerifiedAt": "2026-07-29T09:06:24.855Z",
  "lastAuthenticatedAt": "2026-07-29T09:06:24.855Z",
  "connectionCount": 0,
  "wishlistCount": 1
}
```

The 1Password item is titled `pull-fm/staging/PROTOTYPE_API_TOKEN`. It is
addressed **by item id** above, not by title, because `op read` cannot resolve
an `op://` reference whose item title contains a slash and every item in this
project has one. `op item get 'pull-fm/staging/PROTOTYPE_API_TOKEN' --vault MCP
--fields label=password --reveal` is the equivalent by title.

The token is `pfm_test_`-prefixed, scoped `read:me read:wishlist
read:recommendations read:connections`, expires **2026-10-27**, and is budgeted
at 60 requests per minute. Every response tells you where you are:

```
ratelimit-limit: 60
ratelimit-remaining: 59
ratelimit-reset: 60
```

**The prefix follows the data, not the environment name.** Staging runs
`NODE_ENV=production` and still issues `pfm_test`, because what the prefix has
to communicate is whose data the credential reaches.

### What a token deliberately cannot do

A personal API token is **read-only**. On a route that needs an interactive
session it returns 403, and the message says so rather than making you guess:

```bash
curl -sS "https://api-staging.pull.fm/v1/search?q=radiohead" \
  -H "Authorization: Bearer $PULLFM_TOKEN"
```

```json
{
  "type": "https://pull.fm/problems/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "This operation requires an interactive session. Personal API tokens are read-only."
}
```

Section 3's table marks which routes those are. For them, use a session.

### The other path: a session, by magic link

Sign-in is magic-link only. There is no password, no social login and no
passkey. Two calls:

```bash
# 1. Ask for a code. Always 202, whether or not the address is known.
curl -sS -X POST https://api-staging.pull.fm/v1/auth/start \
  -H 'Content-Type: application/json' \
  -d '{"email":"gray@grayada.ms"}'
# {"status":"sent","expiresInSeconds":600, ...}

# 2. Read the six-digit code out of your mail, then exchange it.
SESSION=$(curl -sS -X POST https://api-staging.pull.fm/v1/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"email":"gray@grayada.ms","code":"123456","transport":"bearer"}' \
  | jq -r .accessToken)

curl -sS https://api-staging.pull.fm/v1/me -H "Authorization: Bearer $SESSION"
```

**A session access token lives five minutes.** That is short enough to be
annoying by hand and is why the token in section 2 is the recommended path for
poking at the API. Use the `refreshToken` from the same response against
`POST /v1/auth/refresh` to get another, or just run the two calls again.

`"transport":"cookie"` instead returns no credential in the body and sets a
sealed `__Host-pullfm_session` cookie. A cookie-borne session is only honoured
when the request also carries an `X-Pullfm-Session` header (any value); that is
the CSRF control, and without the header you get 403.

#### Getting a session without waiting for mail

Useful for scripting, and it is how every session in this document was made.
WorkOS will mint the code over its own API instead of emailing it, so the loop
closes without a mailbox:

```bash
WK=$(op item get qr6sfpfzskhpqtzbehw7kdheti --vault MCP --fields label=password --reveal)
CODE=$(curl -sS -X POST https://api.workos.com/user_management/magic_auth \
  -H "Authorization: Bearer $WK" -H 'Content-Type: application/json' \
  -d '{"email":"gray@grayada.ms"}' | jq -r .code)

SESSION=$(curl -sS -X POST https://api-staging.pull.fm/v1/auth/verify \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"gray@grayada.ms\",\"code\":\"$CODE\",\"transport\":\"bearer\"}" \
  | jq -r .accessToken)
```

### Minting another token

Token management is session-only, on purpose: a leaked read-only token cannot
mint itself a better one.

```bash
curl -sS -X POST https://api-staging.pull.fm/v1/tokens \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d '{"name":"laptop","scopes":["read:me","read:recommendations"],"expiresInDays":90}'
```

The secret comes back **once**, in `.token`. Only a SHA-256 digest of it is
stored, so there is no "show it again". Ten live tokens per account; a
duplicate name is a 409.

---

## 3. Every endpoint

`session` means an interactive session only. `token` means a personal API token
works too, with the scope named. `none` means no credential.

### Platform

| Method | Path            | Auth | What it does                                                       |
| ------ | --------------- | ---- | ------------------------------------------------------------------ |
| GET    | `/healthz`      | none | Liveness. Touches nothing. `version` is the serving commit.        |
| GET    | `/readyz`       | none | Postgres and both Redis instances, named individually. 200 / 503.  |
| GET    | `/v1/config`    | none | Min supported build, maintenance flag, feature and provider state. |
| GET    | `/openapi.json` | none | The generated OpenAPI 3.1 document.                                |
| GET    | `/docs`         | none | Self-hosted Scalar reference. Redirects to `/docs/`.               |
| GET    | `/metrics`      | -    | **404 from the internet, by design.** See section 7.               |

### Authentication

| Method | Path                | Auth    | What it does                                            |
| ------ | ------------------- | ------- | ------------------------------------------------------- |
| POST   | `/v1/auth/start`    | none    | Request a magic-link code. Always 202.                  |
| POST   | `/v1/auth/verify`   | none    | Exchange email + code for a session.                    |
| POST   | `/v1/auth/refresh`  | none    | Exchange a refresh token for a new session.             |
| POST   | `/v1/auth/logout`   | session | Revoke at WorkOS and add the session id to a deny list. |
| GET    | `/v1/auth/callback` | none    | Legacy AuthKit code exchange. Not used by the client.   |

### Account

| Method | Path                     | Auth               | What it does                                                                    |
| ------ | ------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| GET    | `/v1/me`                 | session, `read:me` | The account, plus connection and wishlist counts.                               |
| PATCH  | `/v1/me`                 | session            | Update `firstName` / `lastName`.                                                |
| DELETE | `/v1/me`                 | session            | Irreversible. Needs auth under 15 minutes old and `{"confirm":"<your email>"}`. |
| GET    | `/v1/me/export`          | session            | Request a GDPR export. 202 with a single-use download link.                     |
| GET    | `/v1/me/export/download` | session            | Consume the ticket and return the export JSON.                                  |

### Tokens (session only, all four)

| Method | Path                    | What it does                                    |
| ------ | ----------------------- | ----------------------------------------------- |
| POST   | `/v1/tokens`            | Create one. Secret returned once. 201.          |
| GET    | `/v1/tokens`            | List metadata. Never the secret.                |
| DELETE | `/v1/tokens/:id`        | Revoke immediately. Someone else's id is a 404. |
| POST   | `/v1/tokens/:id/rotate` | Revoke and reissue in one transaction. 201.     |

### Connections (`:service` is `listenbrainz` or `lastfm`)

| Method | Path                                | Auth                        | What it does                           |
| ------ | ----------------------------------- | --------------------------- | -------------------------------------- |
| GET    | `/v1/connections`                   | session, `read:connections` | Connected services, metadata only.     |
| POST   | `/v1/connections/:service`          | session                     | Start a connect flow, or post a token. |
| GET    | `/v1/connections/:service/callback` | session                     | Complete it. State is single-use.      |
| DELETE | `/v1/connections/:service`          | session                     | Disconnect.                            |

`lastfm` answers **501** on this deployment: no Last.fm key is configured.

### Wishlist

| Method | Path                       | Auth                     | What it does                                        |
| ------ | -------------------------- | ------------------------ | --------------------------------------------------- |
| GET    | `/v1/wishlist`             | session, `read:wishlist` | Keyset paginated, newest first.                     |
| POST   | `/v1/wishlist`             | session                  | Add. **Requires an `Idempotency-Key` header.** 201. |
| DELETE | `/v1/wishlist/:id`         | session                  | Remove. 204.                                        |
| GET    | `/v1/wishlist/:id/acquire` | session, `read:wishlist` | Purchase links. Never affiliate-tagged.             |

### Discovery and catalogue

| Method | Path                        | Auth                            | What it does                                                                |
| ------ | --------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| GET    | `/v1/feed`                  | session, `read:recommendations` | Personalised feed, paged over sections.                                     |
| GET    | `/v1/recommendations`       | session, `read:recommendations` | Recommendations for the account.                                            |
| GET    | `/v1/stations`              | session, `read:recommendations` | Derived stations.                                                           |
| GET    | `/v1/stations/:id/tracks`   | session, `read:recommendations` | Tracks for one station.                                                     |
| GET    | `/v1/search?q=`             | session                         | Catalogue search over the local crosswalk.                                  |
| GET    | `/v1/artists/:mbid`         | session                         | One artist.                                                                 |
| GET    | `/v1/artists/:mbid/similar` | session                         | Similar artists, ListenBrainz plus Last.fm.                                 |
| GET    | `/v1/artists/:mbid/events`  | session                         | Live events from SeatGeek. **501 here**: off pending Gate L, see section 4. |
| GET    | `/v1/tracks/:mbid`          | session                         | One recording.                                                              |
| GET    | `/v1/tracks/:mbid/preview`  | session                         | A 30-second preview URL.                                                    |
| GET    | `/v1/albums/:mbid`          | session                         | One release.                                                                |

Every `:mbid` is a MusicBrainz UUID and is validated before use.

### Webhooks

| Method | Path                  | Auth           | What it does                      |
| ------ | --------------------- | -------------- | --------------------------------- |
| POST   | `/v1/webhooks/workos` | HMAC signature | Handles `user.deleted` at WorkOS. |

---

## 4. Things that work right now, with real data

The catalogue is warmed for one artist and one recording, because a warmed
catalogue is the only way to prove these routes end to end. Both are real
MusicBrainz identifiers and the data came from MusicBrainz through the node.

```bash
SESSION=$(...)   # section 2
ARTIST=a74b1b7f-71a5-4011-9441-d0b5e4122711    # Radiohead
TRACK=0790ba6c-e0b1-4891-b82f-b4db9a5a927f     # Karma Police
```

**An artist.**

```bash
curl -sS "https://api-staging.pull.fm/v1/artists/$ARTIST" \
  -H "Authorization: Bearer $SESSION" | jq .
```

```json
{
  "mbid": "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  "name": "Radiohead",
  "sortName": "Radiohead",
  "country": "GB",
  "beganYear": 1991,
  "resolution": "musicbrainz",
  "attribution": [
    {
      "source": "musicbrainz",
      "text": "Metadata from MusicBrainz",
      "url": "https://musicbrainz.org"
    }
  ]
}
```

**A preview that actually plays.** The URL below was fetched and returned
`HTTP/2 200`, `content-type: audio/x-m4p`, 1,045,790 bytes of real audio.

```bash
curl -sS "https://api-staging.pull.fm/v1/tracks/$TRACK/preview" \
  -H "Authorization: Bearer $SESSION" | jq '{provider, url, cacheable, durationMs}'
```

```json
{
  "provider": "itunes",
  "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview125/...m4a",
  "cacheable": true,
  "durationMs": 264067
}
```

The response carries an `attribution.badge` block. It is not decoration: the
iTunes terms require the badge and the Apple Music link to be rendered next to
the preview, and the block tells a client exactly where and in what order.

**Live events are OFF, and this is the one place the prototype deliberately
does less than the code can.** The SeatGeek client is built and the credentials
are on the node, and for several hours on 2026-07-29 the route really did return
live data. It should not have:

```bash
curl -sS "https://api-staging.pull.fm/v1/artists/$ARTIST/events?city=Chicago&state=IL&country=US" \
  -H "Authorization: Bearer $SESSION"
# 501
# {"type":"https://pull.fm/problems/not-implemented","title":"Not Implemented",
#  "status":501,"detail":"Live events are not enabled on this deployment."}
```

`docs/PLAN.md` §3 and §11.7 both record this route as 501 pending **Gate L**,
which is a legal gate and has not passed: the DPAs are unsigned, no EU Article 27
representative is appointed, and no published EULA names the SeatGeek Entities as
third-party beneficiaries under their clause 4.3. Serving their data before those
are true is a breach of contract, not a missing feature.

It was on because the flag failed open in two places at once - `SEATGEEK_ENABLED`
defaulted to `true` in the BFF's config schema, and `infra/lib/secrets.sh` wrote
`SEATGEEK_ENABLED=true` into `bff.env` whenever a client id existed in 1Password.
Between them, a "kill switch" was something every deployment holding a credential
had already bypassed. Both now default to `false`, so the next environment starts
correct rather than inheriting the fix. Turning events on is a reviewed edit that
can cite the signed documents; turning them off stays a line in
`/etc/pullfm/bff.env` and a restart, which is the hours-not-deploy-cycles
obligation their terms actually impose.

When it is switched on, only `city`, `state`, `country` and `limit` are accepted.
Coordinates and postal codes are refused because SeatGeek's terms forbid them.

**The wishlist.** Adding requires an idempotency key:

```bash
curl -sS -X POST https://api-staging.pull.fm/v1/wishlist \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"artistName":"Radiohead","title":"Karma Police",
       "artistMbid":"'"$ARTIST"'","recordingMbid":"'"$TRACK"'","source":"manual"}'
```

### What is empty, and why that is correct

| Route                                             | Answers                                                                   | Because                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/search`                                      | `{"sections":[],...}` 200                                                 | Search reads the local **crosswalk**, which is filled from listening history. No service is connected yet.                                |
| `/v1/feed`, `/v1/recommendations`, `/v1/stations` | `{"sections":[],"degraded":true,"unavailableProviders":["listenbrainz"]}` | Same reason. Connect ListenBrainz and they populate.                                                                                      |
| `/v1/artists/<any other mbid>`                    | 404                                                                       | The request path **never calls MusicBrainz** (section 6). An unwarmed MBID is indistinguishable from one that does not exist, on purpose. |
| `/v1/connections/lastfm`                          | 501                                                                       | No Last.fm credentials on this deployment.                                                                                                |
| `/v1/artists/:mbid/events`                        | 501                                                                       | Credentials are present and the client works. `SEATGEEK_ENABLED=false` until Gate L passes. Section 4.                                    |

None of these is a bug. To make discovery interesting, connect ListenBrainz
(`POST /v1/connections/listenbrainz` with `{"token":"<your LB token>"}`) and
wait for the half-hourly warmer.

---

## 5. Deploying a change

The deploy is a **pull**. CI never touches the node; the node polls once a
minute, resolves the tag to an immutable digest, runs migrations with the new
image, and only then swaps the container.

```bash
git push origin main
# GitHub Actions builds ghcr.io/312-dev/pull-fm/bff:main
# the node notices within 60s and deploys it
curl -sS https://api-staging.pull.fm/healthz | jq -r .version   # == git rev-parse HEAD
```

Measured three times on 2026-07-29 against a ten-minute budget. "Push" is when
GitHub created the workflow run; "serving" is when the node's deploy agent
logged `healthy on <digest>`:

| Commit    | Push     | Serving  | Elapsed  | CI run total |
| --------- | -------- | -------- | -------- | ------------ |
| `c953b31` | 08:40:51 | 08:43:17 | 2 m 26 s | 2 m 39 s     |
| `8a81566` | 08:55:34 | 08:57:18 | 1 m 44 s | 1 m 57 s     |
| `2e28783` | 09:05:33 | 09:06:21 | **48 s** | 55 s         |

The spread is the registry poll, which fires every 60 seconds, plus how much of
the image layer cache the build could reuse. `uptimeSeconds` resetting is the
signal that a swap happened.

**Maintenance mode**, which needs the node:

```bash
ssh pullfm@<tailnet-ip> sudo touch /etc/pullfm/flags/maintenance
# every application route -> 503 with Retry-After: 300, within ~1 second
# /healthz and /readyz stay 200, so a crash is still distinguishable
ssh pullfm@<tailnet-ip> sudo rm /etc/pullfm/flags/maintenance
```

### Reaching the node

**Admin is over Tailscale. It is never over the public IP.** The Hetzner
firewall carries no inbound rule for port 22 at all - not an allowlisted one,
none - and the public address `204.168.129.82` therefore drops a connection to
22 rather than refusing it, so the symptom is a timeout, not "connection
refused". The only public ports are 80 and 443, and only from Cloudflare's
ranges. That posture is deliberate and must not be traded away for convenience.

The whole command, from nothing:

```bash
install -m 0600 /dev/null /tmp/pullfm-staging.key
op read 'op://MCP/krqfwafozazi7xq6ftq4s35rba/private_key' > /tmp/pullfm-staging.key
[ -s /tmp/pullfm-staging.key ] || echo 'EMPTY: wrong field or no vault access'

ssh -i /tmp/pullfm-staging.key -o IdentitiesOnly=yes \
    pullfm@100.121.161.79 'hostname; uptime'
# pullfm-staging-app-1
```

The 1Password item is `pull-fm/infra/STAGING_SSH_KEY`, and it is addressed
**by item id** above for the same reason as the API token in section 2: `op read`
cannot resolve an `op://` reference whose item title contains a slash, and every
item in this project has one. `op item get pull-fm/infra/STAGING_SSH_KEY --vault
MCP --fields label=private_key --reveal` is the equivalent by title. The public
half is not a secret and is committed as `ssh_public_keys.operator` in
`infra/terraform/envs/staging/terraform.tfvars`; cloud-init installs it into
`~pullfm/.ssh/authorized_keys`, and Hetzner holds it as the SSH key
`pullfm-staging-operator`, MD5 `f9:ac:9f:...:72:30`.

**Three ways this goes wrong, all of which look like "the key is refused":**

| What you did                      | What happens                       | Why                                                                                          |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `ssh root@...`                    | `Permission denied (publickey)`    | Root login over SSH is disabled by cloud-init. The account is `pullfm`, and it has sudo.     |
| `ssh pullfm@pullfm-staging-app-1` | `Could not resolve hostname`       | MagicDNS is not resolving from every client. Use the tailnet **address**, not the node name. |
| `ssh` with several keys loaded    | `Too many authentication failures` | The server closes the connection before reaching the right one. `-o IdentitiesOnly=yes`.     |

The tailnet address is `100.121.161.79`. `tailscale status | grep pullfm` finds
it if it ever moves.

### The scheduled jobs, which had never run until tonight

Four job timers have been committed and enabled for some time and **none had
ever fired**, because nothing had ever been deployed for them to run against.
Two fired on schedule on 2026-07-29 and both succeeded:

```
Jul 29 09:05:00.344 systemd[1]: Starting pullfm-sweep-expired.service - Delete expired idempotency records and connect states...
Jul 29 09:05:00.356 pullfm-job[53708]: [pullfm-job] sweep-expired on ghcr.io/312-dev/pull-fm/bff@sha256:97e2cdf3...
Jul 29 09:05:01.637 pullfm-job[53708]: {"ran":true,"idempotencyKeysDeleted":0,"connectStatesDeleted":0,"failed":0,"capped":false}
Jul 29 09:05:01.755 systemd[1]: Finished pullfm-sweep-expired.service.
                                 Result=success  ExecMainStatus=0

Jul 29 09:10:00.087 systemd[1]: Starting pullfm-warm-cache.service - Warm the MusicBrainz and iTunes caches...
Jul 29 09:10:00.117 pullfm-job[58353]: [pullfm-job] warm-cache on ghcr.io/312-dev/pull-fm/bff@sha256:d75f4bfa...
Jul 29 09:10:01.693 pullfm-job[58353]: {"ran":true,"musicbrainz":{"considered":0,"called":0,...},"itunes":{"considered":0,...}}
Jul 29 09:10:01.800 systemd[1]: Finished pullfm-warm-cache.service.
                                 Result=success  ExecMainStatus=0
```

Both ran against **the image digest that is serving traffic**, read from the
file the deploy agent writes, so a job can never be the first thing to run an
untested build. The warmer's zeroes are the correct answer: everything in the
candidate list was already warm, so it spent no provider budget.

The two that have not fired yet are `reap-unverified` (hourly at :35) and
`purge-audit` (daily at 06:17 UTC).

```bash
systemctl list-timers 'pullfm-*'
```

---

## 6. The MusicBrainz limit, and why nothing here breaches it

MusicBrainz allows **1 request per second per IP for the whole service**, as a
licence condition. Exceeding it revokes access permanently, so it is treated as
a hard constraint rather than a target.

Three properties hold it, and all three were checked against this node:

1. **The request path never calls MusicBrainz.** Catalogue routes read the
   cache and the crosswalk and return 404 on a miss. No amount of traffic to
   the public URL produces a single MusicBrainz request.
2. **Only the scheduled warmer calls it**, from one process, through a single
   shared pacer with a 1000 ms minimum interval, and the warmer paces itself at
   **2000 ms** on top of that: half the permitted rate. Measured on the node,
   3 calls in 8.9 seconds of wall clock, which is 0.34 req/s.
3. **There is exactly one node**, and Terraform refuses to plan a second one
   without a shared Redis, because the pacer is per process and two nodes would
   emit 2 req/s while each reported perfect compliance.

The pacer's counters are now exported, so this is observable rather than
argued:

```bash
# on the node
T=$(sudo grep -oP '(?<=^PULLFM_METRICS_TOKEN=).*' /etc/pullfm/metrics.env)
curl -sS -H "Authorization: Bearer $T" http://127.0.0.1:3000/metrics \
  | grep musicbrainz_pacer
# pullfm_musicbrainz_pacer_dispatched_total 0
# pullfm_musicbrainz_pacer_queue_depth 0
# pullfm_musicbrainz_pacer_rejected_total 0
```

`dispatched_total 0` in the API process is the point: the process serving your
requests has never called MusicBrainz.

**If you load-test this, use `load/`, and do not point anything at
`/v1/artists/*` expecting cache misses to be filled.** They will not be, and
that is the design.

---

## 7. What is deployed, exactly

| Layer        | What                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| DNS and edge | Cloudflare, proxied. `api-staging.pull.fm` and `app-staging.pull.fm`, A and AAAA. |
| Origin       | Hetzner `cpx22`, 2 vCPU / 4 GB, `hel1`, `pullfm-staging-app-1`.                   |
| Ingress      | nginx, TLS from a Cloudflare Origin CA certificate, Authenticated Origin Pulls.   |
| Application  | One container, image pinned **by digest**, never by tag.                          |
| Redis        | Two instances on the same node, `allkeys-lru` cache and `noeviction` quota.       |
| Database     | Neon branch `staging`, PG18, `aws-eu-central-1`. Not built by this environment.   |
| Timers       | deploy (60 s), watchdog (60 s), cf-ranges (daily), and four job timers.           |

**Who may reach the origin.** Verified on 2026-07-29 from `104.58.94.69`, an
address outside Cloudflare's ranges: ports 443, 80, 22, 3000 and 6379 on the
origin IP all **time out**. The same hostname through Cloudflare returns 200.

Be precise about what that buys, because the repository used to overclaim it.
The Hetzner firewall restricting 80 and 443 to Cloudflare's published ranges is
the control carrying the weight. Authenticated Origin Pulls does **not** prove
traffic came from _our_ zone: the certificate, its CA and its subject
`CN=origin-pull.cloudflare.net` are shared by every Cloudflare customer, so the
subject check excludes an unrelated client certificate and nothing more. The
control that would genuinely bind this origin to this zone is a **per-zone
custom origin-pull certificate**, which does not exist yet.

That is buildable with the credentials already in place and was deliberately
not attempted overnight, because it is a four-step change to a live ingress
where the wrong ordering 403s every request until someone notices. Probed
2026-07-29, the staging Cloudflare token **can** write
`/zones/<zone>/origin_tls_client_auth` and `.../hostnames`, and **cannot** touch
`rulesets` or `rate_limits`, so a WAF or edge rate-limit ruleset needs a wider
token than any this project holds. The work is: mint a private CA and a client
certificate, upload the certificate to Cloudflare, enable per-hostname
authenticated origin pulls for `api-staging.pull.fm`, and only then repoint
nginx's `ssl_client_certificate` at our CA and tighten the subject check. Do
the nginx half last and keep a break-glass path open while doing it.

`/metrics` is denied at nginx and 404s from the internet. The application also
refuses any caller that is not loopback and holds no `METRICS_TOKEN`.

---

## 8. What it costs

Read from the Hetzner API against the live resources, not estimated.

| Item                            | Per month     |
| ------------------------------- | ------------- |
| `cpx22` in `hel1`               | **USD 22.99** |
| One primary IPv4                | **USD 0.60**  |
| Primary IPv6                    | 0.00          |
| Load balancer, volumes, backups | none created  |
| **Total**                       | **USD 23.59** |

That is **USD 0.0323 per hour**, USD 0.78 per day. Neon's staging branch and
the two Cloudflare R2 buckets are free at this size, and Cloudflare DNS and
proxying are on the free plan.

**The currency is dollars.** Hetzner's `/v1/pricing` reports `currency: USD`
and `vat_rate: 0` for this account, so every "EUR" figure written in this
repository before 2026-07-29 is a dollar figure wearing the wrong symbol.

**It is roughly twice what was planned**, and the reason is stock rather than a
change of mind. On 2026-07-29 the 4 GB types this environment was sized for
could not be ordered in the EU at all: `cax11` and `cx23` were available in no
location, and `cpx21` only in Ashburn and Hillsboro. Putting the node in the
United States was not an option while the database is a Neon branch in
`eu-central-1`. `cpx22` was the only in-stock 4 GB EU type. Revisit when stock
returns; it is a one-line change in `terraform.tfvars` and a rebuild.

```bash
./infra/staging-env.sh cost      # current run rate
./infra/staging-env.sh status    # what is running
./infra/staging-env.sh down      # destroy compute, keep the backup bucket
./infra/staging-env.sh up        # rebuild it, unattended
```

`down` destroys the server, the network, the firewalls and the four DNS
records, and takes the run rate to zero. It does not touch Neon, and it does not
touch the R2 buckets.

---

## 9. Known gaps in what you are looking at

Listed because a prototype that hides its edges is worse than one that names
them.

- **`/v1/search` and the feed are empty** until a music service is connected.
  Section 4 explains why, and it is the design rather than a defect.
- **Session access tokens last five minutes.** Use the API token for anything
  interactive.
- **No external uptime check exists.** The watchdog runs _on_ the node, so a
  dead node alerts nobody. This is named in `infra/observability/README.md` as
  a gap that cannot be closed from the node.
- **No Cloudflare WAF or rate-limiting ruleset**, and no per-zone origin-pull
  certificate. Section 7.
- **A rollback has never been executed.** The procedure is written in
  `RUNBOOK-DEPLOY.md` section 5 and remains untested, which is the open half of
  Gate D.
- **Two account rows exist for `gray@grayada.ms`**, one from a sign-in made
  while the WorkOS client id was misconfigured. The live one is
  `0ede7b7f-9c92-4914-8182-4509aae1656b`; the other has no tokens and no data.
- ~~`pullfm-watchdog.service` carries `RuntimeMaxSec=` with `Type=oneshot`~~
  **Fixed 2026-07-29**: it is `TimeoutStartSec=50` now. It mattered more here
  than on the job units, because systemd will not start a second copy of a
  oneshot that is still activating: a watchdog wedged on a hung `/metrics` read
  did not miss one minute, it suppressed every later run indefinitely while
  `systemctl list-timers` still showed the timer armed. Not exercised against a
  wedged scrape; the correctness claim is that systemd no longer discards the
  directive.
- ~~The cache node's server resource does not ignore `user_data`~~ **Fixed
  2026-07-29**, and it is the sharper half of the same defect: that node is built
  with no public IPv4 and a firewall that opens nothing inbound but Tailscale, so
  a keyless apply would have left it unreachable by every path rather than merely
  degraded. **Untested by construction** - `enable_cache_node` is false, so the
  resource has `count = 0` and no server exists to apply it against.
- **`infra/scripts/check-job-schedule.mjs` was asserting the broken form of the
  job units** (`OnFailure` in `[Service]`, `RuntimeMaxSec` on a oneshot), so it
  passed for as long as the units were wrong and went red the moment they were
  fixed. Corrected 2026-07-29; `make jobs` and the CI step pass again. Worth
  noting as a class of gap: a guard written against the bug is worse than no
  guard, because it reports green.

---

## 10. If it is not answering

| Symptom                                    | Look at                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `521` or `525` from Cloudflare             | The origin, not the edge. nginx down, container down, or the origin certificate.         |
| `/healthz` 200, `/readyz` 503              | The named check tells you which: `database` is Neon, `redis` is on the node.             |
| `version` not advancing                    | `journalctl -u pullfm-deploy` on the node. A failed migration stops a deploy on purpose. |
| Every route 503, `/healthz` 200            | Maintenance mode. `rm /etc/pullfm/flags/maintenance`.                                    |
| 403 with "requires an interactive session" | You used a token on a session-only route. Section 2.                                     |
| 401 on a session that just worked          | It expired. They last five minutes.                                                      |

```bash
ssh pullfm@<tailnet-ip>
sudo docker ps
sudo journalctl -u pullfm-deploy -n 50
sudo journalctl -u pullfm-watchdog -n 20
systemctl list-timers 'pullfm-*'
```

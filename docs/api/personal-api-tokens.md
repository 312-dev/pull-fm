# Personal API tokens

A user can fetch **their own** data from a script, with a credential they create and destroy
themselves. That is the whole feature, and every decision below follows from taking "their own"
literally.

## Using one

```bash
# 1. Create it. An interactive session is required.
curl -sS -X POST https://api.pull.fm/v1/tokens \
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"laptop script","scopes":["read:me","read:recommendations"],"expiresInDays":90}'
```

```jsonc
// 201 Created
{
  "token": "pfm_live_kQ3n8xF2sVb7YtR1pLmA9dGhJ0zW4cE6uN5oI2sK8yQ",
  "warning": "Copy this now. Only a SHA-256 digest of it is stored, so it cannot be shown again...",
  "tokenRecord": {
    "id": "0f2a...",
    "name": "laptop script",
    "tokenPrefix": "pfm_live",
    "lastFour": "8yQ",
    "scopes": ["read:me", "read:recommendations"],
    "rateLimitPerMinute": 60,
    "expiresAt": "2026-10-26T00:00:00.000Z",
  },
}
```

```bash
# 2. Use it, exactly like any bearer credential.
curl -sS https://api.pull.fm/v1/recommendations \
  -H "Authorization: Bearer pfm_live_kQ3n8xF2sVb7YtR1pLmA9dGhJ0zW4cE6uN5oI2sK8yQ"

# 3. List what exists. Metadata only; the secret is not stored and cannot be listed.
curl -sS https://api.pull.fm/v1/tokens -H "Authorization: Bearer $PULLFM_SESSION_TOKEN"

# 4. Rotate. Old secret dies, new one is issued, in one transaction.
curl -sS -X POST https://api.pull.fm/v1/tokens/$TOKEN_ID/rotate \
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN"

# 5. Revoke. Effective on the next request.
curl -sS -X DELETE https://api.pull.fm/v1/tokens/$TOKEN_ID \
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN"
```

## Format

```
pfm_live_<43 characters of base64url>     production
pfm_test_<43 characters of base64url>     staging and local
```

32 bytes from `randomBytes`, base64url encoded. Not a UUID: a v4 UUID is 122 bits with a
recognisable layout, and there is no reason to accept less than 256 bits when the cost is identical.

**The prefix is the point.** A fixed, distinctive shape is what makes a leaked token findable:
gitleaks, GitHub push protection, and a grep over a support transcript all key on shape. A bare
random string is indistinguishable from a hash and gets missed. The environment is in the prefix, so
a token pasted into an issue is immediately identifiable as production or not.

The **prefix follows the data environment, not `NODE_ENV`**: staging runs `NODE_ENV=production` (see
`docs/PLAN.md` section 1b) and still issues `pfm_test`, because what the prefix has to communicate is
"whose data does this reach".

## Storage

Only `sha256(token)`, as lowercase hex, with a `UNIQUE` constraint and a `CHECK` that the column
matches `^[0-9a-f]{64}$`. The token itself is never written anywhere: not the database, not a log,
not the audit trail, not an error message. Plus two non-secret display fields, `token_prefix` and
`last_four`, so a token can be identified in a list without being disclosed.

### Why SHA-256 and not bcrypt or argon2

The question a reviewer will ask, answered once so it is not re-litigated.

A password is low-entropy and chosen by a human, so it must be expensive to guess. This token is 256
bits from a CSPRNG: there is no dictionary, no reuse across sites, and no offline attack a work
factor would meaningfully slow. What a slow KDF **would** do is force a table scan on every
authenticated request, because a per-row salted hash cannot be indexed. That is a latency problem and
a denial-of-service problem, bought with no security gain.

The defence against offline brute force here is entropy, not work factor, and 256 bits is not
brute-forced.

The comparison is still done with `timingSafeEqual` even though the lookup is an index probe on the
digest. The probe already reveals nothing through timing; the constant-time comparison is there so a
future change to the lookup strategy cannot quietly introduce an oracle.

## What a token cannot do

A personal token is refused, with 403, on every route that requires a session:

| Refused                                                   | Why                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /v1/tokens`, `DELETE /v1/tokens/{id}`, `.../rotate` | A token that can mint a token is a persistence mechanism, not a credential |
| `GET /v1/tokens`                                          | Enumerating the account's credentials is session-level authority           |
| `DELETE /v1/me`                                           | A leaked read-only credential must not be able to destroy what it can read |
| `GET /v1/me/export`                                       | A full personal-data export is session-level authority                     |
| `POST`/`DELETE /v1/connections/...`                       | The connect flow touches the credential vault                              |
| `POST /v1/wishlist`, `DELETE /v1/wishlist/{id}`           | Read-only means read-only                                                  |
| `POST /v1/auth/logout`                                    | A token is not a session and has nothing to revoke                         |

The asymmetry matters most in the first row. If a read-only token could create another token, then
revoking a leaked one would accomplish nothing: the attacker mints a second one the moment they get
the first.

## Scopes

Read-only to start. The set is `CHECK`-constrained in the schema, so widening it is a migration and
therefore a review.

| Scope                  | Grants                                                    |
| ---------------------- | --------------------------------------------------------- |
| `read:me`              | `GET /v1/me`                                              |
| `read:wishlist`        | `GET /v1/wishlist`, `GET /v1/wishlist/{id}/acquire`       |
| `read:recommendations` | `GET /v1/feed`, `/v1/recommendations`, `/v1/stations`     |
| `read:connections`     | `GET /v1/connections` (metadata only, never a credential) |

## Lifecycle

- **Expiry is mandatory.** Default 90 days, maximum 365. A personal access token with no expiry is a
  credential that outlives the reason it was created.
- **`last_used_at`** is recorded at most once per minute per token. It is genuinely useful ("is this
  still in use before I revoke it?"), but an `UPDATE` on every authenticated request turns a
  read-only API into a write-amplified one and puts a row lock on the hot path.
- **Rotation** revokes the old row and inserts a new one in a single transaction, so there is never
  a moment when both secrets work or neither does. The new row records `rotated_from_id`, so a
  rotation chain is reconstructable during an incident.
- **Revocation** is a predicate in the same statement as the digest lookup, not a check on the
  returned row, so it takes effect on the very next request with no cache to invalidate.
- **A cap of 10 live tokens per account**, enforced under a row lock so two concurrent creates cannot
  both squeeze past the limit.

## Rate limiting

Each token carries `rate_limit_per_minute`, counted in the **quota Redis** (`REDIS_QUOTA_URL`), which
is a separate instance running `noeviction`.

That separation is a security control, not a deployment detail. Eviction policy in Redis is per
instance, not per database. On the `allkeys-lru` cache instance a cache-fill event would evict the
counters, and every rate limit would fail **open** with no error and no alert while the abuse
protections were simply gone. `THREAT-MODEL.md` T11 rates that the highest-likelihood
misconfiguration in the system, precisely because the setting is deliberate and correct for its other
job.

So the limiter **fails closed**: if the quota store cannot be reached, the request is refused with
503 rather than allowed through uncounted.

Unknown, expired, and revoked tokens all produce the identical 401 body. A differential response
would tell an attacker which of their guesses were once real.

## The secret-scanning rule to add

`.gitleaks.toml` is owned by another work stream, so this is a request rather than an edit. The rule
to add:

```toml
[[rules]]
id = "pullfm-personal-api-token"
description = "Pull.fm personal API token (pfm_live_ / pfm_test_)"
regex = '''\bpfm_(?:live|test)_[A-Za-z0-9_-]{43}\b'''
keywords = ["pfm_live_", "pfm_test_"]
tags = ["pullfm", "per-user-token"]
```

Notes for whoever applies it:

- The `{43}` length is exact, not a minimum: the secret is always 32 bytes base64url-encoded and
  unpadded. An exact length makes the rule specific enough that it does not need an entropy check
  and will not fire on unrelated `pfm_`-prefixed identifiers.
- `\b` on both ends prevents a match inside a longer token-like string.
- No new allowlist entry is needed. The existing path allowlist in `.gitleaks.toml` already covers
  `docs/*.md`, `security/testdata/`, and `*.example`, which is where every documented and test-only
  token in this repository lives. Please do **not** widen it further for this rule: exempting a
  directory is how a real leak in a source file eventually gets ignored.
- Verified locally against the working tree: with this rule added, the only match is the example in
  this document, which the existing `docs/*.md` path allowlist already covers.

A matching Semgrep rule is not required: `.semgrep/pullfm.yml` already fails CI on any
credential-shaped literal reaching a logger, and the token never reaches one because it is never
assigned to a request, a reply, or a log field.

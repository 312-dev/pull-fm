# Pull.fm API

The OpenAPI 3.1 document is the source of truth. It is **generated from the Fastify route
schemas**, not hand-maintained, so a route cannot exist without appearing in it and cannot appear in
it without existing. Both directions are asserted by
`apps/bff/test/integration/openapi.test.ts`.

| Artifact          | Where                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Reference browser | `GET /docs` (self-hosted Scalar, no CDN)                          |
| Raw document      | `GET /openapi.json`                                               |
| Emit to a file    | `pnpm --filter @pull-fm/bff --silent openapi:emit > openapi.json` |

> `--silent` matters. Without it pnpm prints its own banner to stdout and the resulting file is not
> valid JSON, which the security tooling reports as "not an OpenAPI 3.x document".

## Documents in this directory

| File                                                 | Subject                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [`personal-api-tokens.md`](personal-api-tokens.md)   | The token design, its security properties, and how to use one               |
| [`data-portability.md`](data-portability.md)         | What the API will and will not serve, and the upstream terms behind that    |
| [`deletion-and-backups.md`](deletion-and-backups.md) | The `DELETE /v1/me` cascade and the documented position on backup retention |

## Authenticating, briefly

Two credential types, deliberately not interchangeable.

**Session** - a WorkOS AuthKit access token (a JWT). Full account authority, including the
irreversible operations. Obtained from `GET /v1/auth/callback` after an interactive sign-in.
There are no passwords and there never will be: `docs/PLAN.md` section 4 explains why issuing none
is what keeps the migration path off WorkOS open.

**Personal API token** - a `pfm_live_...` string the user creates themselves. Read-only, scoped,
rate limited per token, shown exactly once. See
[`personal-api-tokens.md`](personal-api-tokens.md).

```bash
# Create a token (an interactive session is required; a token cannot create a token)
curl -sS -X POST https://api.pull.fm/v1/tokens \
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"laptop script","scopes":["read:me","read:recommendations"]}'

# Use it
curl -sS https://api.pull.fm/v1/recommendations \
  -H "Authorization: Bearer pfm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## Conventions

| Concern             | Rule                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors              | RFC 9457 `application/problem+json`, always. `instance` is the request id, which is also in `X-Request-Id`.                                                                               |
| Not found vs denied | An object belonging to another account returns **404, not 403**, so identifiers cannot be enumerated by observing which ones exist.                                                       |
| Pagination          | Opaque keyset cursors. A cursor is bound to the subject it was issued to; replaying another subject's cursor is a 400.                                                                    |
| Mutations           | `Idempotency-Key` is required. A retry returns the ORIGINAL response; the same key with a different body is a 409.                                                                        |
| Rate limits         | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on token-authenticated responses; `Retry-After` on a 429.                                                                     |
| Product surface     | `/v1/feed`, `/v1/recommendations`, `/v1/stations` return the stable `sections` envelope. They currently answer **501**: the contract is fixed, the ranking implementation is not written. |

## Machine-readable annotations

Every operation in the document carries annotations the security tooling reads. They exist because
guessing is worse than declaring: `DELETE /v1/me` has no path parameter and is the most destructive
route in the system, while `GET /v1/artists/{mbid}` has one and is owned by nobody.

| Annotation                 | Consumer                                 | Meaning                                                                    |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `x-pullfm-authz`           | `security/bola/route-matrix.mjs`         | `public`, `authenticated-shared`, `user-scoped`, `system`, `webhook`       |
| `x-pullfm-bola`            | the BOLA suite                           | How a foreign object identity is substituted, and what denial is expected  |
| `x-pullfm-dast`            | `security/zap/scripts/prune-openapi.mjs` | Whether the active scan may drive this operation                           |
| `x-pullfm-token-scope`     | documentation                            | Which personal-token scope the route requires                              |
| `x-pullfm-not-implemented` | the BOLA suite                           | Declares a route as deliberately 501, so a broken route is still a failure |

Emission **fails** if any operation lacks a classification. That is `docs/PLAN.md` Gate 3's
"failing CI if any route lacks a test" clause, raised at spec generation so the error can name the
Fastify route rather than an anonymous path in a generated file.

## Running the security pipeline locally

```bash
docker compose -f docker-compose.dev.yml up -d

# 1. Emit the document from the live router.
pnpm --filter @pull-fm/bff --silent openapi:emit > /tmp/openapi.json

# 2. Enumerate. Fails here if any operation is unclassified.
node security/bola/route-matrix.mjs /tmp/openapi.json --out /tmp/route-matrix.json --summary

# 3. Run everything, including the BOLA suite, which does 1 and 2 for itself.
pnpm --filter @pull-fm/bff test
```

The BOLA suite runs as part of `pnpm test` rather than as a separate CI step, so a new user-scoped
route without a test is a red build without anyone having to remember to wire it up.

## Deviations from the fixture spec, recorded

`security/testdata/openapi/pullfm-v1.example.json` is a fixture written before the BFF existed, so
the tooling could be developed against something. The real document differs in two places, both
deliberate:

1. **The connection routes are `implicit-subject`, not `path-param`.** `:service` is a two-value
   enum identical for every user, so substituting "subject A's service" for "subject B's" substitutes
   nothing and the resulting test could never fail. `security/BOLA-TESTING.md` says as much in its
   own text. The connection is resolved from the session and there is no connection id anywhere in
   the API, so the meaningful assertion is that subject B's response contains no trace of A.

2. **`GET /v1/me/export` returns a ticket rather than the document,** and a second route,
   `GET /v1/me/export/download`, serves it. That is THREAT-MODEL M17: a full personal-data document
   returned synchronously on a GET is both a self-service denial of service and the most sensitive
   response body in the system sitting on the route most likely to be cached by something in the
   path.

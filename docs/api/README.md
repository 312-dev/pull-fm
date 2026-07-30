# Pull.fm API

Written for someone building a client. It covers what you send, what you get back, and the rules
that apply to every route. It does not describe how the service is built internally, and it is not
the place to look for that.

The OpenAPI 3.1 document is the source of truth. It is **generated from the Fastify route schemas**,
not hand-maintained, so a route cannot exist without appearing in it and cannot appear in it without
existing. Both directions are asserted by `apps/bff/test/integration/openapi.test.ts`.

| Artifact          | Where                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Reference browser | `GET /docs` (self-hosted, no CDN)                                 |
| Raw document      | `GET /openapi.json`                                               |
| Emit to a file    | `pnpm --filter @pull-fm/bff --silent openapi:emit > openapi.json` |

> `--silent` matters. Without it pnpm prints its own banner to stdout and the resulting file is not
> valid JSON, which the security tooling reports as "not an OpenAPI 3.x document".

## Documents in this directory

| File                                                 | Subject                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [`legal-agreements.md`](legal-agreements.md)         | Fetching the Terms and Privacy Policy, verifying them, and recording assent |
| [`personal-api-tokens.md`](personal-api-tokens.md)   | The token design, its security properties, and how to use one               |
| [`data-portability.md`](data-portability.md)         | What the API will and will not serve, and the upstream terms behind that    |
| [`deletion-and-backups.md`](deletion-and-backups.md) | The `DELETE /v1/me` cascade and the documented position on backup retention |

## Public and internal operations

Some operations exist so that Pull.fm can integrate with the systems it runs on, not so that a
client can call them. They are marked `INTERNAL` in their summary and carry the `internal` tag, and
a client should treat them as absent: they are not part of the contract, they are not versioned for
consumers, and they may change or disappear without notice. Everything in this document describes
the public surface only.

Marking an operation internal is a **documentation** boundary. It is deliberately not
`schema: { hide: true }`, which would also remove the route from the authorization test suite. See
"Why internal routes are tagged, not hidden" below.

## Authenticating

Two credential types, deliberately not interchangeable.

**Session.** Full account authority, including the irreversible operations. Sign-in is a **magic
link**, in two steps, and there are no passwords:

```bash
# 1. Ask for a code. Always a 202, whether or not the address has an account.
curl -sS -X POST https://api.pull.fm/v1/auth/start \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# 2. Exchange the emailed code for a session.
curl -sS -X POST https://api.pull.fm/v1/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","code":"123456","transport":"bearer"}'
```

Choose the transport that fits your client:

| `transport` | What you get back                                                    | Use it for                                                   |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `bearer`    | `accessToken` and `refreshToken` in the response body                | A client with its own credential store                       |
| `cookie`    | An HttpOnly, `SameSite=Strict` cookie. **No credential in the body** | A browser, where a readable refresh token is XSS-to-takeover |

Refresh with `POST /v1/auth/refresh`: send `refreshToken` in the body for a bearer session, or send
no body at all plus the session cookie and the `X-Pullfm-Session` header for a cookie session. Sign
out with `POST /v1/auth/logout`, which revokes the session rather than asking you to forget it.

A rejected code returns the same `401` with the same body whatever was wrong with it, and
`/v1/auth/start` returns the same `202` whether or not the address has an account. Do not build
logic that tries to tell those cases apart; there is nothing there to read.

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

| Concern             | Rule                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors              | RFC 9457 `application/problem+json`, always. `instance` is the request id, which is also in `X-Request-Id`.                                                                                                                           |
| Not found vs denied | An object belonging to another account returns **404, not 403**, so identifiers cannot be enumerated by observing which ones exist.                                                                                                   |
| Pagination          | Opaque keyset cursors. A cursor is bound to the subject it was issued to; replaying another subject's cursor is a 400.                                                                                                                |
| Mutations           | `Idempotency-Key` is required. A retry returns the ORIGINAL response; the same key with a different body is a 409.                                                                                                                    |
| Rate limits         | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on token-authenticated responses; `Retry-After` on a 429. Read the headers rather than hard-coding a number.                                                              |
| Legal agreements    | Almost every route is refused with `403` and `type: .../consent-required` until the account has accepted the current Terms and Privacy Policy. Implement the flow before anything else: [`legal-agreements.md`](legal-agreements.md). |
| Caching             | `private, no-store` everywhere except the published legal documents, which are public and carry the content digest as their `ETag`.                                                                                                   |
| Product surface     | `/v1/feed`, `/v1/recommendations`, `/v1/stations` return the stable `sections` envelope. They currently answer **501**: the contract is fixed, the ranking implementation is not written.                                             |

Provider availability is visible on `GET /v1/config`, coarsely: `ok`, `degraded`, or `disabled`.
Render from that rather than inferring health from a failed request.

## Machine-readable annotations

Every operation in the document carries annotations the repository's own security tooling reads.
They are build-time metadata for this project, not part of the client contract, but they are
described here because they are visible in the document you fetch.

| Annotation                 | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `x-pullfm-authz`           | `public`, `authenticated-shared`, `user-scoped`, `system`, `webhook`       |
| `x-pullfm-bola`            | How a foreign object identity is substituted, and what denial is expected  |
| `x-pullfm-dast`            | Whether the active scan may drive this operation                           |
| `x-pullfm-token-scope`     | Which personal-token scope the route requires                              |
| `x-pullfm-not-implemented` | Declares a route as deliberately 501, so a broken route is still a failure |

Emission **fails** if any operation lacks a classification. That is `docs/PLAN.md` Gate 3's
"failing CI if any route lacks a test" clause, raised at spec generation so the error can name the
Fastify route rather than an anonymous path in a generated file.

### Why internal routes are tagged, not hidden

`schema: { hide: true }` removes a route from the OpenAPI document, and because the annotation
collector, the annotation validator, the route matrix, and the BOLA suite all read that document, it
removes the route from every one of them, with no error raised anywhere. A route hidden that way
gets zero authorization tests and a green build.

So an operation that should not be advertised to clients is tagged `internal` and given a summary
that says so. It stays in the document, stays in the route matrix, and keeps whatever authorization
coverage its classification requires. `hide` is reserved for routes that genuinely cannot describe
themselves, and each one has to be named in `HIDDEN_ROUTE_ALLOWLIST` in
`apps/bff/test/integration/openapi.test.ts` with a written reason, or the build fails.

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

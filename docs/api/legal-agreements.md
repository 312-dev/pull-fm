# Legal agreements

Pull.fm requires every account holder to accept the Terms of Service and the Privacy Policy, and
records each acceptance against the exact text that was accepted. This document is the whole
sequence a client implements: read what is required, fetch the text, verify it, display it, and
record assent.

Four endpoints are involved. Two are public and serve documents; two are about one account.

| Endpoint                                        | Credential       | Purpose                                      |
| ----------------------------------------------- | ---------------- | -------------------------------------------- |
| `GET /v1/legal`                                 | none             | What is published, and how to verify it      |
| `GET /v1/legal/{documentId}/versions/{version}` | none             | The exact bytes of one version. Immutable    |
| `GET /v1/legal/{documentId}`                    | none             | Whatever version is current. Moves           |
| `GET /v1/me/consent`                            | session or token | What this account owes, and what it accepted |
| `POST /v1/me/consent`                           | session only     | Record an acceptance                         |

## The one rule everything else follows from

**An acceptance names a digest, and the digest must match.** `POST /v1/me/consent` requires the
client to echo the `version` **and** the `contentSha256` of the text it displayed, and refuses with
`409` if either disagrees with what Pull.fm published. That is deliberate: without it a client
shipping a stale bundled copy of the Terms would have its acceptances recorded against text the user
never saw, which produces records that are confidently wrong rather than merely missing.

The practical consequence for you: **do not hash anything you did not fetch from the API,** and do
not transform what you fetched before hashing it.

## Verifying a document

The document endpoints serve `text/markdown; charset=utf-8`, and the bytes are served **already
normalised**. So:

```
sha256(response body, exactly as received) == contentSha256
```

No preprocessing. No line-ending fixes, no trimming, no re-encoding. If you compute the digest over
the raw response bytes and it does not match, the copy you hold is not the copy Pull.fm published
and **you must not ask the user to accept it**.

The digest is defined over a normalised form, and the definition matters only if you obtained a copy
some other way (from a repository, an email, a support ticket). It is: `CR` and `CRLF` folded to
`LF`, spaces and tabs stripped from the end of every line, and trailing newlines collapsed to
exactly one. Because that normalisation is idempotent, applying it to what the API served changes
nothing, so a client that implements it defensively still gets the right answer.

Markdown is the **only** canonical representation and there is no rendered form. Render locally, from
bytes you have already verified. A rendered document has different bytes, so it hashes to something
else, so an acceptance recorded against it would be refused forever.

## The sequence

```bash
# 1. Before there is an account: what does Pull.fm publish?
#    Public, so a person can read the Terms before agreeing to have an account at all.
curl -sS https://api.pull.fm/v1/legal
```

```jsonc
// 200 OK
{
  "canonicalMediaType": "text/markdown; charset=utf-8",
  "digest": {
    "algorithm": "sha256",
    "encoding": "hex",
    "normalization": "The bytes served at each url are ALREADY normalised, so sha256 over the response body exactly as received equals contentSha256 ...",
  },
  "documents": [
    {
      "documentId": "terms-of-service",
      "version": "DRAFT-0",
      "consentEpoch": 1,
      "contentSha256": "cead3bec4b7fa6a8b2044cb83d50a00699f51935b3eda90c6aeccf8d02f0abeb",
      "url": "https://api.pull.fm/v1/legal/terms-of-service/versions/DRAFT-0",
      "effectiveAt": null,
      "publishedAt": "2026-07-29T00:00:00.000Z",
    },
    // ... privacy-policy
  ],
}
```

```bash
# 2. After sign-in: what does THIS account still owe? Same document shape, plus
#    this account's standing on each and its full acceptance history.
curl -sS https://api.pull.fm/v1/me/consent -H "Authorization: Bearer $PULLFM_SESSION_TOKEN"
```

```jsonc
// 200 OK
{
  "satisfied": false,
  "reason": "never-accepted",
  "documents": [
    {
      "documentId": "terms-of-service",
      "version": "DRAFT-0",
      "contentSha256": "cead3bec...",
      "url": "https://api.pull.fm/v1/legal/terms-of-service/versions/DRAFT-0",
      "outstanding": true,
      "accepted": null,
    },
  ],
  "history": [],
}
```

```bash
# 3. Fetch each outstanding document and verify it. The url names a VERSION, so
#    the bytes behind it cannot change under you.
curl -sS https://api.pull.fm/v1/legal/terms-of-service/versions/DRAFT-0 -o terms.md
shasum -a 256 terms.md   # must equal contentSha256, byte for byte
```

```bash
# 4. DISPLAY IT and require an affirmative act that says what it means.
#    No server can do this step and it is the step that decides whether an
#    agreement was formed at all. A pre-ticked box or a "by continuing you agree"
#    footer is not an affirmative act.
```

```bash
# 5. Record it. Echo the version and the digest you computed in step 3, for each
#    document. Session only: a personal API token cannot accept on someone's behalf.
curl -sS -X POST https://api.pull.fm/v1/me/consent \
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "accept": [
          {"documentId":"terms-of-service","version":"DRAFT-0","contentSha256":"cead3bec..."},
          {"documentId":"privacy-policy","version":"DRAFT-0","contentSha256":"32a9f747..."}
        ],
        "client": {"build":"1.4.2","platform":"android"}
      }'
```

```jsonc
// 200 OK
{
  "satisfied": true,
  "reason": null,
  "recorded": [
    {
      "documentId": "terms-of-service",
      "version": "DRAFT-0",
      "acceptedAt": "...",
      "gate": "first-launch",
    },
  ],
  "outstanding": [],
}
```

Retrying step 5 is safe and records nothing new. An empty `recorded` with `satisfied: true` means
the versions were already accepted, which is the idempotent case, not a failure.

## What each refusal means

| Status | Where                 | Meaning                                                                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `409`  | `POST /v1/me/consent` | The version or the digest does not match what is published. Go back to step 2 and start again.           |
| `422`  | `POST /v1/me/consent` | Unknown `documentId`. Not retryable; your build is asking about a document Pull.fm does not publish.     |
| `422`  | `GET /v1/legal/...`   | No such document, or no such version of it. `GET /v1/legal` lists every current document.                |
| `503`  | `GET /v1/legal/...`   | The version exists and this deployment cannot serve its text. A fault on our side; the record is intact. |
| `403`  | anywhere else         | `type` is `.../consent-required`. See below.                                                             |

An unknown document is `422` rather than `404` because the complete set is published, unauthenticated,
at `GET /v1/legal`. Elsewhere in this API a `404` means "no such object, or an object belonging to
another account, deliberately indistinguishable", a rule that exists so identifiers cannot be
enumerated. There is nothing here to enumerate.

## Being refused for consent

Any gated call made by an account that owes acceptance returns `403` with
`type: https://pull.fm/problems/consent-required` and a `consent` extension member carrying
everything needed to render the screen, so a cold-started client learns what to display from the
refusal itself:

```jsonc
{
  "type": "https://pull.fm/problems/consent-required",
  "status": 403,
  "consent": {
    "reason": "never-accepted",
    "outstanding": [
      {
        "documentId": "terms-of-service",
        "version": "DRAFT-0",
        "contentSha256": "cead3bec...",
        "url": "...",
      },
    ],
  },
}
```

Two reasons, and they are not interchangeable:

| `reason`           | What happened                                                        | What still works                         |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------- |
| `never-accepted`   | Nothing has ever been accepted for this account                      | Almost nothing. See the exemptions below |
| `revision-pending` | An earlier version was accepted and one has since changed materially | **Reads continue. Writes are refused**   |

`403`, never `401`: the credential is valid and refreshing it changes nothing. A client that
treats this as an authentication failure will loop through sign-in forever.

**Always reachable, whatever is outstanding:** reading your own account (`GET /v1/me`), signing out,
requesting and downloading a data export, deleting the account, and the two consent endpoints.
Export and deletion are statutory rights and are not conditioned on agreeing to anything; deletion is
also the honest exit for someone who has read the Terms and declined them.

## Versions, epochs, and when a user is asked again

Three values travel with every document and they answer three different questions.

| Field           | Question                              | Changes when                                  |
| --------------- | ------------------------------------- | --------------------------------------------- |
| `version`       | Which publication is this?            | Any change at all, including a corrected typo |
| `contentSha256` | Did the bytes change?                 | Any change at all                             |
| `consentEpoch`  | Does an older acceptance still count? | **Only a material change**                    |

Only `consentEpoch` is enforced. A corrected typo publishes a new `version` and a new
`contentSha256` at the **same** epoch, and nobody is asked to accept again. A change to what a user
is agreeing to raises the epoch, and everybody is.

So: **compare epochs, not versions.** A client that re-prompts whenever `version` changes will show
a consent screen for a fixed comma. `GET /v1/me/consent` already does this comparison for you and
reports `outstanding` per document; use that rather than deriving it.

`effectiveAt` is for display. It is never enforced, and `null` means published but not yet
effective.

## Historical versions

**Every version ever published stays retrievable at its versioned URL, including superseded ones.**
That is a deliberate guarantee rather than a side effect. A recorded acceptance names a version and a
digest; if the text of that version could not be produced afterwards, the record would assert that
somebody agreed to something nobody can show, and a digest with no retrievable text reads like proof
while being unfalsifiable.

Two consequences worth building on:

- The `accepted` object in `GET /v1/me/consent` names the version a user actually accepted, which is
  not always the current one. `GET /v1/legal/{documentId}/versions/{that version}` shows them exactly
  what they agreed to, which is a better answer than showing them today's text.
- A versioned URL is immutable, so it is cacheable indefinitely.

## Caching

| Endpoint                                        | Policy                                | Why                                                          |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `GET /v1/legal/{documentId}/versions/{version}` | `public, max-age=31536000, immutable` | The bytes behind a version cannot change. Cache them forever |
| `GET /v1/legal/{documentId}`                    | `public, no-cache`                    | A moving pointer. Store it, but revalidate before reuse      |
| `GET /v1/legal`                                 | `public, no-cache`                    | Same                                                         |

Every one of these carries an `ETag`, and on the document endpoints **the ETag is the content
digest** in quotes. Conditional requests are supported: send it back as `If-None-Match` and a
matching request is answered `304` with no body. Weak (`W/"..."`) and list-valued `If-None-Match`
values are accepted.

The current-document response also carries `Content-Location` naming the versioned URL of exactly
what was served, so a client that followed the moving pointer can pin the answer without a second
lookup.

These are the only endpoints in the API that are publicly cacheable; everything else is
`private, no-store`. Nothing here is scoped to a person.

## URLs

`url` is absolute and points at `https://api.pull.fm`. It is the **citable** location, and it is the
value written into Pull.fm's own record of the publication, which is why it does not vary by
environment.

If you are already talking to a particular deployment, build the path against that origin rather than
following `url` verbatim. Both paths are fully determined by values you already hold:

```
/v1/legal/{documentId}/versions/{version}
/v1/legal/{documentId}
```

## Which credential can do what

| Action              | Session | Personal API token                |
| ------------------- | ------- | --------------------------------- |
| Read the documents  | yes     | yes (no credential needed at all) |
| Read consent status | yes     | yes, with `read:me`               |
| **Accept**          | yes     | **no**                            |

A personal API token can read the status and cannot record an acceptance. That is not the usual
"tokens are read-only" rule: a token is a long-lived script credential whose holder nobody can see,
and a script accepting a contract on a person's behalf would record evidence of an agreement that no
human made. A token that hits `403` on a gated route should read `GET /v1/me/consent` and report that
a person must accept in the app.

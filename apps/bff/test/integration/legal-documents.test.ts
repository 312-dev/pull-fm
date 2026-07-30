/**
 * Serving the legal documents, end to end.
 *
 * WHAT IS BEING PROVED, AND WHY IT IS NOT A CONTENT-TYPE TEST
 *
 * `POST /v1/me/consent` refuses an acceptance whose content digest does not match
 * the digest published for that version. So "the endpoint returns the document"
 * is not the property that matters. The property that matters is:
 *
 *     sha256(exactly the bytes we serve) == the digest the registry recorded
 *
 * If that is off by one byte - a stripped newline, a rendered heading, a JSON
 * string wrapper - then the endpoint returns a document that CANNOT BE ACCEPTED
 * BY ANYONE, and the failure surfaces two calls later as a 409 that says the
 * client is holding a stale copy. It would look like a client bug forever.
 *
 * The blocks below are each a way this feature could exist and still be worthless:
 *
 *   1. The bytes could not hash          -> "the served bytes are the digested bytes"
 *   2. Only the CURRENT text could exist -> "a superseded version is still retrievable"
 *   3. It could fail wrong               -> "unknown documents and versions"
 *   4. It could need a credential        -> "no credential is required"
 *   5. It could be uncacheable, or
 *      cache a moving pointer forever    -> "caching and validators"
 *   6. It could all work in isolation
 *      and not close the loop            -> "the client procedure, followed literally"
 *   7. The durable copy could rot        -> "the database refuses text that does not
 *                                           hash to its own digest"
 *
 * Block 1 iterates `services.legal.documents` rather than naming the two documents
 * that exist today, so a third document added to the registry and not served is a
 * failure here rather than a discovery in production.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  CONSENT_DOCUMENTS,
  CONSENT_PRESENTATION,
  legalDigest,
  normalizeLegalText,
  LEGAL_CONTENT_TYPE,
  type LegalDocument,
} from "../../src/lib/legal-documents.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import { provisionSubject } from "../helpers/subjects.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

/** sha256 of a string, hex. What a client computes over the response body. */
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

interface IndexBody {
  canonicalMediaType: string;
  digest: { algorithm: string; encoding: string; normalization: string };
  documents: {
    documentId: string;
    version: string;
    consentEpoch: number;
    contentSha256: string;
    url: string;
    publishedAt: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// 1. Byte fidelity. The whole feature is this assertion.
// ---------------------------------------------------------------------------
describe("the served bytes are the digested bytes", () => {
  test("every registered document is served, and nothing extra is", async () => {
    // Iterated from the registry in both directions. A document registered and
    // never served would leave users unable to accept it; a document served that
    // nobody registered would be a published agreement outside the gate.
    const res = await ctx.app.inject({ method: "GET", url: "/v1/legal" });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<IndexBody>(res);

    expect(body.documents.map((d) => d.documentId).sort()).toEqual(
      ctx.services.legal.documents.map((d) => d.id).sort(),
    );
    expect(body.canonicalMediaType).toBe(LEGAL_CONTENT_TYPE);
    expect(body.digest.algorithm).toBe("sha256");
    expect(body.digest.encoding).toBe("hex");
    for (const doc of body.documents) {
      // From the append-only revision table, so a non-null value is also proof
      // the revision was published rather than merely compiled in.
      expect(doc.publishedAt).not.toBeNull();
    }
  });

  test.each(ctx_documents())(
    "$id: sha256 of the response body equals the recorded digest",
    async (doc: LegalDocument) => {
      // THE ASSERTION THE FEATURE EXISTS FOR, and it is deliberately the STRONG
      // form: a plain sha256 over the bytes as received, with no normalisation
      // step of any kind. That is only true because the route serves
      // pre-normalised text, and it is the property a client in another language
      // has to be able to rely on, because a client that has to reimplement three
      // normalisation rules is a client that will get one of them wrong and be
      // told it is holding a stale copy.
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/legal/${doc.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(sha256(res.body)).toBe(doc.contentSha256);

      // And the weaker form too, so a client that normalises anyway - because it
      // read the rule and implemented it defensively - is not punished for it.
      // This holds because normalisation is idempotent.
      expect(legalDigest(res.body)).toBe(doc.contentSha256);
    },
  );

  test.each(ctx_documents())(
    "$id: the registry url resolves to those same bytes",
    async (doc: LegalDocument) => {
      // Closes the loop that was open before this route existed. `url` is what
      // GET /v1/me/consent hands a client and what is written onto the revision
      // row, so the path it names has to be the path that serves the document.
      const path = new URL(doc.url).pathname;
      const res = await ctx.app.inject({ method: "GET", url: path });
      expect(res.statusCode, `${doc.url} did not resolve`).toBe(200);
      expect(sha256(res.body)).toBe(doc.contentSha256);
    },
  );

  test.each(ctx_documents())(
    "$id: markdown, not a JSON-wrapped string",
    async (doc: LegalDocument) => {
      // fast-json-stringify would happily serialise the document as a JSON string
      // literal, which hashes to something else entirely and would make the digest
      // impossible to reproduce from anything a reader sees. The route declares its
      // 200 under a `text/markdown` content map specifically to keep the JSON
      // serialiser off this path.
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/legal/${doc.id}`,
      });
      expect(res.headers["content-type"]).toBe(LEGAL_CONTENT_TYPE);
      expect(res.body.startsWith('"')).toBe(false);
      expect(res.body).toContain("**Version:**");
      // Serving is not the same as rendering. There is exactly one canonical
      // representation and no HTML anywhere near it.
      expect(res.body.includes("<html")).toBe(false);
    },
  );

  test.each(ctx_documents())(
    "$id: the durable copy in the database is the copy served",
    async (doc: LegalDocument) => {
      // The filesystem is a seed, not the source of truth. If the served bytes
      // came only from disk, a superseded version would be unrecoverable, so this
      // asserts the column is populated AND that it is what the route returns.
      const { rows } = await ctx.services.db.query<{ content: string | null }>(
        `SELECT content FROM legal_document_revisions
          WHERE document_id = $1 AND version = $2`,
        [doc.id, doc.version],
      );
      expect(
        rows[0]?.content,
        `${doc.id}@${doc.version} was published with no text, so it will not survive ` +
          `the file on disk changing`,
      ).not.toBeNull();

      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/legal/${doc.id}/versions/${doc.version}`,
      });
      expect(res.body).toBe(rows[0]?.content);
    },
  );

  test("the text served is a fixed point of the normalisation", () => {
    // Why the strong assertion above can hold at all. If normalisation were not
    // idempotent then no single byte sequence could satisfy both "hashes to the
    // recorded digest" and "is what normalisation produces", and the route would
    // have to choose which of the two contracts to break.
    const sample = "# T\r\n\r\nline with space   \n\n\n";
    const once = normalizeLegalText(sample);
    expect(normalizeLegalText(once)).toBe(once);
    expect(sha256(once)).toBe(legalDigest(sample));
  });

  test("the registry the suite iterates is the registry the app serves", () => {
    // `test.each` enumerates at collection time, before `beforeAll` runs, so the
    // cases above are built from the module constant. This is the assertion that
    // the constant and the running application are the same list, which is what
    // makes "a newly registered document cannot be silently unserved" true.
    expect(ctx.services.legal.documents.map((d) => d.id)).toEqual(
      CONSENT_DOCUMENTS.map((d) => d.id),
    );
  });
});

// ---------------------------------------------------------------------------
// 1b. The consent screen copy. Published and served like a document, and absent
//     from the set a subject can owe.
//
// Every claim below is one legal/consent-presentation.md section 1.1 makes about
// itself. An unserved copy would make that document's own description of its
// mechanism false, which is the failure legal/README.md's accuracy standard exists
// to prevent, arriving inside the file that states the standard.
// ---------------------------------------------------------------------------
describe("the consent screen copy is published, served, and never owed", () => {
  test("GET /v1/legal names it as `presentation`, not as a document to accept", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/legal" });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<
      IndexBody & {
        presentation: { documentId: string; contentSha256: string };
      }
    >(res);

    expect(body.presentation.documentId).toBe(CONSENT_PRESENTATION.id);
    expect(body.presentation.contentSha256).toBe(
      CONSENT_PRESENTATION.contentSha256,
    );
    // A SEPARATE MEMBER, and this is the assertion that matters. A client that
    // iterated `documents` and asked a person to accept every entry would be
    // asking for assent to the words with which it was asking.
    expect(body.documents.map((d) => d.documentId)).not.toContain(
      CONSENT_PRESENTATION.id,
    );
  });

  test("the served bytes hash to the recorded digest, with no preprocessing", async () => {
    // Same strong form as the documents: the route serves pre-normalised text, so
    // a client in another language hashes the response body as received.
    for (const url of [
      `/v1/legal/${CONSENT_PRESENTATION.id}`,
      `/v1/legal/${CONSENT_PRESENTATION.id}/versions/${CONSENT_PRESENTATION.version}`,
    ]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} did not resolve`).toBe(200);
      expect(res.headers["content-type"]).toBe(LEGAL_CONTENT_TYPE);
      expect(sha256(res.body), `${url} served bytes off its digest`).toBe(
        CONSENT_PRESENTATION.contentSha256,
      );
    }
  });

  test("the durable copy is in the database, so a superseded version survives", async () => {
    // The point of publishing it at all. The words that were live on a given date
    // have to be retrievable after they stop being current, or a consent row dated
    // then cannot be read against the screen that produced it.
    const { rows } = await ctx.services.db.query<{ content: string | null }>(
      `SELECT content FROM legal_document_revisions
        WHERE document_id = $1 AND version = $2`,
      [CONSENT_PRESENTATION.id, CONSENT_PRESENTATION.version],
    );
    expect(rows[0]?.content).not.toBeNull();
    expect(rows[0]?.content).not.toBeUndefined();
    expect(legalDigest(rows[0]?.content ?? "")).toBe(
      CONSENT_PRESENTATION.contentSha256,
    );
  });

  test("it does not appear in what a subject owes", async () => {
    // The other half of "published but never accepted". If it leaked into this
    // list, every user would owe an acceptance of the consent screen and the
    // screen would list itself among the documents it was presenting.
    const subject = await provisionSubject(ctx, "presentationowed", {
      consent: false,
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/consent",
      headers: { authorization: `Bearer ${subject.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{ documents: { documentId: string }[] }>(res);
    expect(body.documents.map((d) => d.documentId)).not.toContain(
      CONSENT_PRESENTATION.id,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. History. The requirement that makes a consent row checkable.
// ---------------------------------------------------------------------------
describe("a superseded version is still retrievable", () => {
  /**
   * A synthetic document backed by a real file in a scratch directory.
   *
   * Synthetic because the behaviour under test is what happens AFTER a revision,
   * and there is no way to revise `legal/terms-of-service.md` in the middle of a
   * test run. Backed by a real file because the whole point is that the file
   * CHANGES underneath the published revision: a fixture whose text existed only
   * in memory could not distinguish "we stored the text" from "we read the current
   * file and got lucky".
   *
   * `LEGAL_SOURCE_DIR` is the documented override that `resolveLegalRoot` honours,
   * and the source resolves its root at construction, so setting it around
   * `buildTestApp` binds each application to the scratch tree without disturbing
   * the default application built in `beforeAll`.
   */
  let root: string;
  const documentId = `tdoc-hist-${randomUUID().slice(0, 8)}`;
  const relative = `legal/${documentId}.md`;

  const V1_TEXT = `# Synthetic\n\n**Version:** v1\n\nThe original text.\n`;
  const V2_TEXT = `# Synthetic\n\n**Version:** v2\n\nCompletely different text.\n`;

  const synthetic = (version: string, text: string): LegalDocument => ({
    id: documentId,
    path: relative,
    version,
    consentEpoch: version === "v1" ? 1 : 2,
    material: true,
    contentSha256: legalDigest(text),
    url: `https://api.pull.fm/v1/legal/${documentId}/versions/${version}`,
    effectiveAt: null,
    notes: `synthetic fixture ${version}`,
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pullfm-legal-"));
    mkdirSync(join(root, "legal"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function withSourceRoot<T>(
    fn: (app: TestApp) => Promise<T>,
    documents: readonly LegalDocument[],
  ): Promise<T> {
    process.env["LEGAL_SOURCE_DIR"] = root;
    let app: TestApp;
    try {
      app = await buildTestApp({ legalDocuments: documents });
    } finally {
      delete process.env["LEGAL_SOURCE_DIR"];
    }
    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  }

  test("the text of v1 survives the file being replaced by v2", async () => {
    const v1 = synthetic("v1", V1_TEXT);
    const v2 = synthetic("v2", V2_TEXT);

    // Publish v1 from the file as it stands.
    writeFileSync(join(root, relative), V1_TEXT, "utf8");
    await withSourceRoot(
      async (app) => {
        const res = await app.app.inject({
          method: "GET",
          url: `/v1/legal/${documentId}/versions/v1`,
        });
        expect(res.statusCode).toBe(200);
        expect(sha256(res.body)).toBe(v1.contentSha256);
      },
      [v1],
    );

    // The working document changes. This is the moment that used to destroy the
    // ability to answer "what did this person agree to".
    writeFileSync(join(root, relative), V2_TEXT, "utf8");

    await withSourceRoot(
      async (app) => {
        // The current pointer follows the new version.
        const current = await app.app.inject({
          method: "GET",
          url: `/v1/legal/${documentId}`,
        });
        expect(current.statusCode).toBe(200);
        expect(sha256(current.body)).toBe(v2.contentSha256);

        // THE ASSERTION. v1 is no longer on disk anywhere, and it is still served,
        // byte for byte, from `legal_document_revisions.content`.
        const superseded = await app.app.inject({
          method: "GET",
          url: `/v1/legal/${documentId}/versions/v1`,
        });
        expect(
          superseded.statusCode,
          "the superseded version is unretrievable, so a consent row citing it is unfalsifiable",
        ).toBe(200);
        expect(superseded.body).toBe(V1_TEXT);
        expect(sha256(superseded.body)).toBe(v1.contentSha256);

        // And it is not the file being read by accident: the file now holds v2.
        expect(superseded.body).not.toBe(V2_TEXT);
      },
      [v2],
    );
  });

  test("a version whose text was never stored answers 503, not 404", async () => {
    // The one gap that cannot be closed retroactively: a revision published by a
    // build older than migration 0009 carries a digest and no text, and there is no
    // in-database source to backfill from. The row is inserted here directly to
    // reproduce that state.
    //
    // 503 rather than 404 because the version WAS published and consent rows may
    // cite it. Answering 404 would tell an operator holding such a row that the
    // version never existed, which is false and points the investigation at
    // record-keeping instead of at a deployment.
    const orphan = `tdoc-orphan-${randomUUID().slice(0, 8)}`;
    await ctx.services.db.query(
      `INSERT INTO legal_document_revisions
         (document_id, version, consent_epoch, content_sha256, is_material, url)
       VALUES ($1, 'v1', 1, $2, true, 'https://api.pull.fm/x')`,
      [orphan, sha256("text nobody kept")],
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${orphan}/versions/v1`,
    });
    expect(res.statusCode).toBe(503);
    const problem = jsonOf<{ type: string; detail: string }>(res);
    expect(problem.type).toBe(
      "https://pull.fm/problems/legal-text-unavailable",
    );
    expect(problem.detail).toContain("deployment fault");
  });

  test("a NULL text can be backfilled, and only with the text that hashes right", async () => {
    // The narrow exception migration 0009 carves into the immutability trigger,
    // and the reason it is safe: the digest is fixed at insert and the CHECK
    // recomputes it, so the only value the column will accept is the published
    // text. Supplying a different one is a preimage collision, not a mistake.
    const id = `tdoc-fill-${randomUUID().slice(0, 8)}`;
    const text = "# Fillable\n\nthe published text\n";
    await ctx.services.db.query(
      `INSERT INTO legal_document_revisions
         (document_id, version, consent_epoch, content_sha256, is_material, url)
       VALUES ($1, 'v1', 1, $2, true, 'https://api.pull.fm/x')`,
      [id, sha256(text)],
    );

    // Wrong text: refused by the CHECK, which never sees the trigger's blessing.
    await expect(
      ctx.services.db.query(
        `UPDATE legal_document_revisions SET content = 'something else'
          WHERE document_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/content_digest_chk/);

    // Right text: permitted, exactly once.
    await ctx.services.db.query(
      `UPDATE legal_document_revisions SET content = $2 WHERE document_id = $1`,
      [id, text],
    );

    // And now it is frozen again. A filled row is as immutable as it ever was.
    await expect(
      ctx.services.db.query(
        `UPDATE legal_document_revisions SET content = NULL WHERE document_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/append-only/);
  });

  test("the backfill cannot smuggle a change to anything else", async () => {
    // The trigger compares every other column for equality, so an UPDATE that
    // fills the text AND moves the epoch is refused rather than partly applied.
    const id = `tdoc-smuggle-${randomUUID().slice(0, 8)}`;
    const text = "# Smuggle\n\ntext\n";
    await ctx.services.db.query(
      `INSERT INTO legal_document_revisions
         (document_id, version, consent_epoch, content_sha256, is_material, url)
       VALUES ($1, 'v1', 1, $2, true, 'https://api.pull.fm/x')`,
      [id, sha256(text)],
    );

    await expect(
      ctx.services.db.query(
        `UPDATE legal_document_revisions SET content = $2, consent_epoch = 2
          WHERE document_id = $1`,
        [id, text],
      ),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// 3. Failing correctly. A wrong refusal sends somebody to the wrong place.
// ---------------------------------------------------------------------------
describe("unknown documents and versions", () => {
  test("an unknown document is 422, and says where the real list is", async () => {
    // 422 rather than 404, mirroring POST /v1/me/consent. 404 in this API means
    // "no such object, or somebody else's, deliberately indistinguishable", a rule
    // that exists so identifiers cannot be enumerated. The complete document set is
    // published unauthenticated at GET /v1/legal, so there is nothing to enumerate
    // and nothing to hide.
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/legal/not-a-document",
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain("/v1/legal");
  });

  test("an unknown version of a real document is 422", async () => {
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${doc?.id ?? "x"}/versions/NO-SUCH-VERSION`,
    });
    expect(res.statusCode).toBe(422);
  });

  test("a malformed slug is rejected by the schema before any code runs", async () => {
    // Shape-constrained to the same pattern as the database CHECK, so a caller
    // cannot put arbitrary text into a query parameter or a log line.
    for (const bad of ["A", "x", "../../etc/passwd", "has_underscore"]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/legal/${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode, `${bad} was not rejected`).toBeGreaterThanOrEqual(
        400,
      );
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).not.toBe(404);
    }
  });

  test("no refusal on these routes is a 404", async () => {
    // Load-bearing beyond tidiness. `openapi.test.ts` proves every documented
    // operation is mounted by asserting the response is not 404, substituting a
    // UUID for each path parameter. A 404 for an unknown document would make that
    // assertion silently vacuous for these three routes.
    for (const url of [
      "/v1/legal",
      "/v1/legal/00000000-0000-4000-8000-000000000000",
      "/v1/legal/00000000-0000-4000-8000-000000000000/versions/00000000-0000-4000-8000-000000000000",
    ]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} answered 404`).not.toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Reachable before an account exists.
// ---------------------------------------------------------------------------
describe("no credential is required", () => {
  test("the documents are readable with no Authorization header at all", async () => {
    // The requirement that decides the authorization class. Section 1 of the Terms
    // and SeatGeek API Terms clause 4.3 both require acceptance BEFORE use, so a
    // person must be able to read the documents before they have an account. An
    // authenticated-only document endpoint would mean the only way to see what you
    // are agreeing to is to agree to it first.
    const doc = ctx.services.legal.documents[0];
    expect(doc).toBeDefined();
    for (const url of [
      "/v1/legal",
      `/v1/legal/${doc?.id ?? ""}`,
      `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`,
    ]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} required a credential`).toBe(200);
    }
  });

  test("the consent gate does not apply to them", async () => {
    // The gate lives inside `requireAuth`, which these routes do not call, so it
    // cannot apply even by accident. Asserted anyway: a subject who owes consent is
    // exactly the subject who needs to read the documents, and gating them would
    // deadlock the flow more completely than gating GET /v1/me/consent would.
    const s = await provisionSubject(ctx, "legalowes", { consent: false });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${ctx.services.legal.documents[0]?.id ?? ""}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Caching, which is the one place this API can be generous.
// ---------------------------------------------------------------------------
describe("caching and validators", () => {
  test("a versioned URL is immutable and cacheable for a year", async () => {
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`,
    });
    const cache = String(res.headers["cache-control"]);
    expect(cache).toContain("public");
    expect(cache).toContain("max-age=31536000");
    expect(cache).toContain("immutable");
    // NOT the server.ts default. These are the only routes in the API that
    // deliberately step around `private, no-store`, because nothing here is
    // per-subject.
    expect(cache).not.toContain("no-store");
  });

  test("an unversioned URL is revalidated, because it moves", async () => {
    const doc = ctx.services.legal.documents[0];
    for (const url of ["/v1/legal", `/v1/legal/${doc?.id ?? ""}`]) {
      const res = await ctx.app.inject({ method: "GET", url });
      const cache = String(res.headers["cache-control"]);
      expect(cache, `${url} may be served stale`).toContain("no-cache");
      expect(cache).toContain("public");
      expect(cache).not.toContain("immutable");
    }
  });

  test("the ETag is the content digest, which is the strongest validator we have", async () => {
    const doc = ctx.services.legal.documents[0];
    expect(doc).toBeDefined();
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`,
    });
    expect(res.headers.etag).toBe(`"${doc?.contentSha256 ?? ""}"`);
    // Not a timestamp and not a hash of a serialisation: the same value the client
    // is about to compare against contentSha256.
    expect(res.headers.etag).toBe(`"${sha256(res.body)}"`);
  });

  test("a conditional request is answered 304 with no body", async () => {
    const doc = ctx.services.legal.documents[0];
    const path = `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`;
    const first = await ctx.app.inject({ method: "GET", url: path });
    const etag = String(first.headers.etag);

    const second = await ctx.app.inject({
      method: "GET",
      url: path,
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    // A 304 must repeat the validator and the policy, or a cache cannot refresh
    // its own freshness and will revalidate on every single read.
    expect(second.headers.etag).toBe(etag);
    expect(String(second.headers["cache-control"])).toContain("immutable");
  });

  test("a weak or list-valued If-None-Match still matches", async () => {
    // RFC 9110 section 13.1.2 specifies WEAK comparison for If-None-Match, and a
    // cache may hand back what it was given however it stored it. Rejecting
    // `W/"<digest>"` would silently turn every revalidation into a full transfer.
    const doc = ctx.services.legal.documents[0];
    const path = `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`;
    const etag = `"${doc?.contentSha256 ?? ""}"`;

    for (const header of [
      `W/${etag}`,
      `"deadbeef", ${etag}`,
      "*",
      ` ${etag} `,
    ]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: path,
        headers: { "if-none-match": header },
      });
      expect(res.statusCode, `If-None-Match: ${header}`).toBe(304);
    }
  });

  test("a stale If-None-Match gets the body", async () => {
    // The other direction, so the 304 above is not a route that always 304s.
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`,
      headers: { "if-none-match": `"${"0".repeat(64)}"` },
    });
    expect(res.statusCode).toBe(200);
    expect(sha256(res.body)).toBe(doc?.contentSha256);
  });

  test("the current-document response points at its own immutable copy", async () => {
    // So a client that followed the moving pointer can pin what it just read
    // without a second lookup, and so a bug report quoting the header names an
    // exact text rather than "whatever was current that day".
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/legal/${doc?.id ?? ""}`,
    });
    expect(res.headers["content-location"]).toBe(
      `/v1/legal/${doc?.id ?? ""}/versions/${doc?.version ?? ""}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The loop, closed. This is the test the whole task exists to make pass.
// ---------------------------------------------------------------------------
describe("the client procedure, followed literally", () => {
  test("fetch, hash, accept - using only what the API reports", async () => {
    // Nothing in this test reads the compiled registry. Every value comes off the
    // wire, exactly as a client that has never seen this repository would obtain
    // it, and the digests are computed from the served bytes rather than copied
    // from `contentSha256`. That is what makes it evidence that the documented
    // procedure works, rather than evidence that our constants agree with
    // themselves.
    const s = await provisionSubject(ctx, "procedure", { consent: false });
    const auth = { authorization: `Bearer ${s.token}` };

    // 1. Ask what is owed.
    const status = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/consent",
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    const owed = jsonOf<{
      satisfied: boolean;
      documents: { documentId: string; version: string; url: string }[];
    }>(status);
    expect(owed.satisfied).toBe(false);
    expect(owed.documents.length).toBeGreaterThan(0);

    // 2. Fetch each document from the url the API gave, and hash what came back.
    const accept: {
      documentId: string;
      version: string;
      contentSha256: string;
    }[] = [];
    for (const doc of owed.documents) {
      const fetched = await ctx.app.inject({
        method: "GET",
        url: new URL(doc.url).pathname,
      });
      expect(fetched.statusCode, `${doc.url} did not resolve`).toBe(200);
      expect(fetched.headers["content-type"]).toBe(LEGAL_CONTENT_TYPE);
      accept.push({
        documentId: doc.documentId,
        version: doc.version,
        contentSha256: sha256(fetched.body),
      });
    }

    // 3. Accept, echoing the digests computed in step 2. A 409 here means the
    //    bytes served are not the bytes published, which is the failure this whole
    //    file exists to make impossible.
    const recorded = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth,
      payload: { accept, client: { build: "1.0.0-test", platform: "vitest" } },
    });
    expect(
      recorded.statusCode,
      `acceptance was refused: ${recorded.body}`,
    ).toBe(200);
    const result = jsonOf<{ satisfied: boolean; recorded: unknown[] }>(
      recorded,
    );
    expect(result.satisfied).toBe(true);
    expect(result.recorded).toHaveLength(accept.length);

    // 4. The gate is open on a route that was refused a moment ago.
    const gated = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: auth,
    });
    expect(gated.statusCode).toBe(200);
  });

  test("the unauthenticated index carries the same digests the gate enforces", async () => {
    // A client at first launch reads the index before it has an account, and the
    // documents it displays then have to be the ones the gate will accept. Two
    // endpoints reporting different digests would send a brand new user round the
    // 409 loop on their first attempt.
    const index = jsonOf<IndexBody>(
      await ctx.app.inject({ method: "GET", url: "/v1/legal" }),
    );
    const s = await provisionSubject(ctx, "sameindex", { consent: false });
    const owed = jsonOf<{
      documents: {
        documentId: string;
        version: string;
        contentSha256: string;
      }[];
    }>(
      await ctx.app.inject({
        method: "GET",
        url: "/v1/me/consent",
        headers: { authorization: `Bearer ${s.token}` },
      }),
    );

    const key = (d: {
      documentId: string;
      version: string;
      contentSha256: string;
    }) => `${d.documentId}@${d.version}=${d.contentSha256}`;
    expect(index.documents.map(key).sort()).toEqual(
      owed.documents.map(key).sort(),
    );
  });
});

/**
 * The registry, for `test.each`.
 *
 * Read from the module rather than from `ctx.services.legal.documents`, and the
 * reason is a real trap rather than a style choice: `test.each` enumerates its
 * cases at COLLECTION time, before `beforeAll` has run, so `ctx` does not exist
 * yet and a suite that reached for it would silently generate zero cases and
 * report green. The two lists being identical is asserted in block 1.
 */
function ctx_documents(): readonly LegalDocument[] {
  return CONSENT_DOCUMENTS;
}

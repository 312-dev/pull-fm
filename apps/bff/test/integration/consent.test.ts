/**
 * The first-launch consent gate, end to end.
 *
 * WHAT IS BEING PROVED, AND WHY IT IS WORTH A SUITE OF THIS SIZE
 *
 * `legal/terms-of-service.md` section 1 used to assert that using Pull.fm meant
 * agreeing to the Terms. Under Illinois law that assertion is worth nothing on its
 * own: `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016) found NO
 * CONTRACT FORMED where a user completed a PAID purchase on a page that displayed
 * the terms, because the interface did not communicate that proceeding was assent.
 * If no contract forms, the liability cap in section 13, the Illinois venue in
 * section 16, the third-party beneficiary grant to the SeatGeek Entities in
 * section 9 and the US-only offering in section 2 are all unenforceable. SeatGeek's
 * API Terms clause 4.3 independently requires that each End User be REQUIRED TO
 * ACCEPT a EULA before using the Application.
 *
 * So this is not a feature test. Each block below corresponds to a way the gate
 * could be present and still worthless:
 *
 *   1. It could not refuse anything          -> "an un-accepted subject is refused"
 *   2. It could refuse the wrong things      -> "the exemptions"
 *   3. It could refuse forever               -> "accepting satisfies it"
 *   4. It could ignore revisions             -> "a material revision"
 *   5. It could treat a typo as a revision   -> "a cosmetic revision"
 *   6. It could record forgeable evidence    -> "the record is append-only"
 *   7. It could record the wrong text        -> "the digest and version must match"
 *   8. It could vanish on account deletion   -> "the receipt outlives the account"
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { LegalDocument } from "../../src/lib/legal-documents.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import {
  acceptRequiredDocuments,
  provisionSubject,
  type Subject,
} from "../helpers/subjects.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const auth = (s: Subject) => ({ authorization: `Bearer ${s.token}` });

/** The body a client sends for every document this application requires. */
function acceptanceBody(documents: readonly LegalDocument[]) {
  return {
    accept: documents.map((doc) => ({
      documentId: doc.id,
      version: doc.version,
      contentSha256: doc.contentSha256,
    })),
    client: { build: "1.0.0-test", platform: "vitest" },
  };
}

interface ConsentStatus {
  satisfied: boolean;
  reason: string | null;
  documents: {
    documentId: string;
    version: string;
    consentEpoch: number;
    contentSha256: string;
    url: string;
    publishedAt: string | null;
    outstanding: boolean;
    accepted: { version: string; acceptedAt: string; gate: string } | null;
  }[];
  history: {
    documentId: string;
    version: string;
    consentEpoch: number;
    acceptedAt: string;
    gate: string;
  }[];
}

/**
 * A synthetic document registry.
 *
 * Synthetic because the behaviour that matters is what happens on the SECOND
 * launch, and there is no way to revise `legal/terms-of-service.md` in the middle
 * of a test. Every case that needs a revision gets its own document id, so the
 * per-document epoch monotonicity the database enforces cannot couple two test
 * cases into an ordering dependency.
 */
function syntheticDocument(
  id: string,
  version: string,
  consentEpoch: number,
  material: boolean,
): LegalDocument {
  return {
    id,
    path: `legal/${id}.md`,
    version,
    consentEpoch,
    material,
    contentSha256: createHash("sha256")
      .update(`${id}@${version}`)
      .digest("hex"),
    url: `https://pull.fm/legal/${id}.md`,
    effectiveAt: null,
    notes: `synthetic fixture ${id} ${version}`,
  };
}

let docCounter = 0;
const nextDocumentId = (): string => {
  docCounter += 1;
  return `tdoc-${String(docCounter)}-${randomUUID().slice(0, 8)}`;
};

// ---------------------------------------------------------------------------
// 1. A new user owes consent, and is refused.
// ---------------------------------------------------------------------------
describe("an un-accepted subject is refused", () => {
  test("a brand new account owes every required document", async () => {
    const s = await provisionSubject(ctx, "owes", { consent: false });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/consent",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<ConsentStatus>(res);

    expect(body.satisfied).toBe(false);
    expect(body.reason).toBe("never-accepted");
    expect(body.history).toEqual([]);
    expect(body.documents.map((d) => d.documentId).sort()).toEqual(
      ctx.services.legal.documents.map((d) => d.id).sort(),
    );
    for (const doc of body.documents) {
      expect(doc.outstanding).toBe(true);
      expect(doc.accepted).toBeNull();
      // Read from the append-only revision table rather than from the deployed
      // registry, so this being non-null is also proof the revisions were stored.
      expect(doc.publishedAt).not.toBeNull();
    }
  });

  test("a READ is refused, not merely a write", async () => {
    // The distinction the two-tier design turns on. A subject who has accepted
    // NOTHING has no contract, so nothing they do is licensed - and the catalogue
    // they would read is third-party data we may only serve under an accepted
    // EULA (SeatGeek clause 4.3 says "before using your Application", which
    // covers reads).
    const s = await provisionSubject(ctx, "owesread", { consent: false });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(403);
    const problem = jsonOf<{
      type: string;
      consent?: { reason: string; outstanding: { documentId: string }[] };
    }>(res);
    expect(problem.type).toBe("https://pull.fm/problems/consent-required");
    expect(problem.consent?.reason).toBe("never-accepted");
    // The extension member survives serialisation. It is declared in
    // `problemSchema` for exactly this reason: fast-json-stringify emits declared
    // properties only, so an undeclared extension member is not undocumented, it
    // is deleted, and a cold-started client would get a 403 with nothing to render.
    expect(
      problem.consent?.outstanding.map((d) => d.documentId).sort(),
    ).toEqual(ctx.services.legal.documents.map((d) => d.id).sort());
  });

  test("a write is refused too", async () => {
    const s = await provisionSubject(ctx, "oweswrite", { consent: false });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": randomUUID() },
      payload: { artistName: "A", title: "T", recordingMbid: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("consent-required");
  });

  test("the refusal is 403, not 401, so a client does not loop through sign-in", async () => {
    // A 401 here is the failure that ends with the user reinstalling the app: the
    // credential is valid, refreshing it changes nothing, and a client that
    // handles 401 by re-authenticating would spin forever.
    const s = await provisionSubject(ctx, "owescode", { consent: false });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(403);
  });

  test("an anonymous request is still 401, not 403", async () => {
    // The gate runs AFTER authentication, so it must never convert a missing
    // credential into a consent problem. A client that saw 403 for "not signed
    // in" would show a terms screen to a signed-out user.
    const res = await ctx.app.inject({ method: "GET", url: "/v1/wishlist" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. The exemptions. Each one is a hole in the control and has to be exactly
//    where it was argued to be.
// ---------------------------------------------------------------------------
describe("the exemptions", () => {
  test("a subject who has accepted nothing can still read their own account", async () => {
    const s = await provisionSubject(ctx, "exempt-me", { consent: false });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);
  });

  test("...and can still export their data (GDPR Article 20)", async () => {
    const s = await provisionSubject(ctx, "exempt-export", { consent: false });
    const request = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/export",
      headers: auth(s),
    });
    expect(request.statusCode).toBe(202);
    const token = new URL(
      jsonOf<{ downloadUrl: string }>(request).downloadUrl,
    ).searchParams.get("token");
    const download = await ctx.app.inject({
      method: "GET",
      url: `/v1/me/export/download?token=${encodeURIComponent(token ?? "")}`,
      headers: auth(s),
    });
    expect(download.statusCode).toBe(200);
  });

  test("...and can still sign out", async () => {
    const s = await provisionSubject(ctx, "exempt-logout", { consent: false });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);
  });

  test("...and can still delete their account (GDPR Article 17)", async () => {
    // The exemption that matters most. Erasure is a statutory right and cannot be
    // conditioned on agreeing to a contract, and it is also the only honest exit
    // for a user who read the Terms and declined - which is what section 15 of
    // the Terms tells that user to do.
    const s = await provisionSubject(ctx, "exempt-delete", { consent: false });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(s),
      payload: { confirm: s.email },
    });
    expect(res.statusCode).toBe(200);
    expect(jsonOf<{ deleted: boolean }>(res).deleted).toBe(true);
  });

  test("PATCH /v1/me is NOT exempt: the read is, the write is not", async () => {
    const s = await provisionSubject(ctx, "exempt-patch", { consent: false });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(s),
      payload: { firstName: "Nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("consent-required");
  });

  test("the exempt set is exactly this, enumerated from the generated spec", async () => {
    // Enumerated from the OpenAPI document rather than from a list in the source,
    // so this fails when a route is exempted, not when somebody remembers to
    // update a fixture. Every entry is a route an un-accepted user can reach, so
    // growing this list is growing the hole and has to be a visible diff.
    const spec = await ctx.app.inject({ method: "GET", url: "/openapi.json" });
    const doc = JSON.parse(spec.body) as {
      paths: Record<string, Record<string, { "x-pullfm-consent"?: string }>>;
    };

    const byGate = new Map<string, string[]>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const gate = operation["x-pullfm-consent"];
        // EVERY operation carries the annotation, defaulted rather than omitted:
        // an absent key would be indistinguishable from an operation nobody
        // classified.
        expect(
          gate,
          `${method} ${path} carries no x-pullfm-consent`,
        ).toBeDefined();
        if (gate === undefined || gate === "enforced") continue;
        byGate.set(gate, [
          ...(byGate.get(gate) ?? []),
          `${method.toUpperCase()} ${path}`,
        ]);
      }
    }

    for (const list of byGate.values()) list.sort();
    expect(Object.fromEntries([...byGate.entries()].sort())).toEqual({
      "exempt-account-identity": ["GET /v1/me"],
      "exempt-consent-flow": ["GET /v1/me/consent", "POST /v1/me/consent"],
      "exempt-data-subject-right": [
        "DELETE /v1/me",
        "GET /v1/me/export",
        "GET /v1/me/export/download",
      ],
      "exempt-session-control": ["POST /v1/auth/logout"],
    });
  });

  test("unauthenticated routes are unaffected by the gate", async () => {
    // The gate lives inside requireAuth, so a public route cannot be gated even
    // by accident. Asserted rather than assumed, because a future move to an
    // onRequest hook would break it silently.
    for (const url of ["/v1/config", "/healthz", "/readyz"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} answered ${String(res.statusCode)}`).toBe(
        200,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Recording it satisfies the requirement.
// ---------------------------------------------------------------------------
describe("accepting satisfies the requirement", () => {
  test("acceptance is recorded and the gate opens", async () => {
    const s = await provisionSubject(ctx, "accepts", { consent: false });
    const documents = ctx.services.legal.documents;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: acceptanceBody(documents),
    });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      satisfied: boolean;
      reason: string | null;
      recorded: { documentId: string; gate: string; consentEpoch: number }[];
      outstanding: unknown[];
    }>(res);

    expect(body.satisfied).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.outstanding).toEqual([]);
    expect(body.recorded).toHaveLength(documents.length);
    // Derived from the subject's own history, not from the request: this user had
    // accepted nothing, so it was a first-launch screen.
    for (const record of body.recorded)
      expect(record.gate).toBe("first-launch");

    // The gate is open on a route that was refused a moment ago.
    const wishlist = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: auth(s),
    });
    expect(wishlist.statusCode).toBe(200);
  });

  test("the acceptance survives a reinstall, because it is not in app storage", async () => {
    // The whole reason the record is server-side. A fresh credential for the same
    // account - which is what a reinstall produces - must not re-owe.
    const s = await provisionSubject(ctx, "reinstall");
    const fresh = await ctx.idp.mint(s.workosUserId, {
      sessionId: `session_reinstall_${randomUUID().slice(0, 8)}`,
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("re-accepting is a no-op rather than a duplicate", async () => {
    const s = await provisionSubject(ctx, "reaccept");
    const before = jsonOf<ConsentStatus>(
      await ctx.app.inject({
        method: "GET",
        url: "/v1/me/consent",
        headers: auth(s),
      }),
    );

    const again = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: acceptanceBody(ctx.services.legal.documents),
    });
    expect(again.statusCode).toBe(200);
    // Empty `recorded` is the idempotent case, not a failure: the versions were
    // already accepted.
    expect(jsonOf<{ recorded: unknown[] }>(again).recorded).toEqual([]);

    const after = jsonOf<ConsentStatus>(
      await ctx.app.inject({
        method: "GET",
        url: "/v1/me/consent",
        headers: auth(s),
      }),
    );
    // ON CONFLICT DO NOTHING, never DO UPDATE. The FIRST acceptance is when the
    // contract formed, and a retry must not move that timestamp forward.
    expect(after.history).toEqual(before.history);
  });

  test("the acceptance is written to the audit trail as well as the record", async () => {
    const s = await provisionSubject(ctx, "audited", { consent: false });
    await acceptRequiredDocuments(ctx, s);

    const { rows } = await ctx.services.db.query<{
      subject_ref: string;
      detail: { gate: string; contentSha256: string };
    }>(
      `SELECT subject_ref, detail FROM audit_log
        WHERE user_id = $1 AND action = 'account.terms_accepted'
        ORDER BY subject_ref`,
      [s.id],
    );
    expect(rows).toHaveLength(ctx.services.legal.documents.length);
    const expected = ctx.services.legal.documents
      .map((d) => `${d.id}@${d.version}`)
      .sort();
    expect(rows.map((r) => r.subject_ref)).toEqual(expected);
    for (const row of rows) expect(row.detail.gate).toBe("first-launch");
  });
});

// ---------------------------------------------------------------------------
// 4 and 5. The revision behaviour. This is the pair the epoch exists for.
// ---------------------------------------------------------------------------
describe("revisions", () => {
  /**
   * Builds a second application over the SAME database with a different registry.
   *
   * The second application has its own local identity provider, so the subject's
   * original token does not verify against it; a fresh token for the same WorkOS
   * subject id is minted instead. That is not a workaround, it is the realistic
   * shape: the user is the same account, the deployment has changed underneath
   * them.
   */
  async function withRegistry<T>(
    documents: readonly LegalDocument[],
    fn: (app: TestApp) => Promise<T>,
  ): Promise<T> {
    const app = await buildTestApp({ legalDocuments: documents });
    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  }

  test("a MATERIAL revision makes an existing user owe again", async () => {
    const id = nextDocumentId();
    const v1 = syntheticDocument(id, "v1", 1, true);
    const v2 = syntheticDocument(id, "v2", 2, true);

    const subject = await withRegistry([v1], async (app) => {
      const s = await provisionSubject(app, "revmat");
      // Baseline: satisfied under v1, including on a write.
      const ok = await app.app.inject({
        method: "POST",
        url: "/v1/wishlist",
        headers: { ...auth(s), "idempotency-key": randomUUID() },
        payload: {
          artistName: "Before",
          title: "Before",
          recordingMbid: randomUUID(),
        },
      });
      expect(ok.statusCode).toBe(201);
      return s;
    });

    await withRegistry([v2], async (app) => {
      app.workos.register(subject.email, subject.workosUserId);
      const token = await app.idp.mint(subject.workosUserId, {
        sessionId: `session_rev_${randomUUID().slice(0, 8)}`,
      });
      const headers = { authorization: `Bearer ${token}` };

      const status = jsonOf<ConsentStatus>(
        await app.app.inject({
          method: "GET",
          url: "/v1/me/consent",
          headers,
        }),
      );
      expect(status.satisfied).toBe(false);
      expect(status.reason).toBe("revision-pending");
      // Their earlier acceptance is still reported. A null here would read as
      // "you have never accepted anything", which is both false and the wrong
      // screen.
      expect(status.documents[0]?.accepted?.version).toBe("v1");
      expect(status.documents[0]?.outstanding).toBe(true);

      // READS CONTINUE. Locking this user out would punish them for OUR revision
      // and would make every material amendment a self-inflicted outage, which is
      // the pressure that leads to amendments being quietly called cosmetic.
      const read = await app.app.inject({
        method: "GET",
        url: "/v1/wishlist",
        headers,
      });
      expect(read.statusCode).toBe(200);

      // WRITES STOP. Enough that the notice cannot be dismissed forever.
      const write = await app.app.inject({
        method: "POST",
        url: "/v1/wishlist",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          artistName: "After",
          title: "After",
          recordingMbid: randomUUID(),
        },
      });
      expect(write.statusCode).toBe(403);
      expect(
        jsonOf<{ consent: { reason: string } }>(write).consent.reason,
      ).toBe("revision-pending");

      // Accepting the new version reopens writes, and the gate records that this
      // was a REVISION screen rather than a first launch.
      const accepted = await app.app.inject({
        method: "POST",
        url: "/v1/me/consent",
        headers,
        payload: acceptanceBody([v2]),
      });
      expect(accepted.statusCode).toBe(200);
      expect(
        jsonOf<{ recorded: { gate: string }[] }>(accepted).recorded[0]?.gate,
      ).toBe("revision");

      const after = await app.app.inject({
        method: "POST",
        url: "/v1/wishlist",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          artistName: "Now",
          title: "Now",
          recordingMbid: randomUUID(),
        },
      });
      expect(after.statusCode).toBe(201);
    });
  });

  test("a COSMETIC revision does not make anybody accept again", async () => {
    // The other half, and the reason enforcement compares the epoch rather than
    // the digest or the version. A fixed typo that logged every user out would
    // teach the operator to stop fixing typos, or worse, to classify real
    // amendments as cosmetic to avoid the disruption.
    const id = nextDocumentId();
    const v1 = syntheticDocument(id, "v1", 1, true);
    // New version, NEW DIGEST, same epoch, material: false.
    const v1a = syntheticDocument(id, "v1a", 1, false);
    expect(v1a.contentSha256).not.toBe(v1.contentSha256);

    const subject = await withRegistry([v1], (app) =>
      provisionSubject(app, "revcos"),
    );

    await withRegistry([v1a], async (app) => {
      app.workos.register(subject.email, subject.workosUserId);
      const token = await app.idp.mint(subject.workosUserId, {
        sessionId: `session_cos_${randomUUID().slice(0, 8)}`,
      });
      const headers = { authorization: `Bearer ${token}` };

      const status = jsonOf<ConsentStatus>(
        await app.app.inject({ method: "GET", url: "/v1/me/consent", headers }),
      );
      expect(status.satisfied).toBe(true);
      expect(status.reason).toBeNull();
      expect(status.documents[0]?.outstanding).toBe(false);
      // Still on v1, and that is correct: they satisfy epoch 1 and nobody asked
      // them to re-read a corrected comma.
      expect(status.documents[0]?.accepted?.version).toBe("v1");

      const write = await app.app.inject({
        method: "POST",
        url: "/v1/wishlist",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          artistName: "Cos",
          title: "Cos",
          recordingMbid: randomUUID(),
        },
      });
      expect(write.statusCode).toBe(201);
    });
  });

  test("both revisions are stored, and the cosmetic one is marked as such", async () => {
    const id = nextDocumentId();
    const v1 = syntheticDocument(id, "v1", 1, true);
    const v1a = syntheticDocument(id, "v1a", 1, false);
    const v2 = syntheticDocument(id, "v2", 2, true);

    await withRegistry([v1], (app) => app.services.legal.ensureRevisions());
    await withRegistry([v1a], (app) => app.services.legal.ensureRevisions());
    await withRegistry([v2], (app) => app.services.legal.ensureRevisions());

    const { rows } = await ctx.services.db.query<{
      version: string;
      consent_epoch: number;
      is_material: boolean;
    }>(
      `SELECT version, consent_epoch, is_material FROM legal_document_revisions
        WHERE document_id = $1 ORDER BY consent_epoch, version`,
      [id],
    );
    expect(rows).toEqual([
      { version: "v1", consent_epoch: 1, is_material: true },
      { version: "v1a", consent_epoch: 1, is_material: false },
      { version: "v2", consent_epoch: 2, is_material: true },
    ]);
  });

  test("a build that redefines a published version refuses to serve it", async () => {
    // The condition this catches is an application rolled back past a legal
    // revision, or two deployments of different builds pointed at one database.
    // Recording consent in that state would produce rows nobody can interpret, so
    // it is a loud failure rather than a silent second truth. Not self-healing: an
    // UPDATE here would rewrite what every existing consent row means.
    const id = nextDocumentId();
    const honest = syntheticDocument(id, "v1", 1, true);
    await withRegistry([honest], (app) => app.services.legal.ensureRevisions());

    const forged: LegalDocument = {
      ...honest,
      contentSha256: createHash("sha256")
        .update("different text")
        .digest("hex"),
    };
    await withRegistry([forged], async (app) => {
      await expect(app.services.legal.ensureRevisions()).rejects.toThrow(
        /was published with digest .* but this build declares digest/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The record is evidence, so it has to be unforgeable.
// ---------------------------------------------------------------------------
describe("the record is append-only", () => {
  test("an UPDATE is refused by the database, not merely absent from the code", async () => {
    // Every field an UPDATE could move is a one-statement forgery of the only
    // evidence that a contract was formed: the timestamp, the epoch, the digest.
    // There is no UPDATE path in the service, and there is no UPDATE path at all.
    const s = await provisionSubject(ctx, "immutable");
    await expect(
      ctx.services.db.query(
        `UPDATE legal_consents SET accepted_at = now() - interval '1 year'
          WHERE user_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      ctx.services.db.query(
        `UPDATE legal_consents SET consent_epoch = consent_epoch + 5 WHERE user_id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/append-only/);
  });

  test("a published revision cannot be edited either", async () => {
    await expect(
      ctx.services.db.query(
        `UPDATE legal_document_revisions SET content_sha256 = repeat('a', 64)`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  test("accepting a newer version leaves the older acceptance intact", async () => {
    // The axis history runs along. "What did this user agree to in March" is
    // answered by the row for the version that was current in March, and no later
    // acceptance overwrites it.
    const id = nextDocumentId();
    const v1 = syntheticDocument(id, "v1", 1, true);
    const v2 = syntheticDocument(id, "v2", 2, true);

    const app1 = await buildTestApp({ legalDocuments: [v1] });
    let subject: Subject;
    try {
      subject = await provisionSubject(app1, "hist");
    } finally {
      await app1.close();
    }

    const app2 = await buildTestApp({ legalDocuments: [v2] });
    try {
      app2.workos.register(subject.email, subject.workosUserId);
      const token = await app2.idp.mint(subject.workosUserId, {
        sessionId: `session_hist_${randomUUID().slice(0, 8)}`,
      });
      await app2.app.inject({
        method: "POST",
        url: "/v1/me/consent",
        headers: { authorization: `Bearer ${token}` },
        payload: acceptanceBody([v2]),
      });

      const status = jsonOf<ConsentStatus>(
        await app2.app.inject({
          method: "GET",
          url: "/v1/me/consent",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(
        status.history.map((h) => h.version).sort(),
        "the v1 acceptance was overwritten rather than kept",
      ).toEqual(["v1", "v2"]);
      expect(status.history.map((h) => h.gate).sort()).toEqual([
        "first-launch",
        "revision",
      ]);
    } finally {
      await app2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The acceptance has to be recorded against the text that was displayed.
// ---------------------------------------------------------------------------
describe("the version and the digest must match what is published", () => {
  test("a stale version is a 409 the client can recover from", async () => {
    const s = await provisionSubject(ctx, "staleversion", { consent: false });
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: {
        accept: [
          {
            documentId: doc?.id,
            version: "SOME-OLD-VERSION",
            contentSha256: doc?.contentSha256,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("GET /v1/me/consent");
  });

  test("a digest that does not match the published text is refused", async () => {
    // THE CHECK THAT EARNS ITS KEEP. It cannot prove a human read anything - no
    // server-side control can, which is why section 1 of the Terms keeps its
    // marker open. What it closes is the realistic failure: a client shipping a
    // stale bundled copy of the Terms and having its acceptances recorded against
    // text the user never saw. That produces a table full of records that are
    // confidently wrong, which is worse than no records at all.
    const s = await provisionSubject(ctx, "staledigest", { consent: false });
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: {
        accept: [
          {
            documentId: doc?.id,
            version: doc?.version,
            contentSha256: createHash("sha256")
              .update("a stale bundled copy")
              .digest("hex"),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("does not match the document");

    // And nothing was written. A refused acceptance that still recorded a row
    // would be the exact defect this check exists to prevent.
    const { rows } = await ctx.services.db.query(
      `SELECT 1 FROM legal_consents WHERE user_id = $1`,
      [s.id],
    );
    expect(rows).toHaveLength(0);
  });

  test("a malformed digest is rejected by the schema before any code runs", async () => {
    const s = await provisionSubject(ctx, "baddigest", { consent: false });
    const doc = ctx.services.legal.documents[0];
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: {
        accept: [
          { documentId: doc?.id, version: doc?.version, contentSha256: "nope" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test("an unknown document is 422, because no client could have displayed it", async () => {
    const s = await provisionSubject(ctx, "unknowndoc", { consent: false });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: {
        accept: [
          {
            documentId: "not-a-document",
            version: "v1",
            contentSha256: createHash("sha256").update("x").digest("hex"),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  test("accepting only one of two documents leaves the gate closed", async () => {
    const documents = ctx.services.legal.documents;
    expect(
      documents.length,
      "this assertion needs at least two required documents to mean anything",
    ).toBeGreaterThan(1);

    const s = await provisionSubject(ctx, "partial", { consent: false });
    const first = documents[0];
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: auth(s),
      payload: acceptanceBody(first === undefined ? [] : [first]),
    });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      satisfied: boolean;
      outstanding: { documentId: string }[];
    }>(res);
    expect(body.satisfied).toBe(false);
    expect(body.outstanding.map((d) => d.documentId)).toEqual(
      documents.slice(1).map((d) => d.id),
    );

    const wishlist = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: auth(s),
    });
    expect(wishlist.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The credential asymmetry. A script must not be able to form a contract.
// ---------------------------------------------------------------------------
describe("a personal API token can read the status but cannot accept", () => {
  test("a token holding read:me can read GET /v1/me/consent", async () => {
    // Deliberately readable. A script whose calls started failing with 403 needs
    // to be able to find out why, and "a human has to accept in the app" is a far
    // better failure than a status code the author has to guess at.
    const s = await provisionSubject(ctx, "tokenread");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...auth(s), "idempotency-key": randomUUID() },
      payload: { name: `consent ${randomUUID().slice(0, 8)}` },
    });
    const secret = jsonOf<{ token: string }>(created).token;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/consent",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(200);
    expect(jsonOf<ConsentStatus>(res).satisfied).toBe(true);
  });

  test("a token cannot accept a contract on the account holder's behalf", async () => {
    // This is not the usual "tokens are read-only" argument. A script accepting a
    // contract for a person is precisely the defect Sgouros describes: no human
    // act, therefore no assent, therefore recording one would manufacture
    // evidence of a contract that did not form. The CHECK constraint
    // `legal_consents_auth_method_chk` says the same thing in the schema, so
    // widening this needs a migration as well as a diff.
    const s = await provisionSubject(ctx, "tokenwrite");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { ...auth(s), "idempotency-key": randomUUID() },
      payload: { name: `consent ${randomUUID().slice(0, 8)}` },
    });
    const secret = jsonOf<{ token: string }>(created).token;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/me/consent",
      headers: { authorization: `Bearer ${secret}` },
      payload: acceptanceBody(ctx.services.legal.documents),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 8. What happens to the evidence when the account is erased.
// ---------------------------------------------------------------------------
describe("erasure", () => {
  test("the consent rows cascade away and a receipt survives", async () => {
    // The cascade decision, argued in migration 0008. The personal data in the
    // row - user id, IP, user agent, session id - leaves with the account, and the
    // fact that a contract was formed does not, because a user must not be able
    // to destroy our record of assent by deleting their account, and we must not
    // keep an identified row that falsifies the deletion notice we publish.
    const s = await provisionSubject(ctx, "erasure");

    const before = await ctx.services.db.query(
      `SELECT 1 FROM legal_consents WHERE user_id = $1`,
      [s.id],
    );
    expect(before.rows.length).toBeGreaterThan(0);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(s),
      payload: { confirm: s.email },
    });
    expect(res.statusCode).toBe(200);
    // The cascade is counted, so a future table added without ON DELETE CASCADE
    // is discovered by us rather than by a regulator.
    expect(
      jsonOf<{ rowsDeleted: Record<string, number> }>(res).rowsDeleted[
        "legal_consents"
      ],
    ).toBe(ctx.services.legal.documents.length);

    const after = await ctx.services.db.query(
      `SELECT 1 FROM legal_consents WHERE user_id = $1`,
      [s.id],
    );
    expect(after.rows).toHaveLength(0);

    const { rows } = await ctx.services.db.query<{
      consents: {
        documentId: string;
        version: string;
        consentEpoch: number;
        contentSha256: string;
        acceptedAt: string;
        gate: string;
      }[];
    }>(`SELECT consents FROM deletion_log WHERE deleted_user_id = $1`, [s.id]);
    const receipt = rows[0]?.consents ?? [];
    expect(receipt).toHaveLength(ctx.services.legal.documents.length);
    for (const entry of receipt) {
      expect(entry.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.acceptedAt).toBeTruthy();
      expect(entry.gate).toBe("first-launch");
    }
    // The receipt is deliberately NARROWER than the row. These are the
    // identifying fields and they must not be in it.
    const serialised = JSON.stringify(receipt);
    for (const leaked of ["ip", "userAgent", "sessionId", "clientBuild"]) {
      expect(serialised.includes(leaked), `the receipt carries ${leaked}`).toBe(
        false,
      );
    }
  });

  test("the acceptance history is in the Article 20 export", async () => {
    // An export that omitted this would hand a user everything except the terms
    // they are bound by. The IP and user agent are excluded on purpose: they
    // corroborate the act for our benefit and are not data the subject provided,
    // and echoing an address into a file a user may forward is a disclosure with
    // no portability value.
    const s = await provisionSubject(ctx, "exportconsent");
    const request = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/export",
      headers: auth(s),
    });
    const token = new URL(
      jsonOf<{ downloadUrl: string }>(request).downloadUrl,
    ).searchParams.get("token");
    const download = await ctx.app.inject({
      method: "GET",
      url: `/v1/me/export/download?token=${encodeURIComponent(token ?? "")}`,
      headers: auth(s),
    });
    expect(download.statusCode).toBe(200);

    const doc = jsonOf<{
      legalConsents: {
        document_id: string;
        document_version: string;
        content_sha256: string;
      }[];
    }>(download);
    expect(doc.legalConsents).toHaveLength(ctx.services.legal.documents.length);
    expect(doc.legalConsents.map((c) => c.document_id).sort()).toEqual(
      ctx.services.legal.documents.map((d) => d.id).sort(),
    );
    const serialised = JSON.stringify(doc.legalConsents);
    for (const excluded of ["ip", "user_agent", "session_id"]) {
      expect(
        serialised.includes(excluded),
        `the export carries ${excluded}`,
      ).toBe(false);
    }
  });

  test("deleting an account that never accepted anything still works", async () => {
    // The empty receipt is the correct value here, and it will be the common one
    // at first: every account that existed before the gate did.
    const s = await provisionSubject(ctx, "erasure-none", { consent: false });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(s),
      payload: { confirm: s.email },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.services.db.query<{ consents: unknown[] }>(
      `SELECT consents FROM deletion_log WHERE deleted_user_id = $1`,
      [s.id],
    );
    expect(rows[0]?.consents).toEqual([]);
  });
});

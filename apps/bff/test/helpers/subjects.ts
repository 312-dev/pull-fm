/**
 * Subject and fixture provisioning.
 *
 * security/BOLA-TESTING.md section 4 names the trap this file exists to avoid,
 * and it is worth restating because it is the reason most BOLA suites are
 * worthless:
 *
 *   GET /v1/wishlist/00000000-...  as subject B  ->  404
 *
 * That 404 is exactly what the gate asks for. It is also what you get when the
 * object does not exist, when the route is not mounted, when the path is
 * misspelled, and when the whole service is returning 404 for everything. A
 * denial is evidence only if the object being denied actually exists and
 * actually belongs to somebody else.
 *
 * So fixtures are created for BOTH subjects, and they are created through the
 * public API wherever the API can create them. The one exception is the
 * connection fixture, which would otherwise require completing an OAuth flow
 * against a third party: it goes through the real connect flow with a mock
 * provider registered in the provider registry, so the row is real, the
 * ownership columns are written by the real code, and no third party is
 * contacted. security/BOLA-TESTING.md calls that exception out too.
 */

import { randomUUID } from "node:crypto";

import type { TestApp } from "./app.js";
import { jsonOf } from "./json.js";
import { FIXTURE_ARTIST_MBID } from "./upstreams.js";

export interface Subject {
  /** Pull.fm user id. */
  readonly id: string;
  readonly workosUserId: string;
  readonly email: string;
  readonly token: string;
  readonly sessionId: string;
}

let counter = 0;

/** Creates a real user and mints a real session token for it. */
export async function provisionSubject(
  ctx: TestApp,
  role = "subject",
): Promise<Subject> {
  counter += 1;
  const suffix = `${String(counter)}_${randomUUID().slice(0, 8)}`;
  const workosUserId = `user_${role}_${suffix}`;
  const email = `${role}.${suffix}@example.test`;

  // The identity has to exist at the provider as well as locally, or any route
  // that reads or writes the profile upstream (PATCH /v1/me) would fail for a
  // reason unrelated to what the test is asserting.
  ctx.workos.register(email, workosUserId);

  const user = await ctx.services.users.upsert({
    workosUserId,
    email,
    displayName: `${role} ${suffix}`,
  });

  const sessionId = `session_${suffix}`;
  const token = await ctx.idp.mint(workosUserId, { sessionId });

  return { id: user.id, workosUserId, email, token, sessionId };
}

export interface Fixtures {
  /** Identifiers that must never appear in another subject's response. */
  readonly markers: string[];
  readonly wishlistItemId: string;
  readonly wishlistCursor: string | null;
  readonly apiTokenId: string;
  readonly apiTokenSecret: string;
  readonly connectState: string;
  readonly exportTicket: string;
  readonly stationId: string;
  readonly feedCursor: string;
}

/**
 * Gives one subject an object of every type the route matrix names.
 *
 * Two wishlist items are created rather than one, because the cursor fixture
 * only exists if there is a second page: a `null` cursor would make the
 * cursor-tampering assertion vacuous.
 */
export async function seedFixtures(
  ctx: TestApp,
  subject: Subject,
): Promise<Fixtures> {
  const inject = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    ctx.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${subject.token}`,
        "idempotency-key": `fixture-${randomUUID()}`,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const first = await inject("POST", "/v1/wishlist", {
    artistName: `Artist ${subject.id.slice(0, 8)}`,
    title: `Title ${subject.id.slice(0, 8)}`,
    recordingMbid: randomUUID(),
  });
  const second = await inject("POST", "/v1/wishlist", {
    artistName: `Second ${subject.id.slice(0, 8)}`,
    title: `Second ${subject.id.slice(0, 8)}`,
    recordingMbid: randomUUID(),
  });
  const wishlistItemId = jsonOf<{ id: string }>(first).id;
  const secondId = jsonOf<{ id: string }>(second).id;

  const page = await inject("GET", "/v1/wishlist?limit=1");
  const wishlistCursor = jsonOf<{ cursor: string | null }>(page).cursor;

  const created = await inject("POST", "/v1/tokens", {
    name: `fixture ${randomUUID().slice(0, 8)}`,
  });
  const issued = jsonOf<{
    token: string;
    tokenRecord: { id: string };
  }>(created);

  // A real connect flow against the mock provider: the state row is written by
  // the real service and the connection is sealed by the real envelope cipher.
  const started = await inject("POST", "/v1/connections/lastfm", {});
  const connectState = new URL(
    jsonOf<{ authorizeUrl: string }>(started).authorizeUrl,
  ).searchParams.get("state");
  await inject("POST", "/v1/connections/listenbrainz", {
    token: `lb_${subject.id}`,
  });

  const exportRequest = await inject("GET", "/v1/me/export");
  // Minting the ticket consumes this subject's export cooldown, which is a rate
  // limit rather than an authorization control and has its own test. Clearing
  // the counter here keeps the BOLA positive control measuring authorization
  // instead of throttling.
  await ctx.services.quotaRedis.del(`quota:user:${subject.id}:export`);
  const exportTicket =
    new URL(
      jsonOf<{ downloadUrl?: string }>(exportRequest).downloadUrl ??
        "http://x/?token=none",
    ).searchParams.get("token") ?? "none";

  // Stations and feed cursors are DERIVED objects: a station is a seed artist
  // plus its owner and a feed cursor is a section offset plus its owner, both
  // signed. There is no row to create, so they are minted through the real
  // service the way the connection fixture goes through the real connect flow.
  // Minting them here rather than reading them off a response is what keeps the
  // BOLA assertions non-vacuous on a cold cache, where /v1/stations legitimately
  // returns nothing.
  const stationId = ctx.services.discovery.stationId(
    subject.id,
    FIXTURE_ARTIST_MBID,
  );
  const feedCursor = ctx.services.discovery.feedCursor(subject.id, 0);

  return {
    markers: [subject.id, wishlistItemId, secondId, issued.tokenRecord.id],
    wishlistItemId,
    wishlistCursor,
    apiTokenId: issued.tokenRecord.id,
    apiTokenSecret: issued.token,
    connectState: connectState ?? "missing-state",
    exportTicket,
    stationId,
    feedCursor,
  };
}

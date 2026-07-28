/**
 * The /v1 API surface.
 *
 * Split per docs/PLAN.md section 6 into a stable platform surface and a
 * volatile product surface. Platform routes (identity, connections, wishlist,
 * deletion, export, config) are the same under every version of this product
 * and are built to the full gate standard. Product routes (feed, stations,
 * recommendations) sit behind a stable response envelope so the ranking
 * algorithm can change completely without breaking the client contract.
 *
 * Handlers are stubbed at this phase. The contract, status codes, and error
 * shapes are the deliverable, because the load suite, the BOLA suite, and the
 * OpenAPI spec are all generated against them.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { errors } from "../lib/errors.js";

/** A feed section. `kind` lets the client render without knowing the algorithm. */
export interface FeedSection {
  kind:
    | "made_for_you"
    | "because_you_like"
    | "daily_mix"
    | "explore_by_mood"
    | "trending"
    | "connections"
    | "rediscover";
  title: string;
  /** Present when the section is seeded by a specific entity. */
  seed?: { mbid: string; name: string };
  items: unknown[];
}

/**
 * The stable feed envelope.
 *
 * `degraded` and `unavailableProviders` are part of the contract from day one:
 * when an upstream circuit breaker is open the feed still returns 200 with
 * fewer sections, and the client needs to be able to say so. Retrofitting this
 * would be a breaking change at exactly the wrong moment.
 */
export interface FeedResponse {
  sections: FeedSection[];
  cursor: string | null;
  degraded: boolean;
  unavailableProviders: string[];
}

/** Marks a route as deliberately unimplemented at this phase. */
function stub(name: string) {
  return (_req: FastifyRequest, _reply: FastifyReply): never => {
    throw errors.notImplemented(
      `${name} is not implemented yet. The contract is stable; the handler lands in a later phase.`,
    );
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function registerV1Routes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Config
  //
  // The highest-leverage endpoint for a mobile client and the one most often
  // forgotten. Old app builds live forever and cannot be force-updated, so the
  // server must be able to tell a client that it is too old, that a provider is
  // degraded, or that maintenance is starting. Costs an hour, saves a release.
  // -------------------------------------------------------------------------
  app.get("/config", () => ({
    minSupportedBuild: 1,
    maintenance: false,
    features: {},
    // Lets the client hide a section rather than render an empty shelf.
    providers: {
      listenbrainz: "ok",
      lastfm: "ok",
      musicbrainz: "ok",
      previews: "ok",
      events: "disabled",
    },
  }));

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------
  app.get("/me", stub("GET /v1/me"));

  /**
   * Account deletion.
   *
   * Required by Apple App Store Guideline 5.1.1(v) for any app offering account
   * creation, and by GDPR/CCPA. Google additionally requires a web-accessible
   * deletion URL reachable without installing the app.
   *
   * The cascade is non-trivial and is why this is a route, not a support email:
   * it must remove the Postgres rows (enforced by ON DELETE CASCADE), the
   * WorkOS identity, cached Redis entries, and it must have a stated position on
   * PITR backups, which retain deleted rows for the WAL window.
   */
  app.delete("/me", stub("DELETE /v1/me"));

  /**
   * Data export (GDPR Article 20 portability).
   *
   * Returns the user's own data only. Deliberately excludes decrypted
   * third-party credentials: exporting them would turn a stolen session into a
   * credential theft, and portability does not require handing back a secret
   * the user can regenerate at the source.
   */
  app.get("/me/export", stub("GET /v1/me/export"));

  // -------------------------------------------------------------------------
  // Connections (the per-user credential vault)
  // -------------------------------------------------------------------------
  app.get("/connections", stub("GET /v1/connections"));
  app.post("/connections/:service", stub("POST /v1/connections/:service"));

  /**
   * OAuth-style callback.
   *
   * Last.fm's flow is request-token then `auth.getSession` via a callback, so a
   * plain POST of a token is not sufficient. This route was missing from the
   * original plan and would have blocked the Last.fm connection entirely.
   */
  app.get(
    "/connections/:service/callback",
    stub("GET /v1/connections/:service/callback"),
  );
  app.delete("/connections/:service", stub("DELETE /v1/connections/:service"));

  // -------------------------------------------------------------------------
  // Wishlist
  // -------------------------------------------------------------------------
  app.get("/wishlist", stub("GET /v1/wishlist"));
  app.post("/wishlist", stub("POST /v1/wishlist"));
  app.delete("/wishlist/:id", stub("DELETE /v1/wishlist/:id"));

  /**
   * Buy links.
   *
   * Pull.fm is non-commercial (plan section 1a), so these carry NO affiliate
   * parameters. An affiliate tag would breach Last.fm, Deezer, and Apple terms
   * simultaneously.
   */
  app.get("/wishlist/:id/acquire", stub("GET /v1/wishlist/:id/acquire"));

  // -------------------------------------------------------------------------
  // Discovery (volatile, behind the envelope)
  // -------------------------------------------------------------------------
  app.get("/feed", stub("GET /v1/feed"));
  app.get("/recommendations", stub("GET /v1/recommendations"));
  app.get("/stations", stub("GET /v1/stations"));
  app.get("/stations/:id/tracks", stub("GET /v1/stations/:id/tracks"));
  app.get("/search", stub("GET /v1/search"));

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------
  app.get("/artists/:mbid", stub("GET /v1/artists/:mbid"));
  app.get("/artists/:mbid/similar", stub("GET /v1/artists/:mbid/similar"));
  app.get("/tracks/:mbid", stub("GET /v1/tracks/:mbid"));
  app.get("/tracks/:mbid/preview", stub("GET /v1/tracks/:mbid/preview"));
  app.get("/albums/:mbid", stub("GET /v1/albums/:mbid"));

  /**
   * Live events: disabled by operator decision.
   *
   * No provider is approved (Bandsintown discontinued its developer API,
   * Ticketmaster signup is blocked, SeatGeek is unapproved). Returns a stable
   * 501 so the client can hide the section, rather than 404 which would be
   * indistinguishable from a bad route.
   */
  app.get("/artists/:mbid/events", () => {
    throw errors.notImplemented(
      "Live events are disabled: no events provider is currently enabled.",
    );
  });

  // -------------------------------------------------------------------------
  // Webhooks
  //
  // Without this, a user deleted at the identity provider leaves orphaned data
  // in our database forever, which is a GDPR problem as much as a correctness one.
  // -------------------------------------------------------------------------
  app.post("/webhooks/workos", stub("POST /v1/webhooks/workos"));
}

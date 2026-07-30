/**
 * The service bundle handed to every route module.
 *
 * Explicit constructor injection rather than a service locator or a module of
 * singletons, for one reason that matters more here than style: the security
 * tests build a real application with a real database and a substituted
 * identity provider (security/BOLA-TESTING.md section 3, option B). That is
 * only possible if the wiring is a parameter.
 */

import type { Redis } from "ioredis";

import type { Config } from "../config.js";
import type { AuditLog } from "../lib/audit.js";
import type { Database } from "../lib/db.js";
import type { SigningKeys } from "../lib/keys.js";
import type { SessionCookieCipher } from "../lib/session-cookie.js";
import type { AuditRetention } from "../services/audit-retention.js";
import type { CacheWarmer } from "../services/cache-warmer.js";
import type { ConnectionService } from "../services/connections.js";
import type { DeletionService } from "../services/deletion.js";
import type { DirectoryReaper } from "../services/directory-reaper.js";
import type { ExpirySweeper } from "../services/expiry-sweeper.js";
import type { DiscoveryService } from "../services/discovery.js";
import type { EventsService } from "../services/events.js";
import type { ExportService } from "../services/export.js";
import type { LegalConsentService } from "../services/legal-consent.js";
import type { MagicAuthService } from "../services/magic-auth.js";
import type { TokenService } from "../services/tokens.js";
import type { UserService } from "../services/users.js";
import type { UpstreamBundle } from "../services/upstream.js";
import type { WishlistService } from "../services/wishlist.js";
import type { WorkOsClient } from "../services/workos.js";
import type { MaintenanceGate } from "../lib/maintenance.js";
import type { Registry } from "../lib/metrics.js";

export interface Services {
  readonly cfg: Config;
  readonly db: Database;
  /**
   * The metrics registry for this process.
   *
   * On the bundle rather than a module singleton so a test can build two
   * applications without their counters bleeding into each other, and so a job
   * container has its own - which matters, because the MusicBrainz pacer's
   * numbers are produced in the job process, not the API one.
   */
  readonly metrics: Registry;
  /**
   * Whether the service is refusing application traffic, and which lever says
   * so. The request hook, `GET /v1/config` and `/metrics` all read THIS, so
   * they cannot disagree.
   */
  readonly maintenance: MaintenanceGate;
  readonly cacheRedis: Redis;
  readonly quotaRedis: Redis;
  readonly keys: SigningKeys;
  /** Seals and opens the session cookie. The browser transport for a session. */
  readonly sessionCookies: SessionCookieCipher;
  readonly audit: AuditLog;
  readonly users: UserService;
  /** Magic-link sign-in: the send and verify budgets, and the timing floor. */
  readonly magicAuth: MagicAuthService;
  /**
   * Deletes unverified WorkOS records that `magic_auth/send` auto-created.
   *
   * On the bundle because the wiring is shared with the scheduled script, NOT
   * because any route may call it. Nothing in routes/ does, and nothing should:
   * it enumerates the entire user directory and deletes identities.
   */
  readonly directoryReaper: DirectoryReaper;
  /**
   * Deletes expired idempotency records and connect states.
   *
   * On the bundle for the same reason as `directoryReaper`: the scheduled
   * entrypoint builds the identical object graph, so the job it runs is the one
   * the tests exercise rather than a second construction of it written next to
   * the scheduler. Never invoked by a route, and nothing in routes/ may: it
   * deletes rows in bulk on a table the request path writes to.
   */
  readonly expirySweeper: ExpirySweeper;
  /**
   * Anonymizes and expires the audit trail.
   *
   * On the bundle for the wiring reason above, NOT because any route may call
   * it. It rewrites and deletes audit rows, which is the one table whose whole
   * value is that the request path cannot edit it.
   */
  readonly auditRetention: AuditRetention;
  /**
   * Fills the MusicBrainz cache and the iTunes preview store ahead of demand.
   *
   * On the bundle for the wiring reason above, and with a second reason of its
   * own: it must be constructed from the same `upstream.previewWarmer` and
   * `discovery` the application uses, or it would warm a different cache than
   * the one requests read. Never invoked by a route. A request that reached it
   * would spend the entire service's per-IP MusicBrainz budget on one render;
   * cache-warmer.test.ts asserts no route can.
   */
  readonly cacheWarmer: CacheWarmer;
  readonly tokens: TokenService;
  readonly connections: ConnectionService;
  readonly wishlist: WishlistService;
  readonly deletion: DeletionService;
  readonly exports: ExportService;
  /**
   * The published legal documents and the recorded acceptances of them.
   *
   * On the bundle because THREE things read it and they must not disagree: the
   * two consent routes, the deletion cascade (which writes the surviving
   * receipt), and - through `Subject.acceptedEpochs` rather than through this
   * object - the gate in plugins/auth.ts. The gate takes the document list
   * separately at plugin registration, because a preValidation hook must not
   * reach into the service bundle to decide whether a request is allowed.
   */
  readonly legal: LegalConsentService;
  readonly workos: WorkOsClient;
  /**
   * Every third-party client, and the cache that fronts them. Exposed on the
   * bundle rather than hidden inside DiscoveryService because `GET /v1/config`
   * reports coarse provider health and because the kill switch has to be
   * reachable without going through a discovery call.
   */
  readonly upstream: UpstreamBundle;
  readonly discovery: DiscoveryService;
  readonly events: EventsService;
}

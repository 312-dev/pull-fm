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
import type { ConnectionService } from "../services/connections.js";
import type { DeletionService } from "../services/deletion.js";
import type { ExportService } from "../services/export.js";
import type { TokenService } from "../services/tokens.js";
import type { UserService } from "../services/users.js";
import type { WishlistService } from "../services/wishlist.js";
import type { WorkOsClient } from "../services/workos.js";

export interface Services {
  readonly cfg: Config;
  readonly db: Database;
  readonly cacheRedis: Redis;
  readonly quotaRedis: Redis;
  readonly keys: SigningKeys;
  readonly audit: AuditLog;
  readonly users: UserService;
  readonly tokens: TokenService;
  readonly connections: ConnectionService;
  readonly wishlist: WishlistService;
  readonly deletion: DeletionService;
  readonly exports: ExportService;
  readonly workos: WorkOsClient;
}

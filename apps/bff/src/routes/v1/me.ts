/**
 * Identity, profile, erasure, and portability.
 *
 * Five routes, two of them legally mandated and one of them irreversible.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "../../lib/errors.js";
import { annotate } from "../../lib/openapi.js";
import { problemResponses } from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import type { Services } from "../deps.js";

export function registerMeRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.get(
    "/me",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:me",
      }),
      schema: {
        operationId: "getMe",
        summary: "The authenticated account",
        description:
          "Readable with a session or with a personal API token holding read:me. The subject is taken from the verified credential; an X-User-Id header or a user_id body field is rejected outright.",
        tags: ["me"],
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              email: { type: ["string", "null"] },
              displayName: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time" },
              authMethod: { type: "string", enum: ["session", "token"] },
              signInMethod: {
                type: "string",
                description:
                  "How this account signs in. Magic link only; see the constraint on users.auth_method in migration 0005 and the reasoning in routes/v1/auth.ts.",
              },
              emailVerifiedAt: { type: ["string", "null"] },
              lastAuthenticatedAt: { type: ["string", "null"] },
              connectionCount: { type: "integer" },
              wishlistCount: { type: "integer" },
            },
            required: ["id", "createdAt", "authMethod", "signInMethod"],
          },
          ...problemResponses(400, 401, 403, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          tokenScope: "read:me",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const { rows } = await services.db.query<{
        connections: string;
        wishlist: string;
      }>(
        `SELECT (SELECT count(*) FROM user_connections WHERE user_id = $1)::text AS connections,
                (SELECT count(*) FROM wishlist_items   WHERE user_id = $1)::text AS wishlist`,
        [subject.userId],
      );
      const counts = rows[0];
      const user = await services.users.findActiveById(subject.userId);
      if (user === null)
        throw errors.unauthorized("The credential is not valid.");

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
        authMethod: subject.method,
        signInMethod: user.authMethod,
        emailVerifiedAt: user.emailVerifiedAt,
        lastAuthenticatedAt: user.lastAuthenticatedAt,
        connectionCount: Number(counts?.connections ?? 0),
        wishlistCount: Number(counts?.wishlist ?? 0),
      };
    },
  );

  /**
   * Updates the profile.
   *
   * Session only, like every other write. A personal API token is read-only,
   * and letting one rename the account would break the asymmetry that makes a
   * leaked token bounded: the display name is what a user recognises their own
   * account by, so an attacker who can change it can disguise the compromise.
   *
   * The write is ordered identity-provider first, local row second, because
   * WorkOS owns the profile and the local row is the read model rendered from
   * it. Failing after the upstream write leaves the local row briefly stale,
   * which the next sign-in repairs; failing in the other order would leave us
   * displaying a name the identity provider rejected, permanently.
   *
   * Ownership is a predicate in the same UPDATE as the id (services/users.ts),
   * so there is no window between deciding the caller owns the row and writing
   * to it, and no id is ever taken from the request.
   */
  app.patch(
    "/me",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "updateMe",
        summary: "Update the account profile",
        description:
          "Session only; personal API tokens are read-only and cannot rename the account they can read. The name is written to the WorkOS User Management API first and mirrored locally only once that succeeds. An empty body is valid and changes nothing, which makes the route safe to call idempotently.",
        tags: ["me"],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            firstName: { type: ["string", "null"], maxLength: 128 },
            lastName: { type: ["string", "null"], maxLength: 128 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              email: { type: ["string", "null"] },
              displayName: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time" },
            },
            required: ["id", "createdAt"],
          },
          ...problemResponses(400, 401, 403, 404, 422, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const patch = request.body as {
        firstName?: string | null;
        lastName?: string | null;
      };

      const touchesName =
        Object.hasOwn(patch, "firstName") || Object.hasOwn(patch, "lastName");

      // Nothing to write. Returning the current profile rather than 400 keeps
      // the route idempotent for a client that retries a no-op patch, which is
      // the mobile-on-a-flaky-network case the whole API is designed around.
      if (!touchesName) {
        const current = await services.users.findActiveById(subject.userId);
        if (current === null) throw errors.notFound();
        return {
          id: current.id,
          email: current.email,
          displayName: current.displayName,
          createdAt: current.createdAt,
        };
      }

      const updated = await services.workos.updateUser(subject.workosUserId, {
        ...(Object.hasOwn(patch, "firstName")
          ? { firstName: normalizeName(patch.firstName) }
          : {}),
        ...(Object.hasOwn(patch, "lastName")
          ? { lastName: normalizeName(patch.lastName) }
          : {}),
      });

      const displayName =
        [updated.firstName, updated.lastName]
          .filter((p): p is string => p !== null && p.length > 0)
          .join(" ") || null;

      const user = await services.users.updateProfile(
        subject.userId,
        displayName,
      );
      // 404, not 403. The row is gone (a deletion that raced this request), and
      // the two are deliberately indistinguishable everywhere in this API so a
      // response cannot be used to learn which ids exist.
      if (user === null) throw errors.notFound();

      await services.audit.record({
        userId: user.id,
        action: "account.profile_updated",
        outcome: "ok",
        ip: request.ip,
      });

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt,
      };
    },
  );

  /**
   * Account deletion.
   *
   * Required by GDPR Article 17 and CCPA regardless of distribution channel
   * (docs/PLAN.md open decision 6 retired the store requirements but explicitly
   * kept this one). It is the only irreversible operation in the API, so it
   * carries three gates that no other route does:
   *
   *   1. **Session only.** A personal API token is read-only and cannot reach
   *      this route at all. A leaked read token must not be able to destroy the
   *      account it can read.
   *   2. **Fresh authentication** (THREAT-MODEL M16). The credential must have
   *      been issued recently, so a long-lived token found in a log or a shell
   *      history cannot delete an account months later.
   *   3. **Explicit confirmation of the account email in the body.** A
   *      confirmation that requires knowing the address is a deliberate act;
   *      a bare DELETE is a misclick.
   *
   * Note that CSRF is structurally impossible here: authentication is a bearer
   * token, never a cookie, so a cross-site form post carries no credential. M16
   * asks for a fresh-auth proof "that is not a cookie", and the whole scheme
   * satisfies that.
   */
  app.delete(
    "/me",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "deleteMe",
        summary: "Delete the account and everything derived from it",
        description:
          "Irreversible. Removes all Postgres rows via ON DELETE CASCADE in one transaction, deletes the WorkOS identity, and clears cache and quota keys for the subject. Backups are not rewritten; see the documented retention position in docs/api/deletion-and-backups.md. Requires a session issued recently and confirmation of the account email.",
        tags: ["me"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["confirm"],
          properties: {
            confirm: {
              type: "string",
              maxLength: 320,
              description:
                "The email address on the account, typed back. Deliberate friction on an irreversible action.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              deleted: { type: "boolean" },
              rowsDeleted: { type: "object", additionalProperties: true },
              identityProviderDeleted: { type: "boolean" },
              backupRetentionNotice: { type: "string" },
            },
            required: [
              "deleted",
              "identityProviderDeleted",
              "backupRetentionNotice",
            ],
          },
          ...problemResponses(400, 401, 403, 422, 429),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const body = request.body as { confirm: string };

      const ageSeconds =
        Math.floor(Date.now() / 1000) - subject.authenticatedAt;
      if (ageSeconds > services.cfg.DELETE_FRESH_AUTH_MAX_AGE_S) {
        throw errors.forbidden(
          "Sign in again before deleting the account. This action requires a recently issued session.",
        );
      }

      // Case-insensitive because the stored column is citext and because
      // rejecting on capitalisation is friction with no security value.
      const expected = subject.email?.toLowerCase() ?? null;
      if (expected === null || body.confirm.trim().toLowerCase() !== expected) {
        throw errors.unprocessable(
          "The confirmation does not match the email address on this account.",
        );
      }

      const outcome = await services.deletion.deleteAccount(
        subject.userId,
        subject.workosUserId,
      );

      await services.audit.record({
        userId: subject.userId,
        action: "account.deleted",
        outcome: "ok",
        detail: {
          rowsDeleted: outcome.rowsDeleted,
          workosDeleted: outcome.workosDeleted,
        },
        ip: request.ip,
      });

      return {
        deleted: true,
        rowsDeleted: outcome.rowsDeleted,
        identityProviderDeleted: outcome.workosDeleted,
        backupRetentionNotice: BACKUP_NOTICE,
      };
    },
  );

  /**
   * Requests a data export (GDPR Article 20).
   *
   * Returns a ticket, not the document. See services/export.ts for why: a
   * complete personal-data document returned synchronously on a GET is both a
   * self-service denial of service and the most sensitive response body in the
   * system sitting on the route most likely to be cached by something.
   */
  app.get(
    "/me/export",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "requestExport",
        summary: "Request a portable copy of your data",
        description:
          "Returns a single-use, subject-bound download link valid for a few minutes. The export excludes decrypted third-party credentials: portability does not require handing back a bearer secret the user can regenerate at the source, and including it would turn a stolen session into a third-party account compromise.",
        tags: ["me"],
        response: {
          202: {
            type: "object",
            properties: {
              downloadUrl: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              excludes: { type: "array", items: { type: "string" } },
            },
            required: ["downloadUrl", "expiresAt", "excludes"],
          },
          ...problemResponses(401, 403, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const ticket = await services.exports.requestExport(subject.userId);
      await services.audit.record({
        userId: subject.userId,
        action: "account.export_requested",
        outcome: "ok",
        ip: request.ip,
      });
      return reply.code(202).send({
        downloadUrl: ticket.downloadUrl,
        expiresAt: ticket.expiresAt,
        excludes: [
          "third-party access tokens",
          "third-party refresh tokens",
          "Last.fm session keys",
          "API token secrets and their digests",
          "envelope encryption material (wrapped DEKs, KEK ids)",
        ],
      });
    },
  );

  /**
   * Downloads the export.
   *
   * Session-bound AND single-use. Either alone is weaker than the pair: a
   * single-use link that leaks into a referrer header is still usable by
   * whoever receives it first, and a session-bound link that is not single-use
   * is a repeatable database scan.
   */
  app.get(
    "/me/export/download",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "downloadExport",
        summary: "Download a previously requested export",
        description:
          "Consumes the ticket atomically. A ticket minted for another subject is rejected with the same 400 as an expired or already-used one, so the response cannot be used to probe whether a ticket was ever valid.",
        tags: ["me"],
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", maxLength: 512 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              format: { type: "string" },
              formatVersion: { type: "integer" },
              generatedAt: { type: "string", format: "date-time" },
              notice: { type: "string" },
              account: { type: ["object", "null"], additionalProperties: true },
              connections: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              wishlist: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              apiTokens: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
            required: ["format", "formatVersion", "generatedAt", "notice"],
          },
          ...problemResponses(400, 401, 403, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "exclude",
          bola: {
            strategy: "query-param",
            objectType: "export_ticket",
            param: "token",
            deny: [400, 403],
          },
        }),
      },
    },
    async (request, reply) => {
      const subject = subjectOf(request);
      const { token } = request.query as { token: string };
      await services.exports.consumeTicket(subject.userId, token);
      const document = await services.exports.build(subject.userId);
      await services.audit.record({
        userId: subject.userId,
        action: "account.export_downloaded",
        outcome: "ok",
        ip: request.ip,
      });
      return (
        reply
          .header(
            "content-disposition",
            `attachment; filename="pullfm-export-${subject.userId}.json"`,
          )
          // The one response in the API that must never be stored by anything.
          .header("cache-control", "no-store")
          .send(document)
      );
    },
  );
}

/**
 * Trims a supplied name, mapping "cleared" and "blank" onto the same null.
 *
 * A name of spaces is not a name, and storing one produces an account that
 * renders as empty while claiming to have a display name.
 */
function normalizeName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const BACKUP_NOTICE =
  "Your account and all data derived from it have been deleted from the live database and from the " +
  "identity provider. Encrypted backups are retained for the documented point-in-time-recovery window " +
  "and are not selectively rewritten, because rewriting a backup destroys the integrity that makes it " +
  "useful. Backups are encrypted, access-controlled, never queried for live traffic, and any restore " +
  "replays the deletion log before serving traffic, so this deletion survives a restore.";

export { BACKUP_NOTICE };

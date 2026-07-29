/**
 * @pull-fm/discovery - the blend.
 *
 * ListenBrainz is the backbone, Last.fm is thin enrichment, and MusicBrainz
 * supplies the names (docs/PLAN.md section 1). The package defines its own
 * ports rather than depending on @pull-fm/upstream, so the ranking logic can
 * be tested without an HTTP layer and cannot bypass the BFF's cache.
 */

export * from "./envelope.js";
export * from "./identity.js";
export * from "./merge.js";
export * from "./ports.js";
export * from "./blend.js";

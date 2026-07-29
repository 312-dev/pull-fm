/**
 * Dedup and cross-source ranking.
 *
 * THE RULE THAT MATTERS: cross-source agreement is a BOOST, not a filter.
 *
 * Requiring two sources to agree before showing a track sounds like quality
 * control and is actually the opposite. ListenBrainz's collaborative filter is
 * the only source that knows anything about *this user*; Last.fm's similarity
 * graph knows about popularity. Intersecting them throws away every personal
 * recommendation that is not also broadly popular, which is precisely the
 * material a discovery feed exists to surface. So everything survives, and
 * agreement moves an item up.
 *
 * The boost is sublinear (1 + log2(sources)) so that a third and fourth source
 * cannot overwhelm a strong first-source score. A track the CF model is certain
 * about should outrank a mediocre track that three sources mention.
 */

import type { Attribution } from "./envelope.js";
import { artistIdentity, trackIdentity } from "./identity.js";

export interface Candidate {
  readonly identity: string;
  readonly source: string;
  /** 0-1 within its own source. Sources are normalised by their adapters. */
  readonly score: number;
  readonly attribution?: Attribution | undefined;
}

export interface TrackCandidate extends Candidate {
  readonly kind: "track";
  readonly title: string;
  readonly artistName: string;
  readonly recordingMbid: string | undefined;
  readonly artistMbid: string | undefined;
}

export interface ArtistCandidate extends Candidate {
  readonly kind: "artist";
  readonly name: string;
  readonly artistMbid: string | undefined;
}

export interface MergedTrack {
  readonly identity: string;
  readonly title: string;
  readonly artistName: string;
  readonly recordingMbid: string | undefined;
  readonly artistMbid: string | undefined;
  readonly score: number;
  readonly sources: readonly string[];
  readonly attribution: readonly Attribution[];
}

export interface MergedArtist {
  readonly identity: string;
  readonly name: string;
  readonly artistMbid: string | undefined;
  readonly score: number;
  readonly sources: readonly string[];
  readonly attribution: readonly Attribution[];
}

export function makeTrackCandidate(args: {
  source: string;
  score: number;
  title: string;
  artistName: string;
  recordingMbid?: string | undefined;
  artistMbid?: string | undefined;
  attribution?: Attribution | undefined;
}): TrackCandidate {
  return {
    kind: "track",
    identity: trackIdentity(args.artistName, args.title),
    source: args.source,
    score: args.score,
    title: args.title,
    artistName: args.artistName,
    recordingMbid: args.recordingMbid,
    artistMbid: args.artistMbid,
    attribution: args.attribution,
  };
}

export function makeArtistCandidate(args: {
  source: string;
  score: number;
  name: string;
  artistMbid?: string | undefined;
  attribution?: Attribution | undefined;
}): ArtistCandidate {
  return {
    kind: "artist",
    identity: artistIdentity(args.name),
    source: args.source,
    score: args.score,
    name: args.name,
    artistMbid: args.artistMbid,
    attribution: args.attribution,
  };
}

/** 1 for one source, ~1.58 for two, ~2 for three. Sublinear on purpose. */
export function agreementBoost(sourceCount: number): number {
  return sourceCount <= 1 ? 1 : 1 + Math.log2(sourceCount);
}

function mergeAttribution(
  existing: Attribution[],
  next: Attribution | undefined,
): Attribution[] {
  if (next === undefined) return existing;
  const already = existing.some(
    (a) => a.source === next.source && a.url === next.url,
  );
  return already ? existing : [...existing, next];
}

export function mergeTracks(
  candidates: readonly TrackCandidate[],
): MergedTrack[] {
  const byIdentity = new Map<
    string,
    {
      best: TrackCandidate;
      bestScore: number;
      sources: Set<string>;
      attribution: Attribution[];
      /** Highest score seen from any single source. */
      peak: number;
    }
  >();

  for (const c of candidates) {
    if (c.identity === "") continue;
    const entry = byIdentity.get(c.identity);
    if (entry === undefined) {
      byIdentity.set(c.identity, {
        best: c,
        bestScore: c.score,
        sources: new Set([c.source]),
        attribution: mergeAttribution([], c.attribution),
        peak: c.score,
      });
      continue;
    }
    entry.sources.add(c.source);
    entry.attribution = mergeAttribution(entry.attribution, c.attribution);
    entry.peak = Math.max(entry.peak, c.score);
    // Keep the richest representation, not merely the highest-scoring one: an
    // MBID from a weaker source is still the MBID everything else needs.
    if (
      c.score > entry.bestScore ||
      (entry.best.recordingMbid === undefined && c.recordingMbid !== undefined)
    ) {
      entry.best = {
        ...c,
        recordingMbid: c.recordingMbid ?? entry.best.recordingMbid,
        artistMbid: c.artistMbid ?? entry.best.artistMbid,
      };
      entry.bestScore = Math.max(entry.bestScore, c.score);
    }
  }

  const out: MergedTrack[] = [];
  for (const [identity, entry] of byIdentity) {
    out.push({
      identity,
      title: entry.best.title,
      artistName: entry.best.artistName,
      recordingMbid: entry.best.recordingMbid,
      artistMbid: entry.best.artistMbid,
      score: entry.peak * agreementBoost(entry.sources.size),
      sources: [...entry.sources].sort(),
      attribution: entry.attribution,
    });
  }
  out.sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
  return out;
}

export function mergeArtists(
  candidates: readonly ArtistCandidate[],
): MergedArtist[] {
  const byIdentity = new Map<
    string,
    {
      name: string;
      artistMbid: string | undefined;
      peak: number;
      sources: Set<string>;
      attribution: Attribution[];
    }
  >();

  for (const c of candidates) {
    if (c.identity === "") continue;
    const entry = byIdentity.get(c.identity);
    if (entry === undefined) {
      byIdentity.set(c.identity, {
        name: c.name,
        artistMbid: c.artistMbid,
        peak: c.score,
        sources: new Set([c.source]),
        attribution: mergeAttribution([], c.attribution),
      });
      continue;
    }
    entry.sources.add(c.source);
    entry.attribution = mergeAttribution(entry.attribution, c.attribution);
    entry.peak = Math.max(entry.peak, c.score);
    entry.artistMbid = entry.artistMbid ?? c.artistMbid;
  }

  const out: MergedArtist[] = [];
  for (const [identity, entry] of byIdentity) {
    out.push({
      identity,
      name: entry.name,
      artistMbid: entry.artistMbid,
      score: entry.peak * agreementBoost(entry.sources.size),
      sources: [...entry.sources].sort(),
      attribution: entry.attribution,
    });
  }
  out.sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
  return out;
}

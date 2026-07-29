/**
 * Feed assembly.
 *
 * SHAPE OF THE BLEND (docs/PLAN.md: ListenBrainz primary, Last.fm thin):
 *
 *   made_for_you     ListenBrainz collaborative filter. The only source that
 *                    knows anything about this specific user.
 *   because_you_like ListenBrainz artist radio, seeded from the user's top
 *                    artists, enriched with Last.fm similar tracks.
 *   connections      Similar artists, from ListenBrainz labs and Last.fm, where
 *                    agreement between the two moves an artist up.
 *   daily_mix        The playlists ListenBrainz already generates for the user.
 *
 * FAILURE IS A FIRST-CLASS OUTCOME. Every section is built independently and
 * settled independently: one provider being down removes one shelf and sets
 * `degraded`, it does not fail the request. That is why `degraded` and
 * `unavailableProviders` are in the envelope from day one rather than being
 * retrofitted during an incident.
 *
 * There is no `rediscover` section yet: it needs listening history with
 * recency, and inventing it from the data we have would produce a shelf whose
 * title is a lie.
 */

import type {
  Attribution,
  FeedArtistItem,
  FeedPlaylistItem,
  SectionsEnvelope,
  FeedSection,
  FeedTrackItem,
} from "./envelope.js";
import type { DiscoveryPorts, TrackRef } from "./ports.js";
import {
  makeArtistCandidate,
  makeTrackCandidate,
  mergeArtists,
  mergeTracks,
} from "./merge.js";
import type { ArtistCandidate, TrackCandidate } from "./merge.js";

export const SOURCE_LB_CF = "listenbrainz:cf";
export const SOURCE_LB_RADIO = "listenbrainz:lb-radio";
export const SOURCE_LB_LABS = "listenbrainz:labs-similar";
export const SOURCE_LB_PLAYLIST = "listenbrainz:createdfor";
export const SOURCE_LASTFM_SIMILAR = "lastfm:similar";

const LISTENBRAINZ_ATTRIBUTION: Attribution = {
  source: "listenbrainz",
  text: "Recommendations by ListenBrainz",
  url: "https://listenbrainz.org",
};

/**
 * Last.fm's terms require their specified `last.fm/music/[artist]` link, so
 * the per-item URL is carried when the provider supplied one. `url` is omitted
 * rather than set to undefined: the envelope marks it optional and the
 * repository compiles with exactOptionalPropertyTypes.
 */
function lastfmAttribution(url: string | undefined): Attribution {
  return {
    source: "lastfm",
    text: "Data provided by Last.fm",
    ...(url === undefined ? {} : { url }),
  };
}

export interface BlendOptions {
  /** Items per section. */
  readonly limit?: number;
  /** How many top artists seed `because_you_like`. Each costs an API call. */
  readonly seedArtists?: number;
  /** Enrich with Last.fm. Off when the kill switch or the cache cap says so. */
  readonly enableLastfm?: boolean;
}

interface SectionOutcome {
  /** Zero, one, or several shelves. A builder that has nothing returns []. */
  readonly sections: readonly FeedSection[];
  readonly failedProviders: readonly string[];
}

export async function buildFeed(
  ports: DiscoveryPorts,
  opts: BlendOptions = {},
): Promise<SectionsEnvelope> {
  const limit = opts.limit ?? 20;
  const seedCount = opts.seedArtists ?? 2;
  const useLastfm = opts.enableLastfm !== false && ports.lastfm !== undefined;

  // Top artists seed two sections, so it is fetched once and shared. A failure
  // here degrades those sections rather than the whole feed.
  let topArtists: Awaited<
    ReturnType<DiscoveryPorts["listenbrainz"]["topArtists"]>
  > = [];
  let topArtistsFailed = false;
  try {
    topArtists = await ports.listenbrainz.topArtists(Math.max(seedCount, 5));
  } catch {
    topArtistsFailed = true;
  }

  const builders: Promise<SectionOutcome>[] = [
    madeForYou(ports, limit),
    becauseYouLike(ports, topArtists, seedCount, limit, useLastfm),
    connections(ports, topArtists, limit, useLastfm),
    dailyMix(ports),
  ];

  const settled = await Promise.allSettled(builders);
  const sections: FeedSection[] = [];
  const unavailable = new Set<string>(topArtistsFailed ? ["listenbrainz"] : []);

  for (const result of settled) {
    if (result.status === "rejected") {
      // A builder that throws rather than reporting is a bug, but the feed
      // still has to render, so it degrades like any other failure.
      unavailable.add("unknown");
      continue;
    }
    for (const p of result.value.failedProviders) unavailable.add(p);
    sections.push(...result.value.sections);
  }

  return {
    sections,
    cursor: null,
    degraded: unavailable.size > 0,
    unavailableProviders: [...unavailable].sort(),
    // Provider-level attribution for the response as a whole. Per-item links
    // stay on the items, because Last.fm's required format is per artist.
    attribution: collectAttribution(sections),
  };
}

/** One entry per contributing provider, deduplicated by source. */
function collectAttribution(sections: readonly FeedSection[]): Attribution[] {
  const bySource = new Map<string, Attribution>();
  for (const section of sections) {
    for (const item of section.items) {
      const links = (item as { attribution?: readonly Attribution[] })
        .attribution;
      if (links === undefined) continue;
      for (const link of links) {
        if (bySource.has(link.source)) continue;
        bySource.set(link.source, { source: link.source, text: link.text });
      }
    }
  }
  return [...bySource.values()].sort((a, b) =>
    a.source.localeCompare(b.source),
  );
}

/** ListenBrainz collaborative filter, hydrated into displayable tracks. */
async function madeForYou(
  ports: DiscoveryPorts,
  limit: number,
): Promise<SectionOutcome> {
  let recs;
  try {
    recs = await ports.listenbrainz.recommendedRecordings(limit * 2);
  } catch {
    return { sections: [], failedProviders: ["listenbrainz"] };
  }
  if (recs.length === 0) return { sections: [], failedProviders: [] };

  let hydrated = new Map<string, TrackRef>();
  try {
    hydrated = await ports.hydrate.hydrateRecordings(
      recs.map((r) => r.recordingMbid),
    );
  } catch {
    // Without names there is nothing to render, and MusicBrainz is 1 req/s so
    // a synchronous retry is not available. The shelf disappears.
    return { sections: [], failedProviders: ["musicbrainz"] };
  }

  const candidates: TrackCandidate[] = [];
  for (const rec of recs) {
    const track = hydrated.get(rec.recordingMbid);
    if (track === undefined) continue;
    candidates.push(
      makeTrackCandidate({
        source: SOURCE_LB_CF,
        score: rec.score,
        title: track.title,
        artistName: track.artistName,
        recordingMbid: track.recordingMbid,
        artistMbid: track.artistMbid,
        attribution: LISTENBRAINZ_ATTRIBUTION,
      }),
    );
  }
  const items = mergeTracks(candidates).slice(0, limit).map(toTrackItem);
  if (items.length === 0) return { sections: [], failedProviders: [] };
  return {
    sections: [{ kind: "made_for_you", title: "Made for you", items }],
    failedProviders: [],
  };
}

/**
 * Artist radio around the user's top artists, enriched by Last.fm.
 *
 * One shelf per seed artist, because a single merged "because you like"
 * section would blend two artists' neighbourhoods into a shelf whose title
 * cannot be true. Each seed costs one ListenBrainz call, which is why the
 * count is a bounded option rather than "all top artists".
 */
async function becauseYouLike(
  ports: DiscoveryPorts,
  topArtists: readonly { artistMbid: string | undefined; artistName: string }[],
  seedCount: number,
  limit: number,
  useLastfm: boolean,
): Promise<SectionOutcome> {
  const seeds = topArtists
    .filter(
      (a): a is { artistMbid: string; artistName: string } =>
        a.artistMbid !== undefined,
    )
    .slice(0, seedCount);
  if (seeds.length === 0) return { sections: [], failedProviders: [] };

  const failed = new Set<string>();
  const sections: FeedSection[] = [];

  for (const seed of seeds) {
    const candidates: TrackCandidate[] = [];
    try {
      for (const track of await ports.listenbrainz.artistRadio(
        seed.artistMbid,
      )) {
        candidates.push(
          makeTrackCandidate({
            source: SOURCE_LB_RADIO,
            score: track.similarity,
            title: track.recordingName,
            artistName: track.artistName,
            recordingMbid: track.recordingMbid,
            artistMbid: track.artistMbid,
            attribution: LISTENBRAINZ_ATTRIBUTION,
          }),
        );
      }
    } catch {
      failed.add("listenbrainz");
      continue;
    }

    const top = candidates[0];
    if (useLastfm && ports.lastfm !== undefined && top !== undefined) {
      try {
        // One call per shelf, seeded by the strongest ListenBrainz result.
        // Last.fm is enrichment; its 100 MB cache cap is what keeps it thin.
        for (const t of await ports.lastfm.similarTracks(
          top.artistName,
          top.title,
        )) {
          candidates.push(
            makeTrackCandidate({
              source: SOURCE_LASTFM_SIMILAR,
              score: t.score,
              title: t.title,
              artistName: t.artistName,
              recordingMbid: t.recordingMbid,
              attribution: lastfmAttribution(t.url),
            }),
          );
        }
      } catch {
        failed.add("lastfm");
      }
    }

    const items = mergeTracks(candidates).slice(0, limit).map(toTrackItem);
    if (items.length === 0) continue;
    sections.push({
      kind: "because_you_like",
      title: `Because you like ${seed.artistName}`,
      seed: { mbid: seed.artistMbid, name: seed.artistName },
      items,
    });
  }

  return { sections, failedProviders: [...failed] };
}

/** Similar artists. The section where cross-source agreement matters most. */
async function connections(
  ports: DiscoveryPorts,
  topArtists: readonly { artistMbid: string | undefined; artistName: string }[],
  limit: number,
  useLastfm: boolean,
): Promise<SectionOutcome> {
  const seed = topArtists[0];
  if (seed === undefined) return { sections: [], failedProviders: [] };

  const failed = new Set<string>();
  const candidates: ArtistCandidate[] = [];

  if (seed.artistMbid !== undefined) {
    // labs.api has no SLA; its port returns [] rather than throwing, so a labs
    // outage silently contributes nothing instead of degrading the feed.
    for (const a of await ports.listenbrainz.similarArtists(seed.artistMbid)) {
      candidates.push(
        makeArtistCandidate({
          source: SOURCE_LB_LABS,
          score: a.score,
          name: a.name,
          artistMbid: a.artistMbid,
          attribution: LISTENBRAINZ_ATTRIBUTION,
        }),
      );
    }
  }

  if (useLastfm && ports.lastfm !== undefined) {
    try {
      for (const a of await ports.lastfm.similarArtists(seed.artistName)) {
        candidates.push(
          makeArtistCandidate({
            source: SOURCE_LASTFM_SIMILAR,
            score: a.score,
            name: a.name,
            artistMbid: a.artistMbid,
            attribution: lastfmAttribution(a.url),
          }),
        );
      }
    } catch {
      failed.add("lastfm");
    }
  }

  const items: FeedArtistItem[] = mergeArtists(candidates)
    .slice(0, limit)
    .map((a) => ({
      type: "artist",
      artistMbid: a.artistMbid,
      name: a.name,
      score: a.score,
      sources: a.sources,
      attribution: a.attribution,
    }));
  if (items.length === 0) {
    return { sections: [], failedProviders: [...failed] };
  }
  return {
    sections: [
      {
        kind: "connections",
        title: `Artists connected to ${seed.artistName}`,
        ...(seed.artistMbid === undefined
          ? {}
          : { seed: { mbid: seed.artistMbid, name: seed.artistName } }),
        items,
      },
    ],
    failedProviders: [...failed],
  };
}

/** The playlists ListenBrainz already builds for the user (Weekly Discovery). */
async function dailyMix(ports: DiscoveryPorts): Promise<SectionOutcome> {
  let playlists;
  try {
    playlists = await ports.listenbrainz.createdForPlaylists();
  } catch {
    return { sections: [], failedProviders: ["listenbrainz"] };
  }
  if (playlists.length === 0) return { sections: [], failedProviders: [] };

  const items: FeedPlaylistItem[] = playlists.map((p) => ({
    type: "playlist",
    identifier: p.identifier,
    title: p.title,
    description: p.annotation,
    sources: [SOURCE_LB_PLAYLIST],
    attribution: [LISTENBRAINZ_ATTRIBUTION],
  }));
  return {
    sections: [{ kind: "daily_mix", title: "Your mixes", items }],
    failedProviders: [],
  };
}

function toTrackItem(track: {
  title: string;
  artistName: string;
  recordingMbid: string | undefined;
  artistMbid: string | undefined;
  score: number;
  sources: readonly string[];
  attribution: readonly Attribution[];
}): FeedTrackItem {
  return {
    type: "track",
    recordingMbid: track.recordingMbid,
    title: track.title,
    artistName: track.artistName,
    artistMbid: track.artistMbid,
    score: track.score,
    sources: track.sources,
    attribution: track.attribution,
  };
}

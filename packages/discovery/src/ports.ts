/**
 * The ports the blend needs, defined here rather than imported from
 * @pull-fm/upstream.
 *
 * Dependency inversion, for two concrete reasons rather than tidiness:
 *
 *   1. The blend must be testable without an HTTP layer at all. Every test in
 *      this package drives a plain object; none can accidentally reach a real
 *      provider, which is a rule the upstream terms make non-negotiable.
 *   2. Cache-first is the BFF's job. These ports are what the BFF implements
 *      over the cached clients, so the blend cannot bypass the cache even by
 *      mistake - it has no way to make an HTTP call.
 *
 * The shapes match what @pull-fm/upstream's clients already return, so the
 * adapter in the BFF is a pass-through rather than a translation layer.
 */

export interface RecordingRecommendationRef {
  readonly recordingMbid: string;
  readonly score: number;
}

export interface RadioTrackRef {
  readonly recordingMbid: string;
  readonly recordingName: string;
  readonly artistMbid: string | undefined;
  readonly artistName: string;
  readonly similarity: number;
}

export interface ArtistListenRef {
  readonly artistMbid: string | undefined;
  readonly artistName: string;
  readonly listenCount: number;
}

export interface SimilarArtistRef {
  readonly artistMbid: string | undefined;
  readonly name: string;
  /** 0-1 after normalisation by the adapter. */
  readonly score: number;
  /** Attribution link, mandatory for Last.fm. */
  readonly url?: string | undefined;
}

export interface PlaylistRef {
  readonly identifier: string;
  readonly title: string;
  readonly annotation: string | undefined;
}

export interface TrackRef {
  readonly recordingMbid: string;
  readonly title: string;
  readonly artistName: string;
  readonly artistMbid: string | undefined;
}

export interface SimilarTrackRef {
  readonly title: string;
  readonly artistName: string;
  readonly recordingMbid: string | undefined;
  readonly score: number;
  readonly url?: string | undefined;
}

/** ListenBrainz: the backbone. Only endpoints verified working are here. */
export interface ListenBrainzPort {
  recommendedRecordings(limit: number): Promise<RecordingRecommendationRef[]>;
  topArtists(limit: number): Promise<ArtistListenRef[]>;
  artistRadio(artistMbid: string): Promise<RadioTrackRef[]>;
  createdForPlaylists(): Promise<PlaylistRef[]>;
  /** labs.api tier, no SLA. Implementations return [] on failure. */
  similarArtists(artistMbid: string): Promise<SimilarArtistRef[]>;
}

/**
 * Last.fm: thin enrichment ONLY.
 *
 * Optional at the type level because the whole layer must be removable: their
 * terms cap cached data at 100 MB and permit non-commercial use only, so the
 * design has to survive Last.fm being switched off at runtime.
 */
export interface LastfmPort {
  similarArtists(artistName: string): Promise<SimilarArtistRef[]>;
  similarTracks(artistName: string, title: string): Promise<SimilarTrackRef[]>;
}

/**
 * MBID -> display metadata.
 *
 * Separate port because this is where MusicBrainz's 1 req/s ceiling lives. The
 * BFF implements it cache-first over `upstream_cache` and the crosswalk, so
 * the blend can ask for fifty MBIDs without the blend knowing that forty-nine
 * of them had better already be cached.
 */
export interface HydrationPort {
  hydrateRecordings(
    recordingMbids: readonly string[],
  ): Promise<Map<string, TrackRef>>;
}

export interface DiscoveryPorts {
  readonly listenbrainz: ListenBrainzPort;
  readonly lastfm?: LastfmPort | undefined;
  readonly hydrate: HydrationPort;
}

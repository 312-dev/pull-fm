/**
 * Registration geo-refusal: the EEA, the United Kingdom and Switzerland.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHY IT IS A CONTROL RATHER THAN A PREFERENCE
 *
 * Pull.fm serves the United States. The owner's decision (2026-07-29) is that
 * the service does not accept the obligations that attach to holding a European
 * resident's personal data: infrastructure leaves the EU, the legal documents
 * are US-shaped, and no account is opened for a person in the EEA, the UK or
 * Switzerland. This module is the third of those. It is the piece that turns a
 * position in a document into a fact about the running system, so it has to be
 * right about two things that are easy to get wrong: WHICH countries, and
 * WHETHER THE ANSWER CAN BE FORGED.
 *
 * ---------------------------------------------------------------------------
 * THE GEOGRAPHY, WHICH IS THE PART PEOPLE GET WRONG
 *
 * "Block the EU" is wrong three times over and each mistake leaves a real
 * obligation open:
 *
 *   The EEA is 30 countries, not 27. Iceland, Liechtenstein and Norway are not
 *   EU member states and the GDPR applies to them anyway, through the EEA
 *   Agreement. A list built from an EU membership table silently omits them.
 *
 *   The United Kingdom left the EU and took the regulation with it. UK GDPR
 *   plus the Data Protection Act 2018 is a separate regime with its own
 *   regulator, and GB is in no EU or EEA list anywhere.
 *
 *   Switzerland is in neither, and has the revised FADP, which is close enough
 *   to the GDPR in effect that the same reasoning applies.
 *
 * The codes below are ISO 3166-1 alpha-2, which is the vocabulary Cloudflare's
 * CF-IPCountry speaks, so no translation table sits between the decision and
 * the enforcement. Two traps in that vocabulary are worth naming because both
 * have shipped as bugs in other people's blocklists:
 *
 *   Greece is GR. `EL` is the European Commission's own house style and is not
 *   an ISO 3166-1 code at all; Cloudflare will never send it.
 *   The United Kingdom is GB. `UK` is not an ISO 3166-1 code either.
 *
 * ---------------------------------------------------------------------------
 * ONE LIST, READ BY BOTH THE ENFORCEMENT AND THE TESTS
 *
 * `RESTRICTED_COUNTRIES` is the only place any of this is written down. The
 * route imports it and the suite imports it and iterates it, rather than
 * restating a list that would then be free to drift. A country added here is a
 * country the tests immediately assert on; there is no second copy to forget.
 */

/**
 * The EEA, all 30, by name, so the next reader can audit the list without
 * leaving the file.
 *
 * EU 27:
 *   AT Austria        BE Belgium        BG Bulgaria       HR Croatia
 *   CY Cyprus         CZ Czechia        DK Denmark        EE Estonia
 *   FI Finland        FR France         DE Germany        GR Greece
 *   HU Hungary        IE Ireland        IT Italy          LV Latvia
 *   LT Lithuania      LU Luxembourg     MT Malta          NL Netherlands
 *   PL Poland         PT Portugal       RO Romania        SK Slovakia
 *   SI Slovenia       ES Spain          SE Sweden
 *
 * EEA-but-not-EU 3 (EFTA states party to the EEA Agreement):
 *   IS Iceland        LI Liechtenstein  NO Norway
 *
 * Switzerland is EFTA but NOT party to the EEA Agreement, which is exactly why
 * it is in its own group below and not smuggled in here.
 */
// The grid below mirrors the named table above, which is what makes the list
// auditable by eye against a published source. One code per line is 30 lines of
// noise that nobody proof-reads.
// prettier-ignore
const EEA_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
] as const;

/**
 * The two non-EEA regimes this refusal also covers, each for its own reason.
 *
 *   GB  UK GDPR and the Data Protection Act 2018. Blocking "the EU" does not
 *       touch it, and the UK regulator has its own enforcement powers.
 *   CH  The revised Federal Act on Data Protection. Not EEA, not EU, and close
 *       enough to the GDPR in the obligations it creates that accepting a Swiss
 *       account would reopen the question this whole posture exists to close.
 */
const UK_AND_SWITZERLAND = ["GB", "CH"] as const;

/**
 * EU TERRITORY THAT CLOUDFLARE REPORTS UNDER ITS OWN ISO CODE.
 *
 * This group is a judgement call and is kept separate so it can be reversed by
 * deleting one array rather than by unpicking the list above.
 *
 * The GDPR's territorial scope is EU TERRITORY, not EU member-state mainland,
 * and several territories that are legally part of an EU member state carry a
 * distinct ISO 3166-1 alpha-2 code. Cloudflare geolocates to that distinct
 * code, so a request from Reunion arrives as `RE` and NOT as `FR`. A list of
 * member states alone therefore admits residents the regulation covers:
 *
 *   AX  Aland Islands. Part of Finland, in the EU, GDPR applies.
 *   GF  French Guiana    ) The five French outermost regions. All are EU
 *   GP  Guadeloupe       ) territory under TFEU Article 349, all are integral
 *   MQ  Martinique       ) parts of France, and all have their own ISO code
 *   RE  Reunion          ) that Cloudflare reports instead of FR.
 *   YT  Mayotte          )
 *   MF  Saint Martin. The French half; also an outermost region.
 *
 * DELIBERATELY ABSENT, having been considered:
 *
 *   The Canary Islands, Ceuta, Melilla, the Azores and Madeira are EU
 *   territory too, but have NO distinct ISO 3166-1 alpha-2 code. Cloudflare
 *   reports them as ES and PT, so they are already covered above and adding an
 *   entry would be adding a code that can never arrive.
 *
 *   Overseas countries and territories that are ASSOCIATED with the EU rather
 *   than part of it - BL Saint Barthelemy, PM Saint Pierre and Miquelon,
 *   GL Greenland, FO Faroe Islands, AW/CW/SX/BQ, NC/PF/WF/TF - are outside the
 *   EU's territorial scope, so the GDPR does not reach them on this basis.
 *
 *   GI Gibraltar and the Crown Dependencies JE, GG and IM are not the United
 *   Kingdom. They have their own data protection regimes and their own
 *   regulators, and the owner's decision named the UK. Adding them is a
 *   business decision that has not been taken, not an oversight.
 */
const EU_TERRITORIES = ["AX", "GF", "GP", "MQ", "RE", "YT", "MF"] as const;

/**
 * `EU`, which is a country code Cloudflare really does send.
 *
 * It is a user-assigned ISO 3166-1 code that geolocation databases use for an
 * address block registered to the European region without a resolvable member
 * state. It is not "unknown": it is a positive statement that the address is in
 * Europe and the database cannot say which country. Treating it as merely
 * undetermined would be an odd place to be generous, because the one thing it
 * does tell us is the thing we are refusing on.
 *
 * `AP` (Asia/Pacific) is the sibling code and is deliberately NOT here. It is
 * equally imprecise and it excludes Europe, which is all this list needs it to
 * do.
 */
const EU_REGION_CODE = ["EU"] as const;

/**
 * THE list. Everything above collapses into this one exported constant.
 *
 * A `Set` rather than an array because the lookup is on the request path of the
 * only unauthenticated route that mutates the identity provider's directory,
 * and because membership is the only question ever asked of it.
 */
export const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set<string>([
  ...EEA_COUNTRIES,
  ...UK_AND_SWITZERLAND,
  ...EU_TERRITORIES,
  ...EU_REGION_CODE,
]);

/** The EEA members alone, exported so a test can assert there are 30 of them. */
export const EEA_MEMBER_COUNTRIES: readonly string[] = EEA_COUNTRIES;

/**
 * Values Cloudflare sends INSTEAD of a country, both documented.
 *
 *   XX  Cloudflare could not determine a country for the address.
 *   T1  The address is a Tor exit node, so there is no meaningful country to
 *       report at all.
 *
 * Neither is a country and neither can be looked up in the list above. What is
 * done with them is the fail-open/fail-closed argument below, not a lookup.
 */
const UNDETERMINED_CODES: ReadonlySet<string> = new Set(["XX", "T1"]);

/** The header Cloudflare stamps on every request when IP Geolocation is on. */
export const COUNTRY_HEADER = "cf-ipcountry";

/** Why a request was allowed or refused. Logged and counted, never returned. */
export type GeoReason =
  /** A determined country that is not on the list. */
  | "permitted"
  /** No enforcement on this deployment, and no determination to act on. */
  | "unenforced"
  /** A determined country that is on the list. */
  | "restricted-country"
  /** Enforcing, and Cloudflare said XX, T1, or sent nothing at all. */
  | "undetermined-country"
  /** Enforcing, and the request did not arrive through the origin ingress. */
  | "unverified-peer";

export interface GeoDecision {
  readonly allowed: boolean;
  readonly reason: GeoReason;
  /**
   * The normalised code, or null when there was not one.
   *
   * For metrics and logs ONLY. It is never put in a response: see the refusal
   * message in routes/v1/auth.ts, which says nothing about how the
   * determination was reached, so a caller cannot use the refusal to learn
   * what Cloudflare thinks their address is.
   */
  readonly country: string | null;
}

export interface GeoInput {
  /**
   * The TCP PEER ADDRESS, from `request.socket.remoteAddress`.
   *
   * NOT `request.ip`. `trustProxy` is on, so `request.ip` is the leftmost
   * X-Forwarded-For entry and every client on earth can write it. The socket
   * address is a property of the connection and no HTTP header can change it.
   * This is the same distinction routes/health.ts makes to keep `/metrics`
   * shut from the edge, and it is made here for the same reason.
   */
  readonly peerAddress: string | undefined;
  /** The raw `CF-IPCountry` header, exactly as Fastify parsed it. */
  readonly countryHeader: string | string[] | undefined;
  /**
   * Whether this deployment sits behind the Cloudflare edge and the origin
   * nginx. Derived from DEPLOY_ENV by the caller; see the argument below.
   */
  readonly enforced: boolean;
}

/**
 * ---------------------------------------------------------------------------
 * HOW THE COUNTRY IS ESTABLISHED, AND WHY A HEADER IS BELIEVED AT ALL
 *
 * CF-IPCountry is an ordinary HTTP header. Anybody can send one. It is worth
 * something here only because of where this process sits, and that machinery
 * ALREADY EXISTS in this repository for exactly this problem - it was built for
 * the client IP that the per-IP rate limiter and audit_log.ip depend on, and it
 * is reused rather than reinvented:
 *
 *   1. The Hetzner cloud firewall admits inbound 80/443 from Cloudflare's
 *      published ranges only, and infra/staging/app/pullfm-cf-ranges refreshes
 *      that list on a timer so a newly published Cloudflare range does not
 *      become a 403 for real users.
 *   2. The origin nginx refuses any connection whose $remote_addr is not in the
 *      same published ranges (conf.d/cloudflare-allowlist.conf, regenerated by
 *      pullfm-cf-ranges.timer), and refuses again unless the peer presents the
 *      Cloudflare origin-pull client certificate.
 *   3. Only then does nginx proxy to this process, on 127.0.0.1:3000, which is
 *      not reachable from anywhere else: the port is published on the loopback
 *      interface alone and the public interface never carries an unterminated
 *      3000.
 *
 * So "the peer is Cloudflare" is PROVEN AT NGINX, not here, and this module
 * cannot re-derive it: by the time a request reaches this process the L3 peer
 * is the origin's own ingress, not the edge. What this module can prove, and
 * does, is that the request came THROUGH that ingress rather than around it,
 * because the TCP peer of a proxied request is a loopback or private address
 * and the TCP peer of anything else is not.
 *
 * BE HONEST ABOUT WHAT THAT IS AND IS NOT. It is a genuine, unforgeable check
 * that the request traversed the path where the Cloudflare proof happens. It is
 * NOT independent evidence about the edge, and it inherits the limit the nginx
 * template already writes down at length: zone-level origin pulls use a
 * certificate every Cloudflare customer holds, so "came through Cloudflare"
 * does not yet mean "came through OUR zone". Two things would close that, and
 * both live in infra/, which this change does not own: a PER-ZONE origin-pull
 * certificate, and `proxy_set_header CF-IPCountry $http_cf_ipcountry;` being
 * replaced by an nginx-side normalisation so a client-supplied CF-IPCountry can
 * never be relayed even if Cloudflare ever stopped overwriting it. Both are
 * reported rather than done.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED OR FAIL OPEN. THIS IS A DECISION, NOT A DEFAULT.
 *
 * The tension is real and neither pure answer survives contact:
 *
 *   Fail closed on everything, and `pnpm test` and every developer's laptop
 *   refuse every sign-in, because there is no Cloudflare in front of either and
 *   there never will be. A control that has to be switched off to work on the
 *   application gets switched off.
 *
 *   Fail open on anything unverifiable, and the block is decorative: strip the
 *   header, or arrive from somewhere the header was never added, and you are
 *   through. That is the whole bypass in one sentence.
 *
 * The answer is that the two cases are distinguished by the DEPLOYMENT, which
 * is not attacker-controlled, and never by the REQUEST, which is:
 *
 *   DEPLOY_ENV=staging|production. Cloudflare and the origin nginx are in front
 *   of this process by construction, so a request with no country, an
 *   undetermined country, or a peer that is not the origin ingress is not a
 *   normal request - it is the control being circumvented or broken. FAIL
 *   CLOSED on all three. In particular an unverified peer is refused BEFORE the
 *   header is even looked at, which is what makes `curl -H 'CF-IPCountry: US'`
 *   useless: the forged value never reaches a comparison.
 *
 *   DEPLOY_ENV=local. There is no edge, no nginx, no real user and no personal
 *   data relationship to refuse. Absence of a determination is the expected
 *   state and is ALLOWED. A header that IS present is still honoured, and the
 *   asymmetry is the safety property: on an unenforced deployment the header
 *   can only ever make the answer MORE restrictive, never less, so honouring it
 *   gives the suite a way to drive the block without giving anybody a way past
 *   it.
 *
 * The undetermined cases inside an enforcing deployment deserve their own line,
 * because refusing Tor exits is not a small thing. XX and T1 both mean
 * "Cloudflare answered, and the answer was that it cannot tell you". On a path
 * where the header is expected, that is a signal rather than a gap, and it is
 * precisely the shape an evasion takes: a resident of a listed country reaching
 * for Tor is the case this exists to catch. The cost of refusing is that a
 * would-be US user must not sign up over Tor; the cost of allowing is that the
 * entire list is bypassed by opening Tor Browser. It is refused, and it is
 * refused with the same message as everything else, so the refusal itself
 * reveals nothing about which branch produced it.
 */
export function decideRegistrationGeo(input: GeoInput): GeoDecision {
  const country = normaliseCountry(input.countryHeader);

  if (!input.enforced) {
    // Honoured only in the restrictive direction. See the argument above.
    if (country !== null && RESTRICTED_COUNTRIES.has(country)) {
      return { allowed: false, reason: "restricted-country", country };
    }
    return {
      allowed: true,
      reason: country === null ? "unenforced" : "permitted",
      country,
    };
  }

  // BEFORE the header is read, deliberately. A forged header from a peer that
  // is not the origin ingress must not reach a comparison at all.
  if (!isOriginIngressPeer(input.peerAddress)) {
    return { allowed: false, reason: "unverified-peer", country: null };
  }

  if (country === null || UNDETERMINED_CODES.has(country)) {
    return { allowed: false, reason: "undetermined-country", country };
  }

  if (RESTRICTED_COUNTRIES.has(country)) {
    return { allowed: false, reason: "restricted-country", country };
  }

  return { allowed: true, reason: "permitted", country };
}

/**
 * Reduces the raw header to a code, or to null when it is not one.
 *
 * Null rather than a guess for anything that is not exactly two letters. Two
 * shapes matter and both are rejected here rather than being partially parsed:
 *
 *   A DUPLICATED header. Node joins repeated headers with ", ", so a request
 *   carrying `CF-IPCountry` twice arrives as "US, DE". Taking the first value
 *   would let an attacker append a second header and pick which one is read,
 *   depending on which intermediary reordered them. It is ambiguous, so it is
 *   not a determination, so it fails closed on an enforcing deployment.
 *
 *   An array, which Fastify produces for a header it knows to be multi-valued.
 *   Same argument, same answer.
 */
function normaliseCountry(raw: string | string[] | undefined): string | null {
  if (raw === undefined || Array.isArray(raw)) return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

/**
 * Whether the TCP peer is the origin's own ingress rather than the internet.
 *
 * THIS IS NOT SIMPLY A LOOPBACK CHECK, AND IT USED TO BE. The BFF runs in a
 * container whose port is published as `127.0.0.1:3000:3000`
 * (infra/staging/app/docker-compose.yml), so nginx connects to the host
 * loopback and Docker rewrites the source to the bridge gateway before the
 * container sees it. Inside the container the peer is 172.x.x.x, never
 * 127.0.0.1. A loopback-only check would therefore have refused every single
 * production request while passing every test, which is the worst possible
 * combination: green suite, dead service.
 *
 * The set below is loopback plus the address ranges that are not routable on
 * the public internet, which is exactly the population that can reach a
 * loopback-published container port: the host itself, the Docker bridge, and
 * nothing else. A peer with a globally routable address means the request did
 * not come through the origin ingress, which on an enforcing deployment should
 * be impossible and is treated as such.
 */
export function isOriginIngressPeer(address: string | undefined): boolean {
  if (address === undefined || address === "") return false;

  // Node reports an IPv4 peer on a dual-stack socket in the mapped form.
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;

  if (addr === "::1") return true;
  const lower = addr.toLowerCase();
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

  const octets = addr.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : -1));
  if (parsed.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = parsed as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12, Docker
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/**
 * Source credibility gate. Every URL that enters the wiki — whether via the
 * user pasting a link, the Deep Plan panel dispatching a search, or Deep
 * Search auto-ingesting results — is run through `checkSourceAllowed`.
 *
 * The goal is narrow: keep the wiki to sources that carry actual citable
 * substance. Social platforms, forums, and professional-networking timelines
 * are blocked at the door because their content is ephemeral, user-generated,
 * and usually wrong in ways an anchor extractor can't detect. The anchor
 * quality thesis (phase 2) only holds if extraction runs over credible
 * primary / secondary material.
 *
 * This is opinionated and not user-configurable for now — the whole Deep Plan
 * pipeline assumes clean inputs. If someone really wants to ingest a Reddit
 * thread they can paste it as text, not a URL.
 */

/**
 * Hard-blocked hosts. An incoming URL is rejected if its hostname equals one
 * of these values OR ends with `.<value>` (so `old.reddit.com` and
 * `uk.linkedin.com` are both caught). Entries are registrable-domain style
 * so subdomain changes don't sneak through.
 */
const BLOCKED_HOSTS: readonly string[] = [
  // Social + short-form video.
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'threads.net',
  'twitter.com',
  'x.com',
  'snapchat.com',
  // Forums / aggregators — user-generated, unedited, no citation discipline.
  'reddit.com',
  'quora.com',
  'pinterest.com',
  '4chan.org',
  // Professional networking timelines.
  'linkedin.com',
  // Link shorteners — we want the resolved URL, not the redirect.
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
];

export interface CredibilityVerdict {
  allowed: boolean;
  /** When `allowed === false`, a one-line reason suitable for user-facing errors. */
  reason?: string;
  /** Registrable host we matched against, for logging. */
  host?: string;
}

/**
 * Preferred-domain nudges injected into research prompts. Never used to
 * filter — just appended to search prompts so the planner biases toward
 * reputable sources when framing its queries.
 */
export const PREFERRED_SOURCE_HINT = `Prefer credible source types: academic papers (arxiv.org, nature.com, *.edu, journal sites), reference works (wikipedia.org, stanford encyclopedia of philosophy), reputable news (reuters.com, apnews.com, ft.com, nytimes.com, economist.com, bbc.co.uk), official docs and reports (*.gov, *.who.int, *.oecd.org), and established long-form outlets (theatlantic.com, newyorker.com). Avoid social media, forums (reddit, quora), professional networking (linkedin), short-form video (tiktok), and random blogs of unknown provenance — those URLs are hard-blocked anyway, so queries that would return them waste a search.`;

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').trim();
}

function isBlockedHost(host: string): boolean {
  const h = normaliseHost(host);
  for (const blocked of BLOCKED_HOSTS) {
    if (h === blocked) return true;
    if (h.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/**
 * Check whether a URL is permitted to enter the wiki. Returns a verdict with
 * `allowed: false` and a human-readable reason when rejected so callers can
 * surface the message verbatim.
 */
export function checkSourceAllowed(rawUrl: string): CredibilityVerdict {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { allowed: false, reason: 'URL is empty.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: `"${trimmed}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `URL scheme "${parsed.protocol}" is not supported — use http or https.`,
      host: parsed.hostname,
    };
  }
  const host = normaliseHost(parsed.hostname);
  if (isBlockedHost(host)) {
    return {
      allowed: false,
      reason: `The wiki only accepts credible sources — ${host} is on the block list. Paste the content as text instead, or find a primary source (paper, news article, reference work).`,
      host,
    };
  }
  return { allowed: true, host };
}

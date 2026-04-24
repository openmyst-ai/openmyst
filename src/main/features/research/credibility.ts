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
  // Commercial / product listings — landing pages, not source material.
  // An Amazon product page or eBay listing is not a thing you cite.
  'amazon.com',
  'amazon.co.uk',
  'amazon.ca',
  'amazon.de',
  'amazon.fr',
  'amazon.co.jp',
  'ebay.com',
  'etsy.com',
  'alibaba.com',
  'aliexpress.com',
  'temu.com',
  'shein.com',
  'walmart.com',
  'target.com',
  'bestbuy.com',
  // Q&A + homework content farms, mostly user-generated junk.
  'chegg.com',
  'coursehero.com',
  'studocu.com',
  // Video platforms — we can't ingest video. Transcripts, if available,
  // are better sourced from a published transcript page, not the video
  // URL itself.
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'rumble.com',
  'dailymotion.com',
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
export const PREFERRED_SOURCE_HINT = `SOURCE QUALITY — this is load-bearing. The wiki's value is proportional to the strength of its sources, and search is the lever you control.

SOURCE TYPES to focus on (think in categories, not URLs):
- **Research papers** — peer-reviewed journal articles, working papers, preprints.
- **Journal articles** — academic journals, domain-specific publications.
- **News articles** — reporting from outlets with editorial standards (Reuters, AP, FT, NYT, Economist, BBC, WSJ, Guardian).
- **Long-form analysis / essays** — The Atlantic, New Yorker, NYBooks, Aeon.
- **Reference works** — Wikipedia, Stanford Encyclopedia of Philosophy, IEP, domain encyclopedias, official documentation.
- **Government / institutional reports** — *.gov, WHO, OECD, World Bank, central banks.
- **Expert blogs / Substack** — only when the author is a recognised subject-matter authority with a verifiable track record (e.g. a domain expert's personal blog, a named researcher's Substack). NOT random "top 10" blogs.
- **Books + book chapters** — when excerpts, reviews, or publisher pages with substantive content are available online.

NEVER use as a source (these are landing pages, not material to cite):
- **Product / commercial listings** — Amazon pages, eBay listings, Etsy, retailer product pages. A book's Amazon page is NOT a source for that book's ideas; find the book's text, a review, or the publisher page.
- **Forums & Q&A** — Reddit threads, Quora answers, Chegg, Course Hero, StackExchange answers (use the original paper/docs the answer links to instead).
- **Social media** — TikTok, Instagram, Twitter/X, Facebook, LinkedIn posts. Even "expert" social-media posts are hard to cite precisely.
- **Short-form explainer farms** — Investopedia, Corporate Finance Institute, wikiHow, "Ultimate Guide to X" listicles. One Wikipedia entry + one primary source beats five SEO explainers.
- **Marketing / landing pages** — SaaS product pages, course-sales pages, conference home pages. These describe a thing, they don't analyse it.
- **News aggregators without original content** — Google News result pages, RSS aggregators.

PRIMARY > SECONDARY > TERTIARY:
- Primary (the original claim/research/dataset) beats secondary (someone summarising it) beats tertiary (a summary of a summary). When a concept has a named originator or landmark paper, put that name in the query — "arrow impossibility theorem 1951" pulls the primary literature; "pareto efficiency explained" pulls Investopedia.
- If the wiki already has 2+ sources on a concept, do NOT search for another one. Pivot to an adjacent concept, a primary-source author, or a contested angle.

Hard-blocked hosts (rejected at fetch time, so queries that would return them waste budget): tiktok, instagram, facebook, twitter/x, threads, snapchat, reddit, quora, pinterest, 4chan, linkedin, amazon, ebay, etsy, alibaba, aliexpress, temu, shein, walmart, target, bestbuy, chegg, coursehero, studocu, youtube, youtu.be, vimeo, rumble, dailymotion, and link shorteners. We cannot ingest video — if a video is the primary source, find the published transcript or a written follow-up instead.`;

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

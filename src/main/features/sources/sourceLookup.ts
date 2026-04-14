import { readAnchor, readSourcePage, type AnchorLookupHit, type SourcePageHit } from './lookup';
import { log } from '../../platform';

/**
 * LLM-facing `source_lookup` protocol.
 *
 * Two forms:
 *   ```source_lookup
 *   {"slug": "smith-2022"}                    // open the source page — returns
 *   ```                                        // the full summary + anchor list
 *
 *   ```source_lookup
 *   {"slug": "smith-2022", "anchor": "law-1-2"}   // pull a verbatim anchor
 *   ```                                            // (exact raw text from disk)
 *
 * Flow: the default memory surface (wiki index) lists just sources with their
 * one-liner summaries. When the agent wants more, it emits a slug-only lookup
 * to "open the page" — we return the detailed summary and the anchor menu.
 * If it then needs a specific verbatim passage (quote, law, equation), it
 * emits a slug+anchor lookup and gets the raw text from `<slug>.raw.txt`.
 *
 * Both steps are free for the agent to use liberally — they replace having
 * the whole wiki's anchor lists glued into every turn's system prompt.
 *
 * Kept pure-ish: parseSourceLookups is I/O-free for tests; resolveSourceLookups
 * does the disk reads.
 */

const LOOKUP_FENCE = /```source_lookup\s*\n([\s\S]*?)```/g;

export interface SourceLookupRequest {
  slug: string;
  anchor?: string;
}

export interface SourceLookupParseResult {
  requests: SourceLookupRequest[];
  stripped: string;
}

export function parseSourceLookups(text: string): SourceLookupParseResult {
  const requests: SourceLookupRequest[] = [];
  let stripped = text;
  let match: RegExpExecArray | null;
  LOOKUP_FENCE.lastIndex = 0;
  while ((match = LOOKUP_FENCE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim()) as { slug?: unknown; anchor?: unknown };
      if (typeof parsed.slug === 'string' && parsed.slug.length > 0) {
        const req: SourceLookupRequest = { slug: parsed.slug };
        if (typeof parsed.anchor === 'string' && parsed.anchor.length > 0) {
          req.anchor = parsed.anchor;
        }
        requests.push(req);
      }
    } catch {
      // malformed block — drop silently, caller still gets the chat text
    }
    stripped = stripped.replace(match[0], '');
  }
  return { requests, stripped: stripped.trim() };
}

export interface ResolvedLookup {
  request: SourceLookupRequest;
  anchorHit: AnchorLookupHit | null;
  pageHit: SourcePageHit | null;
}

export async function resolveSourceLookups(
  requests: SourceLookupRequest[],
): Promise<ResolvedLookup[]> {
  const out: ResolvedLookup[] = [];
  for (const req of requests) {
    if (req.anchor) {
      const hit = await readAnchor(req.slug, req.anchor);
      if (!hit) {
        log('sources', 'lookup.anchor.miss', { slug: req.slug, anchor: req.anchor });
      } else {
        log('sources', 'lookup.anchor.hit', {
          slug: req.slug,
          anchor: req.anchor,
          len: hit.text.length,
        });
      }
      out.push({ request: req, anchorHit: hit, pageHit: null });
    } else {
      const page = await readSourcePage(req.slug);
      if (!page) {
        log('sources', 'lookup.page.miss', { slug: req.slug });
      } else {
        log('sources', 'lookup.page.hit', {
          slug: req.slug,
          summaryLen: page.summary.length,
          anchorCount: page.anchors.length,
        });
      }
      out.push({ request: req, anchorHit: null, pageHit: page });
    }
  }
  return out;
}

export function formatLookupReply(resolved: ResolvedLookup[]): string {
  if (resolved.length === 0) return '';
  const parts = resolved.map(({ request, anchorHit, pageHit }) => {
    // Anchor lookup (raw verbatim text)
    if (request.anchor) {
      if (!anchorHit) {
        return `**Lookup failed:** \`${request.slug}#${request.anchor}\` — no such anchor. Open the source page first with \`{"slug": "${request.slug}"}\` to see available anchors.`;
      }
      const { anchor, text } = anchorHit;
      return `**${request.slug}#${anchor.id}** — ${anchor.label} [${anchor.type}]\n\n> ${text.replace(/\n/g, '\n> ')}`;
    }
    // Slug-only lookup (source page)
    if (!pageHit) {
      return `**Lookup failed:** \`${request.slug}\` — no such source. Check the wiki index for the correct slug.`;
    }
    const { meta, summary, anchors } = pageHit;
    const header = `**${meta.name}** (\`${request.slug}\`) — ${meta.indexSummary}`;
    const urlLine = meta.sourcePath ? `\nSource: ${meta.sourcePath}` : '';
    const anchorBlock =
      anchors.length > 0
        ? `\n\nAnchors (emit \`{"slug": "${request.slug}", "anchor": "<id>"}\` to pull verbatim text):\n` +
          anchors.map((a) => `- \`${a.id}\` [${a.type}] ${a.label}`).join('\n')
        : '\n\n_(no anchors indexed for this source)_';
    return `${header}${urlLine}\n\n${summary}${anchorBlock}`;
  });
  return (
    '[source_lookup results — pulled deterministically from disk]\n\n' +
    parts.join('\n\n---\n\n')
  );
}

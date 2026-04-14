import { describe, it, expect, vi } from 'vitest';
import { locateAnchors } from '../features/sources/anchors';
import { parseSourceLookups, formatLookupReply } from '../features/sources/sourceLookup';

vi.mock('../platform', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

describe('locateAnchors', () => {
  const raw =
    'Chapter 1. Introduction.\n\nLaw 1.2. A system minimises the action integral ' +
    'over its trajectory.\n\nWe define activation as the output of a neuron after ' +
    'the non-linearity.\n\nThe key argument is that free will is compatible with ' +
    'determinism.';

  it('locates exact excerpts and computes offsets', () => {
    const anchors = locateAnchors(raw, [
      {
        type: 'rule',
        label: 'Law 1.2',
        keywords: ['action', 'trajectory'],
        excerpt: 'Law 1.2. A system minimises the action integral over its trajectory.',
      },
    ]);
    expect(anchors).toHaveLength(1);
    const a = anchors[0]!;
    expect(a.id).toBe('law-1-2');
    expect(a.type).toBe('rule');
    expect(raw.slice(a.charStart, a.charEnd)).toBe(
      'Law 1.2. A system minimises the action integral over its trajectory.',
    );
  });

  it('drops paraphrased excerpts', () => {
    const anchors = locateAnchors(raw, [
      {
        type: 'definition',
        label: 'activation',
        keywords: ['neuron'],
        excerpt: 'We define activation as the output of a neuron after its nonlinearity.',
      },
    ]);
    expect(anchors).toHaveLength(0);
  });

  it('drops ambiguous excerpts that appear twice', () => {
    const dup = 'hello world. hello world.';
    const anchors = locateAnchors(dup, [
      {
        type: 'idea',
        label: 'hello',
        keywords: [],
        excerpt: 'hello world.',
      },
    ]);
    expect(anchors).toHaveLength(0);
  });

  it('suffixes colliding ids', () => {
    const text = 'first match. second match.';
    const anchors = locateAnchors(text, [
      {
        type: 'idea',
        label: 'match',
        keywords: [],
        excerpt: 'first match.',
      },
      {
        type: 'idea',
        label: 'match',
        keywords: [],
        excerpt: 'second match.',
      },
    ]);
    expect(anchors.map((a) => a.id)).toEqual(['match', 'match-2']);
  });

  it('drops invalid type or missing label', () => {
    const anchors = locateAnchors(raw, [
      { type: 'bogus', label: 'x', excerpt: 'Chapter 1. Introduction.' },
      { type: 'section', label: '', excerpt: 'Chapter 1. Introduction.' },
      { type: 'section', label: 'intro', excerpt: 'Chapter 1. Introduction.' },
    ]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.id).toBe('intro');
  });
});

describe('parseSourceLookups', () => {
  it('extracts a single lookup block', () => {
    const text =
      'Let me check.\n' +
      '```source_lookup\n' +
      '{"slug": "smith-2022", "anchor": "law-1-2"}\n' +
      '```\n' +
      'Will continue.';
    const { requests, stripped } = parseSourceLookups(text);
    expect(requests).toEqual([{ slug: 'smith-2022', anchor: 'law-1-2' }]);
    expect(stripped).toContain('Let me check.');
    expect(stripped).toContain('Will continue.');
    expect(stripped).not.toContain('source_lookup');
  });

  it('extracts multiple lookup blocks', () => {
    const text =
      '```source_lookup\n{"slug":"a","anchor":"x"}\n```\n' +
      '```source_lookup\n{"slug":"b","anchor":"y"}\n```';
    const { requests } = parseSourceLookups(text);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ slug: 'a', anchor: 'x' });
    expect(requests[1]).toEqual({ slug: 'b', anchor: 'y' });
  });

  it('ignores malformed JSON but keeps going', () => {
    const text =
      '```source_lookup\n{not json}\n```\n' +
      '```source_lookup\n{"slug":"ok","anchor":"z"}\n```';
    const { requests } = parseSourceLookups(text);
    expect(requests).toEqual([{ slug: 'ok', anchor: 'z' }]);
  });

  it('returns no requests when no blocks present', () => {
    const text = 'Just chat, no fences.';
    const { requests, stripped } = parseSourceLookups(text);
    expect(requests).toHaveLength(0);
    expect(stripped).toBe('Just chat, no fences.');
  });
});

describe('formatLookupReply', () => {
  it('returns empty string for no resolutions', () => {
    expect(formatLookupReply([])).toBe('');
  });

  it('formats an anchor hit with the verbatim text quoted', () => {
    const reply = formatLookupReply([
      {
        request: { slug: 'smith-2022', anchor: 'law-1-2' },
        anchorHit: {
          slug: 'smith-2022',
          anchor: {
            id: 'law-1-2',
            type: 'rule',
            label: 'Law 1.2',
            keywords: [],
            charStart: 0,
            charEnd: 10,
          },
          text: 'Law 1.2. Foo.',
        },
        pageHit: null,
      },
    ]);
    expect(reply).toContain('smith-2022#law-1-2');
    expect(reply).toContain('Law 1.2');
    expect(reply).toContain('> Law 1.2. Foo.');
  });

  it('reports anchor misses clearly', () => {
    const reply = formatLookupReply([
      {
        request: { slug: 'ghost', anchor: 'none' },
        anchorHit: null,
        pageHit: null,
      },
    ]);
    expect(reply).toContain('Lookup failed');
    expect(reply).toContain('ghost#none');
  });

  it('formats a slug-only page hit with summary and anchor menu', () => {
    const reply = formatLookupReply([
      {
        request: { slug: 'smith-2022' },
        anchorHit: null,
        pageHit: {
          slug: 'smith-2022',
          meta: {
            name: 'Smith 2022',
            indexSummary: 'Action principle paper.',
            sourcePath: 'https://example.com/smith',
          },
          summary: 'Detailed summary body.',
          anchors: [
            { id: 'law-1-2', type: 'rule', label: 'Law 1.2' },
            { id: 'intro', type: 'section', label: 'Introduction' },
          ],
        },
      },
    ]);
    expect(reply).toContain('Smith 2022');
    expect(reply).toContain('`smith-2022`');
    expect(reply).toContain('Action principle paper.');
    expect(reply).toContain('Detailed summary body.');
    expect(reply).toContain('`law-1-2`');
    expect(reply).toContain('Introduction');
    expect(reply).toContain('https://example.com/smith');
  });

  it('reports slug-only misses clearly', () => {
    const reply = formatLookupReply([
      {
        request: { slug: 'ghost' },
        anchorHit: null,
        pageHit: null,
      },
    ]);
    expect(reply).toContain('Lookup failed');
    expect(reply).toContain('`ghost`');
  });

  it('parses slug-only lookup blocks', () => {
    const { requests } = parseSourceLookups(
      'look here ```source_lookup\n{"slug":"smith-2022"}\n``` ok',
    );
    expect(requests).toEqual([{ slug: 'smith-2022' }]);
  });
});

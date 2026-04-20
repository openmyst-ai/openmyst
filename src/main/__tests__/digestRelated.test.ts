import { describe, it, expect } from 'vitest';
import { sanitizeRelatedSlugs, appendRelatedSection } from '../features/sources/digest';
import { computeWikiGraph } from '../features/wiki/graph';
import type { SourceMeta } from '@shared/types';

/**
 * Related-slug handling sits on the critical path for graph density — the
 * whole point of the `relatedSlugs` addition is denser edges between
 * sources, and the sanitizer is the only thing stopping the LLM from
 * hallucinating random strings into the wiki. These tests pin both the
 * sanitize rules AND the end-to-end contract: slugs → Related section →
 * `computeWikiGraph` turns them into edges.
 */

function src(slug: string, name: string, summary = ''): SourceMeta {
  return {
    slug,
    name,
    originalName: name,
    type: 'raw',
    addedAt: '2026-04-20T00:00:00Z',
    summary,
    indexSummary: `Summary of ${name}`,
  };
}

const existing: SourceMeta[] = [
  src('attention', 'Attention Is All You Need'),
  src('rlhf', 'RLHF'),
  src('lora', 'LoRA'),
];

describe('sanitizeRelatedSlugs', () => {
  it('returns an empty list when the input is not an array', () => {
    expect(sanitizeRelatedSlugs(null, existing, 'x')).toEqual([]);
    expect(sanitizeRelatedSlugs('attention', existing, 'x')).toEqual([]);
    expect(sanitizeRelatedSlugs(undefined, existing, 'x')).toEqual([]);
  });

  it('keeps only known slugs', () => {
    expect(
      sanitizeRelatedSlugs(
        ['attention', 'made_up', 'rlhf', 'also_hallucinated'],
        existing,
        'Mamba',
      ),
    ).toEqual(['attention', 'rlhf']);
  });

  it('strips a trailing .md the LLM sometimes leaves on', () => {
    expect(sanitizeRelatedSlugs(['attention.md', 'rlhf.MD'], existing, 'Mamba')).toEqual([
      'attention',
      'rlhf',
    ]);
  });

  it('dedupes', () => {
    expect(
      sanitizeRelatedSlugs(['attention', 'attention', 'attention.md'], existing, 'Mamba'),
    ).toEqual(['attention']);
  });

  it('excludes self-references by name-matched slug', () => {
    // `selfHint` matches the `name` of an existing source — that source's
    // slug must not show up in its own related list.
    expect(sanitizeRelatedSlugs(['rlhf', 'attention'], existing, 'RLHF')).toEqual(['attention']);
  });

  it('drops non-string entries silently', () => {
    expect(
      sanitizeRelatedSlugs(['attention', 42, null, { slug: 'rlhf' }, 'rlhf'], existing, 'Mamba'),
    ).toEqual(['attention', 'rlhf']);
  });

  it('returns empty when no existing sources are provided', () => {
    expect(sanitizeRelatedSlugs(['attention'], [], 'Mamba')).toEqual([]);
  });
});

describe('appendRelatedSection', () => {
  it('returns the summary unchanged when there are no related slugs', () => {
    expect(appendRelatedSection('Summary text.', [], existing)).toBe('Summary text.');
  });

  it('appends a ## Related heading with name-linked wikilinks', () => {
    const out = appendRelatedSection('Main summary.', ['attention', 'rlhf'], existing);
    expect(out).toContain('## Related');
    expect(out).toContain('- [Attention Is All You Need](attention.md)');
    expect(out).toContain('- [RLHF](rlhf.md)');
  });

  it('falls back to the slug as link text when the source is unknown', () => {
    // Defensive: even though sanitize ought to have stripped this, the
    // appender shouldn't crash — slug becomes its own label.
    const out = appendRelatedSection('Body.', ['mystery'], existing);
    expect(out).toContain('- [mystery](mystery.md)');
  });

  it('separates the section with a blank line even if the summary has no trailing newline', () => {
    const out = appendRelatedSection('Body with no newline', ['attention'], existing);
    expect(out).toBe('Body with no newline\n\n## Related\n- [Attention Is All You Need](attention.md)');
  });
});

describe('Related section → computeWikiGraph', () => {
  // The load-bearing integration: sanitized slugs → appended section →
  // `computeWikiGraph`'s regex picks them up as edges. If this breaks,
  // indirect links stop landing in the graph.
  it('creates graph edges from a Related section at the end of a summary', () => {
    const related = appendRelatedSection(
      'LoRA freezes most of the network and learns a low-rank update.',
      sanitizeRelatedSlugs(['attention', 'rlhf'], existing, 'LoRA'),
      existing,
    );
    const sources: SourceMeta[] = [...existing, src('lora2', 'LoRA v2', related)];
    const g = computeWikiGraph(sources);
    const edgesFromLora = g.edges.filter((e) => e.source === 'lora2').map((e) => e.target);
    expect(edgesFromLora.sort()).toEqual(['attention', 'rlhf']);
  });

  it('does not duplicate edges when the same slug is also linked inline', () => {
    // Inline `[...](attention.md)` in prose AND the same slug in related
    // should produce a single edge — `computeWikiGraph` already dedupes
    // per (source,target) pair, so this is a regression test.
    const body = 'See [Attention Is All You Need](attention.md) for context.';
    const summary = appendRelatedSection(body, ['attention'], existing);
    const sources: SourceMeta[] = [...existing, src('note', 'Note', summary)];
    const edges = computeWikiGraph(sources).edges.filter((e) => e.source === 'note');
    expect(edges).toEqual([{ source: 'note', target: 'attention' }]);
  });
});

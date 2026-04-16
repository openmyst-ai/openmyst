import { describe, it, expect } from 'vitest';
import {
  applyEditOccurrence,
  applyEditOccurrenceAnchored,
  applyEditOccurrenceCanonical,
  applyEditOccurrenceFuzzy,
  canLocateEdit,
  cleanChatContent,
  locateEdit,
  looksLikeDocumentRequest,
  mergePendingEdits,
  parseEditBlocks,
  tryResolvePendingPatch,
  validateEdits,
} from '../features/chat/editLogic';

describe('parseEditBlocks', () => {
  it('parses a single myst_edit block', () => {
    const text =
      'Sure, here you go.\n' +
      '```myst_edit\n' +
      '{"old_string": "foo", "new_string": "bar"}\n' +
      '```\n';
    const { edits, chatContent } = parseEditBlocks(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ old_string: 'foo', new_string: 'bar' });
    expect(chatContent).toBe('Sure, here you go.');
  });

  it('parses multiple blocks and preserves order', () => {
    const text =
      '```myst_edit\n{"old_string": "a", "new_string": "A"}\n```\n' +
      '```myst_edit\n{"old_string": "b", "new_string": "B"}\n```';
    const { edits } = parseEditBlocks(text);
    expect(edits.map((e) => e.old_string)).toEqual(['a', 'b']);
    expect(edits.map((e) => e.new_string)).toEqual(['A', 'B']);
  });

  it('keeps the occurrence field when positive', () => {
    const text =
      '```myst_edit\n{"old_string": "x", "new_string": "X", "occurrence": 3}\n```';
    const { edits } = parseEditBlocks(text);
    expect(edits[0]?.occurrence).toBe(3);
  });

  it('drops zero or negative occurrence silently', () => {
    const text =
      '```myst_edit\n{"old_string": "x", "new_string": "X", "occurrence": 0}\n```';
    const { edits } = parseEditBlocks(text);
    expect(edits[0]?.occurrence).toBeUndefined();
  });

  it('skips fully empty edits (both sides empty)', () => {
    // THIS is the regression we're defending: the LLM sometimes emits an
    // empty no-op that used to appear as a ghost "accept me" banner with no
    // visible change. It must be filtered at parse time.
    const text =
      '```myst_edit\n{"old_string": "", "new_string": ""}\n```\n' +
      '```myst_edit\n{"old_string": "", "new_string": "real content"}\n```';
    const { edits } = parseEditBlocks(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.new_string).toBe('real content');
  });

  it('tolerates malformed JSON without throwing', () => {
    const text =
      '```myst_edit\n{this is not json\n```\n' +
      '```myst_edit\n{"old_string": "a", "new_string": "b"}\n```';
    expect(() => parseEditBlocks(text)).not.toThrow();
    const { edits } = parseEditBlocks(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.old_string).toBe('a');
  });

  it('strips edit blocks from chatContent', () => {
    const text =
      'Here:\n```myst_edit\n{"old_string": "a", "new_string": "b"}\n```\nDone.';
    const { chatContent } = parseEditBlocks(text);
    expect(chatContent).not.toContain('myst_edit');
    expect(chatContent).toContain('Here:');
    expect(chatContent).toContain('Done.');
  });

  it('returns an empty list when there are no blocks', () => {
    const { edits, chatContent } = parseEditBlocks('just a chat reply');
    expect(edits).toEqual([]);
    expect(chatContent).toBe('just a chat reply');
  });

  it('handles multiline new_string values', () => {
    const newString = 'line one\\nline two\\nline three';
    const text =
      '```myst_edit\n{"old_string": "a", "new_string": "' + newString + '"}\n```';
    const { edits } = parseEditBlocks(text);
    expect(edits[0]?.new_string).toBe('line one\nline two\nline three');
  });
});

describe('locateEdit', () => {
  it('reports a single match', () => {
    const doc = 'hello world';
    const loc = locateEdit(doc, { old_string: 'hello', new_string: 'hi' });
    expect(loc.count).toBe(1);
    expect(loc.ok).toBe(true);
  });

  it('reports zero matches', () => {
    const loc = locateEdit('hello', { old_string: 'missing', new_string: 'x' });
    expect(loc.count).toBe(0);
    expect(loc.ok).toBe(false);
  });

  it('reports multiple matches with contexts', () => {
    const doc = 'foo and foo again';
    const loc = locateEdit(doc, { old_string: 'foo', new_string: 'bar' });
    expect(loc.count).toBe(2);
    expect(loc.ok).toBe(false);
    expect(loc.contexts).toHaveLength(2);
  });

  it('treats empty old_string as auto-ok append', () => {
    const loc = locateEdit('anything', { old_string: '', new_string: 'x' });
    expect(loc.ok).toBe(true);
    expect(loc.count).toBe(1);
  });
});

describe('validateEdits', () => {
  it('passes when every edit is locatable', () => {
    const doc = 'a b c';
    const result = validateEdits(doc, [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'c', new_string: 'C' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when an old_string is missing', () => {
    const result = validateEdits('abc', [
      { old_string: 'xyz', new_string: 'X' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('not found');
  });

  it('fails on ambiguous match without occurrence', () => {
    const result = validateEdits('foo foo', [
      { old_string: 'foo', new_string: 'bar' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('matches 2 places');
  });

  it('accepts ambiguous match when a valid occurrence is given', () => {
    const result = validateEdits('foo foo', [
      { old_string: 'foo', new_string: 'bar', occurrence: 2 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('skips empty old_string (append is always valid)', () => {
    const result = validateEdits('anything', [
      { old_string: '', new_string: 'appended' },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('applyEditOccurrence', () => {
  it('replaces the first occurrence when none specified', () => {
    const result = applyEditOccurrence('foo bar foo', 'foo', 'FOO', 1);
    expect(result).toBe('FOO bar foo');
  });

  it('replaces the Nth occurrence', () => {
    const result = applyEditOccurrence('foo foo foo', 'foo', 'FOO', 2);
    expect(result).toBe('foo FOO foo');
  });

  it('returns null when occurrence is out of range', () => {
    expect(applyEditOccurrence('foo', 'foo', 'FOO', 5)).toBeNull();
  });

  it('returns null when old_string is absent', () => {
    expect(applyEditOccurrence('hello', 'missing', 'X', 1)).toBeNull();
  });

  it('appends to an empty doc when old_string is empty', () => {
    // Regression: empty new doc + "write me X" must produce a clean first
    // paragraph, not "\n\nwritten".
    const result = applyEditOccurrence('', '', 'Hello world', 1);
    expect(result).toBe('Hello world\n');
  });

  it('appends to a non-empty doc with a blank line separator', () => {
    const result = applyEditOccurrence('existing body', '', 'added later', 1);
    expect(result).toBe('existing body\n\nadded later\n');
  });

  it('handles multi-line replacements', () => {
    const result = applyEditOccurrence(
      'alpha\nbeta\ngamma',
      'beta',
      'middle\nline',
      1,
    );
    expect(result).toBe('alpha\nmiddle\nline\ngamma');
  });

  it('handles multi-line old_string (cross-block)', () => {
    const doc = '# Title\n\nParagraph one.\n\nParagraph two.';
    const result = applyEditOccurrence(
      doc,
      'Paragraph one.\n\nParagraph two.',
      'Replaced.',
      1,
    );
    expect(result).toBe('# Title\n\nReplaced.');
  });
});

describe('applyEditOccurrenceFuzzy', () => {
  // The real-world failure mode: markdown round-trip silently changes
  // "single space" to "\n\n" (or vice versa) between when the LLM staged the
  // edit and when the user clicked Accept. Exact indexOf fails. This fallback
  // treats any whitespace run as interchangeable so the edit still applies.
  it('matches a single space where the doc has a newline', () => {
    const doc = 'The body is a thermostat.\nIt maintains equilibrium.';
    const result = applyEditOccurrenceFuzzy(
      doc,
      'thermostat. It maintains',
      'thermostat — it maintains',
      1,
    );
    expect(result).toBe('The body is a thermostat — it maintains equilibrium.');
  });

  it('matches a newline where the doc has a single space', () => {
    const doc = 'Line one sits next to line two.';
    const result = applyEditOccurrenceFuzzy(
      doc,
      'Line one\nsits next to line two.',
      'Replaced.',
      1,
    );
    expect(result).toBe('Replaced.');
  });

  it('matches runs of two spaces collapsed to one', () => {
    const doc = 'hello world'; // single space
    const result = applyEditOccurrenceFuzzy(doc, 'hello   world', 'HI', 1);
    expect(result).toBe('HI');
  });

  it('tolerates leading/trailing whitespace in oldString', () => {
    const doc = 'alpha beta gamma';
    const result = applyEditOccurrenceFuzzy(doc, '  beta  ', 'BETA', 1);
    expect(result).toBe('alpha BETA gamma');
  });

  it('honors occurrence for fuzzy matches', () => {
    const doc = 'foo bar\nfoo   bar\nfoo\tbar';
    const result = applyEditOccurrenceFuzzy(doc, 'foo bar', 'X', 2);
    expect(result).toBe('foo bar\nX\nfoo\tbar');
  });

  it('returns null when the needle really isn\'t there', () => {
    expect(applyEditOccurrenceFuzzy('hello world', 'missing phrase', 'X', 1)).toBeNull();
  });

  it('returns null for empty oldString (append has no fuzzy mode)', () => {
    expect(applyEditOccurrenceFuzzy('anything', '', 'X', 1)).toBeNull();
  });

  it('escapes regex metacharacters in the needle', () => {
    const doc = 'See section (3.2) for details.';
    const result = applyEditOccurrenceFuzzy(doc, '(3.2)', '(4.1)', 1);
    expect(result).toBe('See section (4.1) for details.');
  });
});

describe('applyEditOccurrence — serial-accept invariants', () => {
  // Simulates the exact flow we had the autosave-race bug on: stage N edits
  // against the *original* doc, then accept them in order and check that
  // each subsequent edit still resolves against the mutated intermediate doc.
  it('accepts a batch of distinct non-overlapping edits in order', () => {
    const original =
      '# Story 1\n\nOnce upon a time.\n\n# Story 2\n\nIn a galaxy far away.\n\n# Story 3\n\nLong long ago.';
    const edits = [
      {
        old_string: 'Once upon a time.',
        new_string: 'Once upon a time, in a kingdom.',
      },
      {
        old_string: 'In a galaxy far away.',
        new_string: 'In a galaxy far far away.',
      },
      {
        old_string: 'Long long ago.',
        new_string: 'Very long ago indeed.',
      },
    ];

    let doc = original;
    for (const edit of edits) {
      const next = applyEditOccurrence(doc, edit.old_string, edit.new_string, 1);
      expect(next).not.toBeNull();
      doc = next!;
    }

    expect(doc).toContain('Once upon a time, in a kingdom.');
    expect(doc).toContain('In a galaxy far far away.');
    expect(doc).toContain('Very long ago indeed.');
    expect(doc).not.toContain('Once upon a time.');
  });
});

describe('looksLikeDocumentRequest', () => {
  it('detects write verbs in user text', () => {
    expect(looksLikeDocumentRequest('write me a poem', '')).toBe(true);
    expect(looksLikeDocumentRequest('add a new section', '')).toBe(true);
    expect(looksLikeDocumentRequest('fix the typo', '')).toBe(true);
  });

  it('detects change verbs in the LLM response even when user text is vague', () => {
    expect(looksLikeDocumentRequest('yo', "here's the updated version")).toBe(
      true,
    );
  });

  it('returns false for pure Q&A', () => {
    expect(looksLikeDocumentRequest('what is this about', 'It is about foxes.')).toBe(
      false,
    );
  });
});

describe('mergePendingEdits', () => {
  // Stand-in PendingEdit shape. mergePendingEdits only reads oldString,
  // newString, and occurrence — everything else comes from makeNew.
  interface Pending {
    id: string;
    oldString: string;
    newString: string;
    occurrence: number;
  }

  let counter = 0;
  const makeNew = (inc: { oldString: string; newString: string; occurrence: number }): Pending => ({
    id: `new-${++counter}`,
    oldString: inc.oldString,
    newString: inc.newString,
    occurrence: inc.occurrence,
  });

  it('appends when nothing overlaps', () => {
    const existing: Pending[] = [
      { id: 'a', oldString: 'one', newString: 'ONE', occurrence: 1 },
    ];
    const incoming = [{ oldString: 'two', newString: 'TWO', occurrence: 1 }];
    const result = mergePendingEdits(existing, incoming, makeNew);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.newString)).toEqual(['ONE', 'TWO']);
  });

  it('replaces in place when oldString+occurrence match (the revision case)', () => {
    // This is the core of the tweak flow: user says "make it shorter",
    // LLM re-emits with same old_string. We MUST NOT stack a second pending
    // entry — we update the existing one instead.
    const existing: Pending[] = [
      { id: 'a', oldString: 'one', newString: 'ONE loud', occurrence: 1 },
    ];
    const incoming = [{ oldString: 'one', newString: 'one quiet', occurrence: 1 }];
    const result = mergePendingEdits(existing, incoming, makeNew);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'a', // id preserved — it's still "the same edit"
      oldString: 'one',
      newString: 'one quiet',
    });
  });

  it('treats different occurrence as different slots', () => {
    const existing: Pending[] = [
      { id: 'a', oldString: 'foo', newString: 'FOO1', occurrence: 1 },
    ];
    const incoming = [{ oldString: 'foo', newString: 'FOO2', occurrence: 2 }];
    const result = mergePendingEdits(existing, incoming, makeNew);
    expect(result).toHaveLength(2);
  });

  it('collapses appends: a new empty-old append replaces the previous empty-old append', () => {
    // Append mode has no disambiguator, so consecutive "write me X, actually
    // make it Y" revisions must overwrite the previous append.
    const existing: Pending[] = [
      { id: 'a', oldString: '', newString: 'first attempt', occurrence: 1 },
    ];
    const incoming = [{ oldString: '', newString: 'second attempt', occurrence: 1 }];
    const result = mergePendingEdits(existing, incoming, makeNew);
    expect(result).toHaveLength(1);
    expect(result[0]?.newString).toBe('second attempt');
    expect(result[0]?.id).toBe('a');
  });

  it('handles a mixed batch: some update, some append', () => {
    const existing: Pending[] = [
      { id: 'a', oldString: 'keep', newString: 'KEEP', occurrence: 1 },
      { id: 'b', oldString: 'change', newString: 'old', occurrence: 1 },
    ];
    const incoming = [
      { oldString: 'change', newString: 'new', occurrence: 1 }, // update b
      { oldString: 'fresh', newString: 'FRESH', occurrence: 1 }, // append
    ];
    const result = mergePendingEdits(existing, incoming, makeNew);
    expect(result).toHaveLength(3);
    expect(result[0]?.newString).toBe('KEEP');
    expect(result[1]).toMatchObject({ id: 'b', newString: 'new' });
    expect(result[2]?.newString).toBe('FRESH');
  });
});

describe('tryResolvePendingPatch', () => {
  // The real-world case: user says "write me a story" on an empty doc.
  // LLM stages {old: "", new: "Once upon a time, a fox jumped..."}.
  // User says "make the fox a wolf". The fox only exists inside the pending
  // new_string — not in the document yet — so validation against the doc
  // would fail. tryResolvePendingPatch routes the edit to the pending entry.
  it('patches a pending edit whose newString contains the old_string', () => {
    const pending = [{ newString: 'Once upon a time, a fox jumped over the log.' }];
    const result = tryResolvePendingPatch('fox', 'wolf', 1, pending);
    expect(result).toEqual({
      index: 0,
      updatedNewString: 'Once upon a time, a wolf jumped over the log.',
    });
  });

  it('returns null when old_string is not in any pending newString', () => {
    const pending = [{ newString: 'story content' }];
    expect(tryResolvePendingPatch('missing', 'X', 1, pending)).toBeNull();
  });

  it('returns null for empty old_string (append is not a pending patch)', () => {
    const pending = [{ newString: 'anything' }];
    expect(tryResolvePendingPatch('', 'X', 1, pending)).toBeNull();
  });

  it('walks the first pending that matches, not later ones', () => {
    const pending = [
      { newString: 'story one contains foo' },
      { newString: 'story two also contains foo' },
    ];
    const result = tryResolvePendingPatch('foo', 'bar', 1, pending);
    expect(result?.index).toBe(0);
    expect(result?.updatedNewString).toBe('story one contains bar');
  });

  it('honors the occurrence field when the same word appears multiple times', () => {
    const pending = [{ newString: 'cat cat cat' }];
    const result = tryResolvePendingPatch('cat', 'dog', 2, pending);
    expect(result?.updatedNewString).toBe('cat dog cat');
  });

  it('handles multi-line old_string inside pending newString', () => {
    const pending = [{ newString: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.' }];
    const result = tryResolvePendingPatch(
      'Paragraph one.\n\nParagraph two.',
      'Combined paragraph.',
      1,
      pending,
    );
    expect(result?.updatedNewString).toBe('Combined paragraph.\n\nParagraph three.');
  });
});

describe('cleanChatContent', () => {
  it('strips myst_edit fences', () => {
    const text =
      'hello\n```myst_edit\n{"old_string":"a","new_string":"b"}\n```\nworld';
    const cleaned = cleanChatContent(text);
    expect(cleaned).not.toContain('myst_edit');
    expect(cleaned).toContain('hello');
    expect(cleaned).toContain('world');
  });

  it('strips stray myst_edit / old_string / new_string tokens', () => {
    const cleaned = cleanChatContent(
      'I used myst_edit with old_string and new_string',
    );
    expect(cleaned).not.toMatch(/myst_edit|old_string|new_string/);
  });

  it('collapses excessive blank lines', () => {
    const cleaned = cleanChatContent('a\n\n\n\n\nb');
    expect(cleaned).toBe('a\n\nb');
  });

  it('strips chain-of-thought channel markers', () => {
    const cleaned = cleanChatContent(
      '<|channel>thought\n<channel|>\n\nTrimmed the analysis down to the essentials.',
    );
    expect(cleaned).not.toContain('<|channel');
    expect(cleaned).not.toContain('<channel|');
    expect(cleaned).toContain('Trimmed the analysis down to the essentials.');
  });

  it('strips <think>…</think> reasoning blocks', () => {
    const cleaned = cleanChatContent(
      '<think>first I should consider X</think>\n\nHere is your answer.',
    );
    expect(cleaned).not.toContain('<think>');
    expect(cleaned).not.toContain('consider X');
    expect(cleaned).toContain('Here is your answer.');
  });
});

describe('applyEditOccurrenceAnchored', () => {
  it('matches a long paragraph whose embedded link was slightly mangled', () => {
    const doc =
      '# Case\n\nSome intro text that is not relevant.\n\n' +
      'Applying deductive reasoning to *Burns v MAN Automotive* [Burns v MAN Automotive](burns_v_man_automotive.md), the court began with the general legal principles of contract law, specifically concerning breach of warranty and the calculation of damages. The court applied those principles to the specific facts of the case and reached a conclusion about the appropriate measure of damages.\n\n' +
      '## Footer\n\nEnd.';
    // LLM produced the same paragraph but with a subtly different link slug.
    const oldString =
      'Applying deductive reasoning to *Burns v MAN Automotive* [Burns v MAN Automotive](burns_v_man_automotive_case.md), the court began with the general legal principles of contract law, specifically concerning breach of warranty and the calculation of damages. The court applied those principles to the specific facts of the case and reached a conclusion about the appropriate measure of damages.';
    const newString = 'REPLACED PARAGRAPH.';
    const result = applyEditOccurrenceAnchored(doc, oldString, newString, 1);
    expect(result).not.toBeNull();
    expect(result).toContain('REPLACED PARAGRAPH.');
    expect(result).toContain('# Case');
    expect(result).toContain('## Footer');
    // Make sure we didn't accidentally nuke the footer or intro.
    expect(result).toContain('Some intro text');
    expect(result).toContain('End.');
  });

  it('returns null for short old strings (anchors are too risky)', () => {
    const result = applyEditOccurrenceAnchored('hello world', 'hello', 'hi', 1);
    expect(result).toBeNull();
  });

  it('returns null when anchors cannot be found', () => {
    const doc = 'a'.repeat(500);
    const oldString = 'completely different content that is long enough to be a paragraph in any document by human standards';
    const result = applyEditOccurrenceAnchored(doc, oldString, 'new', 1);
    expect(result).toBeNull();
  });
});

describe('applyEditOccurrenceCanonical', () => {
  // These are the typographic drift cases that silently break exact match:
  // the user bug from 2026-04-15 was a 628-char old_string that failed every
  // fallback; short edits with quote/dash drift are what this tier catches.
  it('matches a curly-quoted doc against a straight-quoted oldString', () => {
    const doc = 'She said \u201chello\u201d and smiled.';
    const result = applyEditOccurrenceCanonical(doc, 'She said "hello"', 'She whispered "hi"', 1);
    expect(result).toBe('She whispered "hi" and smiled.');
  });

  it('matches a straight-quoted doc against a curly-quoted oldString', () => {
    const doc = 'He said "go" and left.';
    const result = applyEditOccurrenceCanonical(
      doc,
      '\u201cgo\u201d and left',
      '"stay" and sat',
      1,
    );
    expect(result).toBe('He said "stay" and sat.');
  });

  it('matches em-dash in doc against hyphen in oldString', () => {
    const doc = 'The body \u2014 a thermostat \u2014 maintains equilibrium.';
    const result = applyEditOccurrenceCanonical(doc, 'body - a thermostat -', 'mind - a mirror -', 1);
    expect(result).toBe('The mind - a mirror - maintains equilibrium.');
  });

  it('matches en-dash in doc against hyphen in oldString', () => {
    const doc = 'Pages 12\u201315 cover this.';
    const result = applyEditOccurrenceCanonical(doc, 'Pages 12-15', 'Pages 14-17', 1);
    expect(result).toBe('Pages 14-17 cover this.');
  });

  it('matches NBSP in doc against regular space in oldString', () => {
    const doc = 'Once\u00a0upon\u00a0a\u00a0time.';
    const result = applyEditOccurrenceCanonical(doc, 'Once upon a time.', 'Long ago.', 1);
    expect(result).toBe('Long ago.');
  });

  it('matches CRLF line endings against LF in oldString', () => {
    const doc = 'line one\r\nline two\r\nline three';
    const result = applyEditOccurrenceCanonical(doc, 'line one\nline two', 'replaced', 1);
    expect(result).toBe('replaced\r\nline three');
  });

  it('drops zero-width characters when matching', () => {
    const doc = 'hello\u200bworld';
    const result = applyEditOccurrenceCanonical(doc, 'helloworld', 'HI', 1);
    expect(result).toBe('HI');
  });

  it('honors occurrence for canonical matches', () => {
    const doc = '\u201cone\u201d and \u201cone\u201d again';
    const result = applyEditOccurrenceCanonical(doc, '"one"', 'X', 2);
    expect(result).toBe('\u201cone\u201d and X again');
  });

  it('returns null when there is nothing to canonicalize and exact fails', () => {
    // Early exit: pure ASCII on both sides, no drift to fix.
    expect(applyEditOccurrenceCanonical('hello world', 'missing', 'X', 1)).toBeNull();
  });

  it('returns null for empty oldString (append has no canonical mode)', () => {
    expect(applyEditOccurrenceCanonical('anything', '', 'X', 1)).toBeNull();
  });

  it('preserves original doc characters outside the matched range', () => {
    // Make sure the splice-back uses raw doc chars, not canonical ones — the
    // untouched tail still has its curly quote.
    const doc = 'She said "hi" then \u201cbye\u201d forever.';
    const result = applyEditOccurrenceCanonical(doc, '"hi"', '"hello"', 1);
    expect(result).toBe('She said "hello" then \u201cbye\u201d forever.');
  });
});

describe('canLocateEdit', () => {
  it('returns true for empty old_string (append is always locatable)', () => {
    expect(canLocateEdit('anything', { old_string: '', new_string: 'X' })).toBe(true);
  });

  it('returns true for an exact match', () => {
    expect(canLocateEdit('hello world', { old_string: 'hello', new_string: 'hi' })).toBe(true);
  });

  it('returns true when only canonical matching can find it', () => {
    const doc = 'She said \u201chello\u201d and smiled.';
    expect(
      canLocateEdit(doc, { old_string: 'She said "hello"', new_string: 'X' }),
    ).toBe(true);
  });

  it('returns true when only the whitespace-fuzzy path can find it', () => {
    const doc = 'The body is a thermostat.\nIt maintains equilibrium.';
    expect(
      canLocateEdit(doc, {
        old_string: 'thermostat. It maintains',
        new_string: 'X',
      }),
    ).toBe(true);
  });

  it('returns false when no path can locate it', () => {
    expect(
      canLocateEdit('abc def ghi', { old_string: 'xyz', new_string: 'X' }),
    ).toBe(false);
  });

  it('honors occurrence (no 5th "foo" to locate)', () => {
    expect(
      canLocateEdit('foo foo', { old_string: 'foo', new_string: 'X', occurrence: 5 }),
    ).toBe(false);
  });
});

describe('validateEdits — fallback integration', () => {
  // validateEdits now defers "not found" to canLocateEdit, so semantically
  // correct edits with typographic drift pass pre-flight instead of forcing
  // a needless LLM retry.
  it('passes an edit that only canonical matching can locate', () => {
    const doc = 'The report said \u201cship it\u201d today.';
    const result = validateEdits(doc, [
      { old_string: '"ship it"', new_string: '"hold it"' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('still fails when no locator works', () => {
    const result = validateEdits('short doc content', [
      { old_string: 'nonexistent phrase', new_string: 'X' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('not found');
  });

  it('still fails on exact ambiguous match without occurrence', () => {
    // Ambiguity detection still runs at the exact-match layer.
    const result = validateEdits('foo foo foo', [
      { old_string: 'foo', new_string: 'bar' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('matches 3 places');
  });
});

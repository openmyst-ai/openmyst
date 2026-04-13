import MarkdownIt from 'markdown-it';
// @ts-expect-error — markdown-it-texmath ships without bundled types, we handle
// the imported function loosely below.
import texmath from 'markdown-it-texmath';
import katex from 'katex';

/**
 * Shared markdown-it instance used by the pending-edit diff widget and the
 * chat renderer. KaTeX is wired via markdown-it-texmath so $...$ (inline) and
 * $$...$$ (block) expressions are pre-rendered to static HTML — meaning the
 * diff shows the formula the same way it'll look once accepted.
 */
function buildRenderer(): MarkdownIt {
  const mdInstance = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
  });
  try {
    mdInstance.use(texmath, {
      engine: katex,
      delimiters: 'dollars',
      katexOptions: { throwOnError: false, output: 'html' },
    });
  } catch (err) {
    console.error('[myst] failed to install texmath plugin', err);
  }
  return mdInstance;
}

export const mystMarkdown = buildRenderer();

export function renderMarkdown(source: string): string {
  try {
    return mystMarkdown.render(source);
  } catch (err) {
    console.error('[myst] markdown render failed', err);
    const safe = source.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
    return `<pre>${safe}</pre>`;
  }
}

/**
 * Render markdown without block wrappers — the raw HTML won't contain a
 * surrounding `<p>`, so it can be dropped inside an inline flow (e.g. the
 * pending-edit widget replacing a word in the middle of a paragraph) without
 * forcing a line break.
 */
export function renderMarkdownInline(source: string): string {
  try {
    return mystMarkdown.renderInline(source);
  } catch (err) {
    console.error('[myst] markdown renderInline failed', err);
    const safe = source.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
    return safe;
  }
}

/** Render a standalone LaTeX expression (no $ delimiters needed). */
export function renderLatex(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      throwOnError: false,
      displayMode,
      output: 'html',
    });
  } catch (err) {
    console.error('[myst] katex render failed', err);
    return `<code>${source}</code>`;
  }
}

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Markdown } from 'tiptap-markdown';
import MarkdownIt from 'markdown-it';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOMParser as PmDOMParser, Slice } from '@tiptap/pm/model';
import { bridge } from '../api/bridge';
import { EditorToolbar } from './EditorToolbar';
import { useHeadings } from '../store/headings';
import { useMystLinkHandler } from '../hooks/useMystLinkHandler';
import { useDocuments } from '../store/documents';
import { useSourcePreview } from '../store/sourcePreview';
import { usePendingEdits } from '../store/pendingEdits';
import { useComments } from '../store/comments';
import { createPendingEditsExtension, pendingEditsKey } from '../tiptap/pendingEditPlugin';
import { createCommentHighlightExtension, commentHighlightKey } from '../tiptap/commentHighlightPlugin';
import { createMathRenderExtension } from '../tiptap/mathRenderPlugin';
import { PendingEditsBanner } from './PendingEditsBanner';
import { CommentFloatingButton } from './CommentFloatingButton';
import type { Heading } from '@shared/types';
import type { Editor } from '@tiptap/core';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

const MarkdownBlockPaste = Extension.create({
  name: 'markdownBlockPaste',
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('markdownBlockPaste'),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData('text/plain');
            if (!text) return false;

            const html = md.render(text);
            const wrapper = document.createElement('div');
            wrapper.innerHTML = html;

            const parsed = PmDOMParser.fromSchema(view.state.schema).parse(wrapper);
            const slice = new Slice(parsed.content, 0, 0);

            if (!slice.content.childCount) return false;

            view.dispatch(view.state.tr.replaceSelection(slice));
            return true;
          },
        },
      }),
    ];
  },
});

type LinkClickCallback = (href: string) => void;

function createMystLinkClickPlugin(onLinkClick: LinkClickCallback): Extension {
  return Extension.create({
    name: 'mystLinkClick',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey('mystLinkClick'),
          props: {
            handleDOMEvents: {
              click(view, event) {
                const target = (event.target as HTMLElement).closest('a');
                if (!target) return false;
                const href = target.getAttribute('href');
                if (!href) return false;
                if (href.startsWith('http://') || href.startsWith('https://')) return false;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                onLinkClick(href);
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}

const findHighlightKey = new PluginKey('findHighlight');

const FindHighlight = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: findHighlightKey,
        state: {
          init() { return DecorationSet.empty; },
          apply(tr, old) {
            const meta = tr.getMeta(findHighlightKey) as DecorationSet | undefined;
            if (meta !== undefined) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return findHighlightKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});

const FONT_SIZE_STORAGE_KEY = 'myst:font-size';
const DEFAULT_FONT_SIZE = 13;

function loadFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE;
  const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FONT_SIZE;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 500;

function extractHeadings(editor: Editor): Heading[] {
  const result: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      result.push({ level: node.attrs['level'] as number, text: node.textContent, pos });
    }
  });
  return result;
}

interface TiptapEditorProps {
  initialValue: string;
  editable: boolean;
  onMarkdownChange: (md: string) => void;
  onEditorReady: (editor: Editor) => void;
  onLinkClick: LinkClickCallback;
}

function TiptapEditor({ initialValue, editable, onMarkdownChange, onEditorReady, onLinkClick }: TiptapEditorProps): JSX.Element {
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;

  const [linkPlugin] = useState(() => createMystLinkClickPlugin((href) => onLinkClickRef.current(href)));
  const [pendingPlugin] = useState(() => createPendingEditsExtension());
  const [commentPlugin] = useState(() => createCommentHighlightExtension());
  const [mathPlugin] = useState(() => createMathRenderExtension());

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Link.configure({ openOnClick: false }),
      Image,
      MarkdownBlockPaste,
      FindHighlight,
      linkPlugin,
      pendingPlugin,
      commentPlugin,
      mathPlugin,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: initialValue,
    onUpdate({ editor: ed }) {
      const storage = ed.storage as unknown as Record<string, { getMarkdown?: () => string }>;
      const md = storage['markdown']?.getMarkdown?.() ?? '';
      onChangeRef.current(md);
    },
  });

  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
      onEditorReady(editor);
    }
  }, [editor, editable, onEditorReady]);

  return <EditorContent editor={editor} className="tiptap-content" />;
}

interface DocumentEditorProps {
  projectPath: string;
  activeFile: string;
}

export function DocumentEditor({ projectPath, activeFile }: DocumentEditorProps): JSX.Element {
  const [initialValue, setInitialValue] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [fontSize, setFontSize] = useState<number>(loadFontSize);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showFind, setShowFind] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('');
  const { setHeadings, scrollToPos, clearScroll } = useHeadings();
  const { files, setActive } = useDocuments();
  const openPreview = useSourcePreview((s) => s.open);
  useMystLinkHandler();
  const prevHeadingsJson = useRef('');

  const pendingStore = usePendingEdits();
  const commentsStore = useComments();
  const pendingEdits = pendingStore.edits;
  const comments = commentsStore.comments;
  const draftComment = commentsStore.draft;
  const activeEdit = pendingEdits[0] ?? null;

  const handleLinkClick = useCallback((href: string) => {
    if (!href.endsWith('.md')) return;
    const filename = href.replace(/^\.?\/?/, '');
    const doc = files.find((f) => f.filename === filename);
    if (doc) {
      setActive(doc.filename);
      return;
    }
    const slug = filename.replace(/\.md$/, '');
    bridge.sources.list().then((sources) => {
      const source = sources.find((s) => s.slug === slug);
      if (source) openPreview(source);
    }).catch(console.error);
  }, [files, setActive, openPreview]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowFind((prev) => !prev);
      }
      if (e.key === 'Escape') {
        setShowFind(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    let cancelled = false;
    setInitialValue(null);
    setLoadError(null);
    setEditor(null);
    bridge.document
      .read(activeFile)
      .then((content) => {
        if (cancelled) return;
        lastSavedRef.current = content;
        setInitialValue(content);
        setStatus('saved');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(err.message);
      });
    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [projectPath, activeFile]);

  const [contentVersion, setContentVersion] = useState(0);

  useEffect(() => {
    const off = bridge.document.onChanged(() => {
      bridge.document.read(activeFile).then((content) => {
        lastSavedRef.current = content;
        setInitialValue(content);
        setContentVersion((v) => v + 1);
      }).catch(console.error);
    });
    return off;
  }, [activeFile]);

  useEffect(() => {
    if (!activeFile) return;
    void pendingStore.load(activeFile);
    void commentsStore.load(activeFile);
  }, [activeFile, pendingStore.load, commentsStore.load]);

  useEffect(() => {
    const offPending = bridge.pendingEdits.onChanged(() => {
      const doc = activeFileRefInner.current;
      if (doc) void usePendingEdits.getState().load(doc);
    });
    const offComments = bridge.comments.onChanged(() => {
      const doc = activeFileRefInner.current;
      if (doc) void useComments.getState().load(doc);
    });
    return () => {
      offPending();
      offComments();
    };
  }, []);

  const prevDispatchRef = useRef<{ editor: Editor | null; activeKey: string | null }>({
    editor: null,
    activeKey: null,
  });
  useEffect(() => {
    if (!editor) return;
    // Dispatch when either the editor instance OR the active-edit key changes.
    // Tracking editor identity matters because a Document.Changed broadcast
    // remounts TiptapEditor (bumped contentVersion → new editor instance); if
    // we only gated on activeKey, a fresh editor whose activeKey happened to
    // match the previous dispatch would never receive its pending-edit meta
    // and the second edit in a batch would land undecorated.
    const nextKey = activeEdit ? `${activeEdit.id}|${activeEdit.newString}` : null;
    const prev = prevDispatchRef.current;
    if (prev.editor === editor && prev.activeKey === nextKey) return;
    prevDispatchRef.current = { editor, activeKey: nextKey };
    const tr = editor.state.tr.setMeta(pendingEditsKey, activeEdit ? [activeEdit] : []);
    editor.view.dispatch(tr);
  }, [editor, activeEdit, contentVersion]);

  useEffect(() => {
    if (!editor) return;
    const merged = draftComment ? [...comments, draftComment] : comments;
    const tr = editor.state.tr.setMeta(commentHighlightKey, merged);
    editor.view.dispatch(tr);
  }, [editor, comments, draftComment, contentVersion]);

  const [pendingError, setPendingError] = useState<string | null>(null);

  const handleAcceptActive = useCallback(async () => {
    if (!activeEdit) return;
    try {
      await usePendingEdits.getState().accept(activeEdit.id);
      setPendingError(null);
    } catch (err) {
      console.error('accept pending failed', err);
      setPendingError((err as Error).message);
    }
  }, [activeEdit]);

  const handleRejectActive = useCallback(async () => {
    if (!activeEdit) return;
    try {
      await usePendingEdits.getState().reject(activeEdit.id);
      setPendingError(null);
    } catch (err) {
      console.error('reject pending failed', err);
      setPendingError((err as Error).message);
    }
  }, [activeEdit]);

  const activeFileRefInner = useRef(activeFile);
  activeFileRefInner.current = activeFile;

  const syncHeadings = useCallback(() => {
    if (!editor) return;
    const headings = extractHeadings(editor);
    const json = JSON.stringify(headings);
    if (json !== prevHeadingsJson.current) {
      prevHeadingsJson.current = json;
      setHeadings(headings);
    }
  }, [editor, setHeadings]);

  useEffect(() => {
    syncHeadings();
    const id = setInterval(syncHeadings, 800);
    return () => clearInterval(id);
  }, [syncHeadings]);

  useEffect(() => {
    if (scrollToPos === null || !editor) return;
    try {
      const view = editor.view;
      const node = view.nodeDOM(scrollToPos);
      const el = node instanceof HTMLElement ? node : null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // position may be stale
    }
    clearScroll();
  }, [scrollToPos, editor, clearScroll]);

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  // Autosave must be suspended while pending edits exist. Otherwise TipTap's
  // re-parse → re-serialize cycle subtly renormalizes whitespace, and the
  // file diverges from the `oldString` captured when the LLM staged the edit.
  // That makes accepting the next edit in the batch fail with "could not
  // locate the original text".
  const pendingEditsCount = pendingEdits.length;
  const pendingCountRef = useRef(pendingEditsCount);
  pendingCountRef.current = pendingEditsCount;

  const scheduleSave = useCallback(
    (markdown: string): void => {
      if (markdown === lastSavedRef.current) return;
      if (pendingCountRef.current > 0) return;
      setStatus('saving');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        bridge.document
          .write(activeFileRef.current, markdown)
          .then(() => {
            lastSavedRef.current = markdown;
            setStatus('saved');
          })
          .catch((err: Error) => {
            console.error('document write failed', err);
            setStatus('error');
          });
      }, AUTOSAVE_DELAY_MS);
    },
    [],
  );

  const handleEditorReady = useCallback((ed: Editor) => {
    setEditor(ed);
    // tiptap-markdown's serializer isn't a perfect inverse of markdown-it's
    // parser — it escapes characters markdown-it passes through unchanged
    // (e.g. brackets inside plain text). Seed the baseline with tiptap's own
    // re-serialized form so the first stray onUpdate doesn't flush the
    // re-normalized document to disk, which previously caused backslashes to
    // accumulate across every load-save round trip.
    const storage = ed.storage as unknown as Record<string, { getMarkdown?: () => string }>;
    const serialized = storage['markdown']?.getMarkdown?.();
    if (serialized !== undefined) {
      lastSavedRef.current = serialized;
    }
  }, []);

  const surfaceStyle = { '--doc-font-size': `${fontSize}px` } as CSSProperties;

  if (loadError) {
    return (
      <div className="document-editor" style={surfaceStyle}>
        <div className="document-error">
          <p>Could not load document: {loadError}</p>
        </div>
      </div>
    );
  }

  if (initialValue === null) {
    return (
      <div className="document-editor" style={surfaceStyle}>
        <div className="document-loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="document-editor" style={surfaceStyle}>
      <EditorToolbar editor={editor} fontSize={fontSize} onFontSize={setFontSize} />
      {showFind && <FindBar editor={editor} onClose={() => setShowFind(false)} />}
      <PendingEditsBanner
        activeEdit={activeEdit}
        error={pendingError}
        onAccept={() => void handleAcceptActive()}
        onReject={() => void handleRejectActive()}
      />
      <div className="document-body">
        <div className="document-scroll">
          <div className="document-page">
            <TiptapEditor
              key={`${projectPath}-${activeFile}-${contentVersion}`}
              initialValue={initialValue}
              editable={true}
              onMarkdownChange={scheduleSave}
              onEditorReady={handleEditorReady}
              onLinkClick={handleLinkClick}
            />
          </div>
          <CommentFloatingButton editor={editor} activeFile={activeFile} disabled={false} />
        </div>
      </div>
      <SaveIndicator status={status} />
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }): JSX.Element | null {
  if (status === 'idle') return null;
  const label =
    status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save failed';
  return <div className={`save-indicator save-${status}`}>{label}</div>;
}

interface FindBarProps {
  editor: Editor | null;
  onClose: () => void;
}

function FindBar({ editor, onClose }: FindBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const findMatches = useCallback(
    (q: string): Array<{ from: number; to: number }> => {
      if (!editor || !q) return [];
      const results: Array<{ from: number; to: number }> = [];
      const lower = q.toLowerCase();
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const text = node.text.toLowerCase();
        let idx = text.indexOf(lower);
        while (idx !== -1) {
          results.push({ from: pos + idx, to: pos + idx + q.length });
          idx = text.indexOf(lower, idx + 1);
        }
      });
      return results;
    },
    [editor],
  );

  const clearHighlights = useCallback(() => {
    if (!editor) return;
    const tr = editor.state.tr.setMeta(findHighlightKey, DecorationSet.empty);
    editor.view.dispatch(tr);
  }, [editor]);

  const highlightAndScroll = useCallback(
    (q: string, index: number) => {
      if (!editor) return;
      const matches = findMatches(q);
      setMatchCount(matches.length);
      if (matches.length === 0) {
        setCurrentMatch(0);
        clearHighlights();
        return;
      }
      const i = ((index % matches.length) + matches.length) % matches.length;
      setCurrentMatch(i + 1);

      const decos = matches.map((m, idx) =>
        Decoration.inline(m.from, m.to, {
          class: idx === i ? 'find-highlight-current' : 'find-highlight',
        }),
      );
      const tr = editor.state.tr.setMeta(findHighlightKey, DecorationSet.create(editor.state.doc, decos));
      editor.view.dispatch(tr);

      const match = matches[i];
      if (!match) return;
      const view = editor.view;
      const dom = view.domAtPos(match.from);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [editor, findMatches, clearHighlights],
  );

  const handleChange = useCallback(
    (val: string) => {
      setQuery(val);
      if (val) {
        highlightAndScroll(val, 0);
      } else {
        setMatchCount(0);
        setCurrentMatch(0);
        clearHighlights();
      }
    },
    [highlightAndScroll, clearHighlights],
  );

  const goNext = useCallback(() => {
    if (query) highlightAndScroll(query, currentMatch);
  }, [query, currentMatch, highlightAndScroll]);

  const goPrev = useCallback(() => {
    if (query) highlightAndScroll(query, currentMatch - 2);
  }, [query, currentMatch, highlightAndScroll]);

  const handleClose = useCallback(() => {
    clearHighlights();
    onClose();
  }, [clearHighlights, onClose]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      }
      if (e.key === 'Escape') {
        handleClose();
      }
    },
    [goNext, goPrev, handleClose],
  );

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        type="text"
        className="find-input"
        placeholder="Find…"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="find-count">
        {query ? `${currentMatch}/${matchCount}` : ''}
      </span>
      <button type="button" className="find-btn" onClick={goPrev} disabled={matchCount === 0} title="Previous (Shift+Enter)">
        &#x25B2;
      </button>
      <button type="button" className="find-btn" onClick={goNext} disabled={matchCount === 0} title="Next (Enter)">
        &#x25BC;
      </button>
      <button type="button" className="find-btn find-close" onClick={handleClose} title="Close (Esc)">
        &#x2715;
      </button>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { bridge } from '../api/bridge';
import { EditorToolbar } from './EditorToolbar';
import { useHeadings } from '../store/headings';
import type { Heading } from '@shared/types';
import type { Editor } from '@tiptap/core';

const MarkdownBlockPaste = Extension.create({
  name: 'markdownBlockPaste',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('markdownBlockPaste'),
        props: {
          handlePaste(view, event) {
            const html = event.clipboardData?.getData('text/html');
            if (html) return false;

            const text = event.clipboardData?.getData('text/plain');
            if (!text) return false;

            const storage = editor.storage as unknown as Record<
              string,
              { parser?: { parse: (t: string, opts?: { inline?: boolean }) => string } }
            >;
            const parser = storage['markdown']?.parser;
            if (!parser) return false;

            const parsed = parser.parse(text);
            const el = document.createElement('div');
            el.innerHTML = parsed;

            const slice = PmDOMParser.fromSchema(view.state.schema).parseSlice(el, {
              preserveWhitespace: true,
            });

            const { tr } = view.state;
            tr.replaceSelection(slice);
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

const FONT_SIZE_STORAGE_KEY = 'myst:font-size';
const DEFAULT_FONT_SIZE = 18;

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
  onMarkdownChange: (md: string) => void;
  onEditorReady: (editor: Editor) => void;
}

function TiptapEditor({ initialValue, onMarkdownChange, onEditorReady }: TiptapEditorProps): JSX.Element {
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;

  const editor = useEditor({
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
    if (editor) onEditorReady(editor);
  }, [editor, onEditorReady]);

  return <EditorContent editor={editor} className="tiptap-content" />;
}

interface DocumentEditorProps {
  projectPath: string;
}

export function DocumentEditor({ projectPath }: DocumentEditorProps): JSX.Element {
  const [initialValue, setInitialValue] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [fontSize, setFontSize] = useState<number>(loadFontSize);
  const [editor, setEditor] = useState<Editor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('');
  const { setHeadings, scrollToPos, clearScroll } = useHeadings();
  const prevHeadingsJson = useRef('');

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    let cancelled = false;
    setInitialValue(null);
    setLoadError(null);
    setEditor(null);
    bridge.document
      .read()
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
  }, [projectPath]);

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
      const dom = view.domAtPos(scrollToPos);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // position may be stale
    }
    clearScroll();
  }, [scrollToPos, editor, clearScroll]);

  const scheduleSave = useCallback(
    (markdown: string): void => {
      if (markdown === lastSavedRef.current) return;
      setStatus('saving');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        bridge.document
          .write(markdown)
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
      <div className="document-scroll">
        <div className="document-page">
          <TiptapEditor
            key={projectPath}
            initialValue={initialValue}
            onMarkdownChange={scheduleSave}
            onEditorReady={handleEditorReady}
          />
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

import { useCallback, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';

interface EditorToolbarProps {
  editor: Editor | null;
  fontSize: number;
  onFontSize: (size: number) => void;
}

const MIN_SIZE = 11;
const MAX_SIZE = 18;
const SIZE_STEP = 1;

export function EditorToolbar({ editor, fontSize, onFontSize }: EditorToolbarProps): JSX.Element {
  const run = (fn: (e: Editor) => void): void => {
    if (!editor) return;
    fn(editor);
  };

  const addLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = (editor.getAttributes('link')['href'] as string) || '';
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  const insertTable = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }, [editor]);

  return (
    <div className="editor-toolbar" role="toolbar">
      <div className="toolbar-group">
        <ToolbarButton
          title="Paragraph"
          active={editor?.isActive('paragraph') && !editor?.isActive('heading')}
          onClick={() => run((e) => e.chain().focus().setParagraph().run())}
        >
          <span className="label">Text</span>
        </ToolbarButton>
        <ToolbarButton
          title="Heading 1"
          active={editor?.isActive('heading', { level: 1 })}
          onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())}
        >
          <span className="label">H1</span>
        </ToolbarButton>
        <ToolbarButton
          title="Heading 2"
          active={editor?.isActive('heading', { level: 2 })}
          onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}
        >
          <span className="label">H2</span>
        </ToolbarButton>
        <ToolbarButton
          title="Heading 3"
          active={editor?.isActive('heading', { level: 3 })}
          onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())}
        >
          <span className="label">H3</span>
        </ToolbarButton>
      </div>

      <Divider />

      <div className="toolbar-group">
        <ToolbarButton
          title="Bold (⌘B)"
          active={editor?.isActive('bold')}
          onClick={() => run((e) => e.chain().focus().toggleBold().run())}
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          title="Italic (⌘I)"
          active={editor?.isActive('italic')}
          onClick={() => run((e) => e.chain().focus().toggleItalic().run())}
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          title="Strikethrough"
          active={editor?.isActive('strike')}
          onClick={() => run((e) => e.chain().focus().toggleStrike().run())}
        >
          <span className="strike">S</span>
        </ToolbarButton>
        <ToolbarButton
          title="Inline code"
          active={editor?.isActive('code')}
          onClick={() => run((e) => e.chain().focus().toggleCode().run())}
        >
          <span className="mono">{'</>'}</span>
        </ToolbarButton>
        <ToolbarButton
          title="Link (⌘K)"
          active={editor?.isActive('link')}
          onClick={addLink}
        >
          <LinkIcon />
        </ToolbarButton>
      </div>

      <Divider />

      <div className="toolbar-group">
        <ToolbarButton
          title="Bulleted list"
          active={editor?.isActive('bulletList')}
          onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}
        >
          <BulletIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          active={editor?.isActive('orderedList')}
          onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}
        >
          <NumberedIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Quote"
          active={editor?.isActive('blockquote')}
          onClick={() => run((e) => e.chain().focus().toggleBlockquote().run())}
        >
          <QuoteIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Code block"
          active={editor?.isActive('codeBlock')}
          onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}
        >
          <CodeBlockIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Insert table (coming soon)"
          onClick={insertTable}
          disabled
        >
          <TableIcon />
        </ToolbarButton>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group font-size-group">
        <ToolbarButton
          title="Decrease font size"
          onClick={() => onFontSize(Math.max(MIN_SIZE, fontSize - SIZE_STEP))}
          disabled={fontSize <= MIN_SIZE}
        >
          <span className="size-small">A</span>
        </ToolbarButton>
        <span className="font-size-readout">{fontSize}</span>
        <ToolbarButton
          title="Increase font size"
          onClick={() => onFontSize(Math.min(MAX_SIZE, fontSize + SIZE_STEP))}
          disabled={fontSize >= MAX_SIZE}
        >
          <span className="size-large">A</span>
        </ToolbarButton>
      </div>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="toolbar-divider" aria-hidden="true" />;
}

interface ToolbarButtonProps {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}

function ToolbarButton({ title, onClick, disabled, active, children }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`toolbar-btn${active ? ' toolbar-btn-active' : ''}`}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/* Inline SVG icons — 14px, currentColor, crisp on retina. */

function BulletIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="4" r="1.2" fill="currentColor" />
      <circle cx="3" cy="8" r="1.2" fill="currentColor" />
      <circle cx="3" cy="12" r="1.2" fill="currentColor" />
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function NumberedIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <text x="0.5" y="5.8" fontSize="4.2" fill="currentColor" fontFamily="system-ui">1.</text>
      <text x="0.5" y="10" fontSize="4.2" fill="currentColor" fontFamily="system-ui">2.</text>
      <text x="0.5" y="14.2" fontSize="4.2" fill="currentColor" fontFamily="system-ui">3.</text>
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function QuoteIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 4.5C3.1 5.1 2.2 6.4 2.2 7.9V11h3.3V7.9H4.1c.1-.6.5-1.1 1.1-1.4l-.7-2zm5.2 0c-1.4.6-2.3 1.9-2.3 3.4V11h3.3V7.9H9.3c.1-.6.5-1.1 1.1-1.4l-.7-2z"
        fill="currentColor"
      />
    </svg>
  );
}

function CodeBlockIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LinkIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 9.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24l-1 1M9.5 6.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24l1-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TableIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 6.5h13M1.5 10.5h13M6 2.5v11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

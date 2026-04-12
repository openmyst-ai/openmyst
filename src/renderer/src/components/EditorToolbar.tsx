import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { callCommand } from '@milkdown/kit/utils';
import { useInstance } from '@milkdown/react';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  downgradeHeadingCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { CmdKey } from '@milkdown/kit/core';

interface EditorToolbarProps {
  fontSize: number;
  onFontSize: (size: number) => void;
}

const MIN_SIZE = 14;
const MAX_SIZE = 24;
const SIZE_STEP = 1;

export function EditorToolbar({ fontSize, onFontSize }: EditorToolbarProps): JSX.Element {
  const [loading, getEditor] = useInstance();

  const run = useCallback(
    <T,>(key: CmdKey<T>, payload?: T): void => {
      if (loading) return;
      const editor = getEditor();
      if (!editor) return;
      editor.action(callCommand(key, payload));
    },
    [loading, getEditor],
  );

  return (
    <div className="editor-toolbar" role="toolbar">
      <div className="toolbar-group">
        <ToolbarButton
          title="Paragraph"
          onClick={() => run(downgradeHeadingCommand.key)}
        >
          <span className="label">Text</span>
        </ToolbarButton>
        <ToolbarButton title="Heading 1" onClick={() => run(wrapInHeadingCommand.key, 1)}>
          <span className="label">H1</span>
        </ToolbarButton>
        <ToolbarButton title="Heading 2" onClick={() => run(wrapInHeadingCommand.key, 2)}>
          <span className="label">H2</span>
        </ToolbarButton>
        <ToolbarButton title="Heading 3" onClick={() => run(wrapInHeadingCommand.key, 3)}>
          <span className="label">H3</span>
        </ToolbarButton>
      </div>

      <Divider />

      <div className="toolbar-group">
        <ToolbarButton title="Bold (⌘B)" onClick={() => run(toggleStrongCommand.key)}>
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton title="Italic (⌘I)" onClick={() => run(toggleEmphasisCommand.key)}>
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          title="Strikethrough"
          onClick={() => run(toggleStrikethroughCommand.key)}
        >
          <span className="strike">S</span>
        </ToolbarButton>
        <ToolbarButton title="Inline code" onClick={() => run(toggleInlineCodeCommand.key)}>
          <span className="mono">{'</>'}</span>
        </ToolbarButton>
      </div>

      <Divider />

      <div className="toolbar-group">
        <ToolbarButton
          title="Bulleted list"
          onClick={() => run(wrapInBulletListCommand.key)}
        >
          <BulletIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          onClick={() => run(wrapInOrderedListCommand.key)}
        >
          <NumberedIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Quote"
          onClick={() => run(wrapInBlockquoteCommand.key)}
        >
          <QuoteIcon />
        </ToolbarButton>
        <ToolbarButton
          title="Code block"
          onClick={() => run(createCodeBlockCommand.key)}
        >
          <CodeBlockIcon />
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
  children: ReactNode;
}

function ToolbarButton({ title, onClick, disabled, children }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="toolbar-btn"
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

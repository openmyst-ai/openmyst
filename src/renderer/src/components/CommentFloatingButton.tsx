import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Comment } from '@shared/types';
import { useComments } from '../store/comments';
import { bridge } from '../api/bridge';

interface CommentFloatingButtonProps {
  editor: Editor | null;
  activeFile: string;
  disabled: boolean;
}

interface Position {
  top: number;
  left: number;
}

interface SelectionSnapshot {
  text: string;
  contextBefore: string;
  contextAfter: string;
}

const CONTEXT_CHARS = 24;
const DRAFT_ID = '__draft__';

function buildSnapshot(editor: Editor): SelectionSnapshot | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, '\n');
  if (!text.trim()) return null;

  const beforeFrom = Math.max(0, from - CONTEXT_CHARS);
  const afterTo = Math.min(editor.state.doc.content.size, to + CONTEXT_CHARS);
  const contextBefore = editor.state.doc.textBetween(beforeFrom, from, '\n');
  const contextAfter = editor.state.doc.textBetween(to, afterTo, '\n');
  return { text, contextBefore, contextAfter };
}

function makeDraft(
  activeFile: string,
  snapshot: SelectionSnapshot,
): Comment {
  return {
    id: DRAFT_ID,
    docFilename: activeFile,
    text: snapshot.text,
    contextBefore: snapshot.contextBefore,
    contextAfter: snapshot.contextAfter,
    message: '',
    createdAt: new Date().toISOString(),
  };
}

export function CommentFloatingButton({
  editor,
  activeFile,
  disabled,
}: CommentFloatingButtonProps): JSX.Element | null {
  const [position, setPosition] = useState<Position | null>(null);
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null);
  const comments = useComments((s) => s.comments);
  const createComment = useComments((s) => s.create);
  const deleteComment = useComments((s) => s.delete);
  const setDraft = useComments((s) => s.setDraft);
  const reopenId = useComments((s) => s.reopenId);
  const setReopen = useComments((s) => s.setReopen);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editor || disabled || composing) {
      if (!composing) {
        setPosition(null);
        setSnapshot(null);
      }
      return;
    }

    const handler = (): void => {
      const snap = buildSnapshot(editor);
      if (!snap) {
        setPosition(null);
        setSnapshot(null);
        return;
      }
      const { from, to } = editor.state.selection;
      try {
        const startCoords = editor.view.coordsAtPos(from);
        const endCoords = editor.view.coordsAtPos(to);
        const top = Math.min(startCoords.top, endCoords.top) - 44;
        const left = (startCoords.left + endCoords.right) / 2;
        setPosition({ top, left });
        setSnapshot(snap);
      } catch {
        setPosition(null);
        setSnapshot(null);
      }
    };

    editor.on('selectionUpdate', handler);
    return () => {
      editor.off('selectionUpdate', handler);
    };
  }, [editor, disabled, composing]);

  useEffect(() => {
    if (composing) {
      textareaRef.current?.focus();
    }
  }, [composing]);

  const closeAll = useCallback(() => {
    setComposing(false);
    setMessage('');
    setPosition(null);
    setSnapshot(null);
    setExistingId(null);
    setDraft(null);
  }, [setDraft]);

  const handleStart = useCallback(() => {
    if (!snapshot) return;
    setDraft(makeDraft(activeFile, snapshot));
    setComposing(true);
  }, [snapshot, activeFile, setDraft]);

  // Reopen a saved comment when the user clicks on its highlight.
  useEffect(() => {
    if (!reopenId || !editor) return;
    const comment = comments.find((c) => c.id === reopenId);
    setReopen(null);
    if (!comment) return;
    try {
      const el = editor.view.dom.querySelector(
        `[data-comment-id="${reopenId}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPosition({ top: rect.top - 44, left: rect.left + rect.width / 2 });
    } catch {
      return;
    }
    setSnapshot({
      text: comment.text,
      contextBefore: comment.contextBefore,
      contextAfter: comment.contextAfter,
    });
    setMessage(comment.message);
    setExistingId(comment.id);
    setComposing(true);
  }, [reopenId, editor, comments, setReopen]);

  const handleSave = useCallback(async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      if (existingId) {
        await deleteComment(existingId);
      }
      await createComment({
        text: snapshot.text,
        contextBefore: snapshot.contextBefore,
        contextAfter: snapshot.contextAfter,
        message: message.trim(),
      });
      closeAll();
    } catch (err) {
      console.error('save comment failed', err);
    } finally {
      setBusy(false);
    }
  }, [snapshot, busy, existingId, deleteComment, createComment, message, closeAll]);

  const handleDelete = useCallback(async () => {
    if (!existingId || busy) return;
    setBusy(true);
    try {
      await deleteComment(existingId);
      closeAll();
    } catch (err) {
      console.error('delete comment failed', err);
    } finally {
      setBusy(false);
    }
  }, [existingId, busy, deleteComment, closeAll]);

  const handleAskMyst = useCallback(async () => {
    if (!snapshot || !message.trim() || busy) return;
    setBusy(true);
    // Clear yellow/composer BEFORE triggering chat — user wants highlight gone "before the editing kicks off".
    const snap = snapshot;
    const note = message.trim();
    const prevExistingId = existingId;
    closeAll();

    try {
      if (prevExistingId) {
        await deleteComment(prevExistingId);
      }
    } catch (err) {
      console.error('delete existing comment failed', err);
    }

    // IMPORTANT: the comment flow defaults to CHAT, not edit. The user is
    // pointing at a passage and asking about it — "define this", "what does
    // this mean", "why is this phrased this way". Only treat it as an edit
    // request when the note is unambiguously a change instruction.
    const prompt =
      `COMMENT CONTEXT — this overrides the default edit-first behaviour.\n\n` +
      `The user highlighted a passage in the document and attached a note. Your job is to decide whether the note is:\n` +
      `  (A) A question, clarification, definition request, or discussion about the passage → ANSWER BRIEFLY IN CHAT. Do NOT emit myst_edit. Do NOT modify the document.\n` +
      `  (B) An explicit instruction to CHANGE the passage (rewrite, shorten, rename, fix typo, add something) → emit myst_edit block(s) as usual.\n\n` +
      `Default to (A). Only pick (B) when the note clearly asks for a change to the text itself.\n` +
      `Examples of (A) — chat only:\n` +
      `  • "define this"  • "what does this mean"  • "explain this"  • "is this accurate"  • "why"\n` +
      `Examples of (B) — edit:\n` +
      `  • "rewrite this"  • "make it shorter"  • "change X to Y"  • "fix the typo"  • "add a sentence about Z"\n\n` +
      `Passage:\n"""\n${snap.text}\n"""\n\n` +
      `User note: ${note}`;
    // What the user sees in the chat history — clean, no scaffolding.
    const displayText = `> ${snap.text.replace(/\n+/g, ' ')}\n\n${note}`;
    try {
      await bridge.chat.send(prompt, activeFile, displayText);
    } catch (err) {
      console.error('ask myst failed', err);
    } finally {
      setBusy(false);
    }
  }, [snapshot, message, busy, existingId, deleteComment, activeFile, closeAll]);

  useEffect(() => {
    if (!composing) return;
    const handler = (e: MouseEvent): void => {
      const el = composerRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      // Click outside — treat as implicit save.
      void handleSave();
    };
    // Defer so the triggering mousedown doesn't immediately fire us.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [composing, handleSave]);

  if (!position || !snapshot) return null;

  const style = {
    top: `${position.top}px`,
    left: `${position.left}px`,
  };

  if (composing) {
    const preview = snapshot.text.replace(/\s+/g, ' ').trim();
    const truncated = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
    return (
      <div ref={composerRef} className="comment-composer" style={style}>
        <div className="comment-composer-header">
          <span className="comment-composer-label">
            {existingId ? 'Comment' : 'New comment'}
          </span>
          <button
            type="button"
            className="comment-composer-close"
            onClick={closeAll}
            title="Close"
            aria-label="Close"
          >
            &#x2715;
          </button>
        </div>
        <blockquote className="comment-composer-quote">{truncated}</blockquote>
        <textarea
          ref={textareaRef}
          className="comment-composer-input"
          placeholder={existingId ? 'Edit your note…' : 'Add a note, or ask Myst…'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              void handleSave();
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleAskMyst();
            }
          }}
          rows={3}
        />
        <div className="comment-composer-actions">
          {existingId && (
            <button
              type="button"
              className="comment-action danger comment-action-delete"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              Delete
            </button>
          )}
          <button
            type="button"
            className="comment-action"
            onClick={() => void handleSave()}
            disabled={busy}
          >
            Save
          </button>
          <button
            type="button"
            className="comment-action primary"
            onClick={() => void handleAskMyst()}
            disabled={busy || !message.trim()}
          >
            Ask Myst
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="comment-floating-btn"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleStart}
      title="Add comment"
    >
      Comment
    </button>
  );
}

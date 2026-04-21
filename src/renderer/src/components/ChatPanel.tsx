import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { USE_OPENMYST } from '@shared/flags';
import type { ChatMessage } from '@shared/types';
import { useApp } from '../store/app';
import { useDocuments } from '../store/documents';
import { useMe } from '../store/me';
import { useMystLinkHandler } from '../hooks/useMystLinkHandler';
import { bridge } from '../api/bridge';
import { renderMarkdown } from '../utils/markdown';
import { stripChatFences } from '../utils/stripChatFences';
import { ApproachingLimitBanner, PoweredByModel, QuotaPills } from './QuotaPills';

function MarkdownContent({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="chat-msg-content chat-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ChatPanel(): JSX.Element {
  const { settings, openSettings } = useApp();
  // BYOK-only gate. In managed mode there is no user-facing key to check;
  // the App-level auth gate already stops unsigned-in users from getting here.
  const needsKey = !USE_OPENMYST && settings && !settings.hasOpenRouterKey;

  if (needsKey) {
    return (
      <div className="chat-panel">
        <h2>Chat</h2>
        <div className="muted">
          <p>Set your OpenRouter API key to start chatting.</p>
          <button type="button" className="link" onClick={openSettings}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return <ChatView />;
}

function stripEditBlocks(text: string): { visible: string; isWriting: boolean } {
  const { visible, isWriting } = stripChatFences(text);
  const cleaned = visible
    .replace(/`myst_edit`/gi, '')
    .replace(/myst_edit/gi, '')
    .replace(/old_string/g, '')
    .replace(/new_string/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { visible: cleaned, isWriting };
}

function ChatView(): JSX.Element {
  const activeFile = useDocuments((s) => s.activeFile);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useMystLinkHandler();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bridge.chat.history().then(setMessages).catch(console.error);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  useEffect(() => {
    const offStarted = bridge.chat.onStarted(() => {
      // A new turn has begun (possibly from outside the chat panel, e.g.
      // Ask Myst). Pull the new user message in and show the typing state
      // immediately — don't wait for the first stream chunk.
      setSending(true);
      setStreamingText('');
      bridge.chat.history().then(setMessages).catch(console.error);
    });
    const offChunk = bridge.chat.onChunk((chunk) => {
      setStreamingText((prev) => prev + chunk);
    });
    const offDone = bridge.chat.onChunkDone(() => {
      setStreamingText('');
      setSending(false);
      bridge.chat.history().then(setMessages).catch(console.error);
    });
    return () => {
      offStarted();
      offChunk();
      offDone();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !activeFile) return;
    // Block chat sends when the daily free quota is exhausted; search path
    // is unaffected so deep search can continue (changes.md §6).
    const chatQuota = useMe.getState().snapshot?.quota.chat;
    if (chatQuota && chatQuota.limit !== null && (chatQuota.remaining ?? 1) <= 0) {
      setError('Daily chat limit reached. Upgrade to Pro for unlimited access.');
      return;
    }

    setInput('');
    setError(null);
    // onStarted / onChunkDone drive `sending`, `streamingText`, and
    // history refresh — no local optimistic inserts needed.
    try {
      await bridge.chat.send(text, activeFile);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
      setStreamingText('');
    } finally {
      inputRef.current?.focus();
    }
  }, [input, sending, activeFile]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleClear = useCallback(async () => {
    await bridge.chat.clear();
    setMessages([]);
    setError(null);
  }, []);

  const me = useMe((s) => s.snapshot);
  const chatExhausted =
    me?.quota.chat.limit !== null &&
    me?.quota.chat.remaining !== null &&
    (me?.quota.chat.remaining ?? 1) <= 0;
  const sendDisabled = sending || Boolean(chatExhausted);

  return (
    <div className="chat-panel chat-active">
      <div className="chat-header">
        <div className="chat-header-title">
          <h2>Chat</h2>
          <PoweredByModel />
        </div>
        <div className="chat-header-right">
          <QuotaPills />
          {messages.length > 0 && (
            <button type="button" className="link chat-clear-btn" onClick={() => void handleClear()}>
              Clear
            </button>
          )}
        </div>
      </div>
      <ApproachingLimitBanner />

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !sending && (
          <p className="muted chat-empty">Ask anything about your document or sources.</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
            <div className="chat-msg-role">{msg.role === 'user' ? 'You' : 'Myst'}</div>
            <MarkdownContent text={msg.content} />
          </div>
        ))}
        {sending && (() => {
          const { visible, isWriting } = streamingText
            ? stripEditBlocks(streamingText)
            : { visible: '', isWriting: false };
          const editingDoc = streamingText.includes('```myst_edit') && isWriting;
          // Always show the dots while a chunk stream is open. Between
          // multi-round lookups (source_lookup / doc_lookup / web_search)
          // the model can go silent for 30–90s while disk/network work
          // happens, and we don't want prose from the previous round to
          // sit there looking frozen.
          return (
            <div className="chat-msg chat-msg-assistant">
              <div className="chat-msg-role">Myst</div>
              {visible && <MarkdownContent text={visible} />}
              <div className="chat-msg-content chat-typing">
                <span className="generating-dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </span>
                {editingDoc ? <span className="editing-indicator"> Editing your document…</span> : null}
              </div>
            </div>
          );
        })()}
      </div>

      {error && (
        <div className="chat-error">
          <span>{error}</span>
          <button type="button" className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="chat-input-area">
        {activeFile && (
          <div className="chat-active-doc">
            editing <strong>{activeFile.replace(/\.md$/, '')}</strong>
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            chatExhausted
              ? 'Daily chat limit reached — upgrade to Pro for unlimited access.'
              : 'Message… (Enter to send, Shift+Enter for newline)'
          }
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sendDisabled}
        />
      </div>
    </div>
  );
}

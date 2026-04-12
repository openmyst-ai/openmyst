import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/types';
import { useApp } from '../store/app';
import { bridge } from '../api/bridge';

export function ChatPanel(): JSX.Element {
  const { settings, openSettings } = useApp();
  const needsKey = settings && !settings.hasOpenRouterKey;

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

function stripEditBlocks(text: string): string {
  let result = text
    .replace(/```myst_edit\s*\n[\s\S]*?```/g, '')
    .trim();
  const partial = result.indexOf('```myst_edit');
  if (partial !== -1) {
    result = result.slice(0, partial).trim();
  }
  result = result
    .replace(/`myst_edit`/gi, '')
    .replace(/myst_edit/gi, '')
    .replace(/old_string/g, '')
    .replace(/new_string/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return result;
}

function ChatView(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bridge.chat.history().then(setMessages).catch(console.error);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  useEffect(() => {
    const offChunk = bridge.chat.onChunk((chunk) => {
      setStreamingText((prev) => prev + chunk);
    });
    const offDone = bridge.chat.onChunkDone(() => {
      setStreamingText('');
    });
    return () => {
      offChunk();
      offDone();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setError(null);
    setSending(true);
    setStreamingText('');

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const assistantMsg = await bridge.chat.send(text);
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
      setStreamingText('');
      inputRef.current?.focus();
    }
  }, [input, sending]);

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

  return (
    <div className="chat-panel chat-active">
      <div className="chat-header">
        <h2>Chat</h2>
        {messages.length > 0 && (
          <button type="button" className="link chat-clear-btn" onClick={() => void handleClear()}>
            Clear
          </button>
        )}
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !sending && (
          <p className="muted chat-empty">Ask anything about your document or sources.</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
            <div className="chat-msg-role">{msg.role === 'user' ? 'You' : 'Myst'}</div>
            <div className="chat-msg-content">{msg.content}</div>
          </div>
        ))}
        {sending && (() => {
          const stripped = streamingText ? stripEditBlocks(streamingText) : '';
          const hasEdits = streamingText.includes('myst_edit');
          const isWritingEdit = hasEdits && !streamingText.trimEnd().endsWith('```');
          return (
            <div className="chat-msg chat-msg-assistant">
              <div className="chat-msg-role">Myst</div>
              {stripped && <div className="chat-msg-content">{stripped}</div>}
              {isWritingEdit ? (
                <div className="chat-msg-content chat-typing">
                  <span className="editing-indicator">
                    <span className="generating-dots">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                    {' '}Editing your document…
                  </span>
                </div>
              ) : !stripped ? (
                <div className="chat-msg-content chat-typing">
                  <span className="generating-dots">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                  </span>
                </div>
              ) : null}
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
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Message…"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <button
          type="button"
          className="chat-send-btn primary"
          onClick={() => void handleSend()}
          disabled={sending || !input.trim()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

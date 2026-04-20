import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeepPlanMessage, DeepPlanSession, WikiGraph as WikiGraphData } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useDeepPlan } from '../../store/deepPlan';
import { useResearchEvents } from '../../store/researchEvents';
import { useSourcePreview } from '../../store/sourcePreview';
import { renderMarkdown } from '../../utils/markdown';
import { stripDeepPlanFences } from './stripFences';
import { WikiGraph, freshSlugsFromEvents } from '../graph/WikiGraph';

function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="dp-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Props {
  session: DeepPlanSession;
}

export function ConversationColumn({ session }: Props): JSX.Element {
  const {
    status,
    streaming,
    streamingBuffer,
    busy,
    sendMessage,
    addResearchHint,
  } = useDeepPlan();
  const [draft, setDraft] = useState('');
  const [steerAck, setSteerAck] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const researchRunning = status?.researchRunning ?? false;

  // Transient "✓ Steering: …" ack under the input — dismisses itself so
  // we don't have to manage clear-on-next-hint etc.
  useEffect(() => {
    if (!steerAck) return;
    const id = window.setTimeout(() => setSteerAck(null), 3200);
    return () => window.clearTimeout(id);
  }, [steerAck]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages.length, streamingBuffer]);

  const stage = session.stage;
  const isResearchStage = stage === 'research';
  const isDone = stage === 'done';

  // During the research stage the single chat input becomes the steering
  // channel — submit it and it's added as a mid-run hint rather than a
  // normal chat turn.
  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text) return;
      if (isResearchStage) {
        if (!researchRunning) return;
        setDraft('');
        setSteerAck(text);
        await addResearchHint(text);
        return;
      }
      if (busy) return;
      setDraft('');
      await sendMessage(text);
    },
    [draft, busy, isResearchStage, researchRunning, sendMessage, addResearchHint],
  );

  // During research the center column becomes the stage: the wiki graph
  // fills it, new sources arrive as pending purple dots that glow when
  // ingested, and a steer input sits pinned at the bottom. The right
  // column meanwhile switches to a query-with-rationale log.
  if (isResearchStage) {
    return (
      <ResearchStageView
        draft={draft}
        setDraft={setDraft}
        steerAck={steerAck}
        handleSend={handleSend}
        researchRunning={researchRunning}
      />
    );
  }

  return (
    <div className="dp-chat">
      <div className="dp-chat-scroll" ref={scrollRef}>
        {session.messages.length === 0 && !streaming && (
          <div className="dp-empty">Starting the Deep Plan conversation…</div>
        )}
        {session.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming && (() => {
          const { visible, isWriting } = stripDeepPlanFences(streamingBuffer);
          return (
            <div className="dp-msg dp-msg-assistant">
              <div className="dp-msg-body">
                {visible && <Markdown text={visible} />}
                {(isWriting || !visible) && (
                  <div className="dp-typing dp-typing-fade">
                    <span className="generating-dots">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                    <span className="dp-muted"> Thinking…</span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="dp-chat-footer">
        <form className="dp-chat-form" onSubmit={(e) => void handleSend(e)}>
          <textarea
            className="dp-chat-input"
            placeholder={isDone ? 'Deep Plan complete.' : 'Write a reply…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e);
              }
            }}
            disabled={isDone || busy}
            rows={2}
          />
          <button
            type="submit"
            className="dp-btn"
            disabled={isDone || draft.trim().length === 0 || busy}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

interface ResearchStageViewProps {
  draft: string;
  setDraft: (s: string) => void;
  steerAck: string | null;
  handleSend: (e: React.FormEvent) => Promise<void>;
  researchRunning: boolean;
}

function ResearchStageView({
  draft,
  setDraft,
  steerAck,
  handleSend,
  researchRunning,
}: ResearchStageViewProps): JSX.Element {
  const [graph, setGraph] = useState<WikiGraphData | null>(null);
  const researchEvents = useResearchEvents((s) => s.events);
  const openPreview = useSourcePreview((s) => s.open);

  useEffect(() => {
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, []);

  const freshSlugs = useMemo(
    () => freshSlugsFromEvents(researchEvents),
    [researchEvents],
  );
  const currentQuery = useMemo(() => latestQueryText(researchEvents), [researchEvents]);
  const flashQuery = useQueryFlash(currentQuery);

  const handleNodeOpen = (slug: string): void => {
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === slug);
      if (full) openPreview(full);
    });
  };

  return (
    <div className="dp-chat dp-chat-research">
      <div className="dp-research-graph-wrap">
        {researchRunning && (
          <div
            className={`dp-research-thinking${flashQuery ? ' dp-research-thinking-flashing' : ''}`}
          >
            <span className="generating-dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
            <span className="dp-research-thinking-label">Researching</span>
            <span
              className={`dp-research-thinking-query${flashQuery ? ' dp-research-thinking-query-open' : ''}`}
            >
              {flashQuery ?? ''}
            </span>
          </div>
        )}
        <WikiGraph
          graph={graph}
          freshSlugs={freshSlugs}
          running={researchRunning}
          onNodeOpen={handleNodeOpen}
          fillContainer
          hideTooltip
          showLabels
          enableZoom
          baseRadius={5}
          radiusPerEdge={2}
          hitRadiusPad={8}
        />
      </div>
      <div className="dp-chat-footer">
        {steerAck && (
          <div className="dp-steer-ack" key={steerAck}>
            <span className="dp-steer-ack-mark">✓</span>
            <span className="dp-steer-ack-label">Steering:</span>
            <span className="dp-steer-ack-text">{steerAck}</span>
          </div>
        )}
        <form className="dp-chat-form" onSubmit={(e) => void handleSend(e)}>
          <textarea
            className="dp-chat-input"
            placeholder="Steer research…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e);
              }
            }}
            disabled={!researchRunning}
            rows={2}
          />
          <button
            type="submit"
            className="dp-btn"
            disabled={!researchRunning || draft.trim().length === 0}
          >
            Steer
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * When the live query text changes to a new non-null value, flash it in
 * the "Researching …" pill for ~3.5s, then collapse the pill back to
 * just "Researching". Each new query resets the timer so rapid-fire
 * queries visibly chain through the bubble instead of a single one
 * sticking.
 */
function useQueryFlash(query: string | null): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!query) return;
    if (query === lastSeenRef.current) return;
    lastSeenRef.current = query;
    setFlash(query);
    const t = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(t);
  }, [query]);
  return flash;
}

function latestQueryText(events: Array<{ kind: string; runId?: string; query?: string }>): string | null {
  // Walk backwards within the current run so a newly-kicked query's text
  // lights up immediately. Resets on run-start so stale text from a
  // previous run doesn't bleed through.
  let runId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (!runId && ev.runId) runId = ev.runId;
    if (ev.kind === 'run-start') return null;
    if (ev.runId !== runId) break;
    if (ev.kind === 'query-start' && typeof ev.query === 'string') {
      return ev.query;
    }
  }
  return null;
}

function MessageBubble({ message }: { message: DeepPlanMessage }): JSX.Element {
  if (message.kind === 'stage-transition') {
    return (
      <div className="dp-stage-transition">
        <span>{message.content}</span>
      </div>
    );
  }
  if (message.kind === 'research-note') {
    return (
      <div className="dp-research-note">
        <div className="dp-research-note-body">
          <Markdown text={message.content} />
        </div>
      </div>
    );
  }
  const klass = message.role === 'user' ? 'dp-msg dp-msg-user' : 'dp-msg dp-msg-assistant';
  const { visible } = stripDeepPlanFences(message.content);
  return (
    <div className={klass}>
      <div className="dp-msg-body">
        <Markdown text={visible || message.content} />
      </div>
    </div>
  );
}

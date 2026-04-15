import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeepPlanMessage, DeepPlanSession, DeepPlanStage } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';
import { useResearchEvents } from '../../store/researchEvents';
import { renderMarkdown } from '../../utils/markdown';
import { stripDeepPlanFences } from './stripFences';
import { ResearchGraph } from '../research/ResearchGraph';

function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="dp-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Props {
  session: DeepPlanSession;
}

const STAGE_HINTS: Record<DeepPlanStage, { continueLabel: string; helper: string }> = {
  intent: { continueLabel: 'Continue', helper: 'Tell the planner what you\'re making.' },
  sources: {
    continueLabel: 'Continue to scoping',
    helper: 'Drop sources on the left. Hit continue when ready.',
  },
  scoping: {
    continueLabel: 'Continue to gap analysis',
    helper: 'Answer the planner\'s questions to shape the rubric.',
  },
  gaps: {
    continueLabel: 'Continue to research',
    helper: 'Review what\'s missing, then hit continue to kick off research.',
  },
  research: {
    continueLabel: 'Continue to clarify',
    helper: 'Researching autonomously — this takes a couple of minutes.',
  },
  clarify: {
    continueLabel: 'Continue to review',
    helper: 'Answer the final clarification questions.',
  },
  review: {
    continueLabel: 'Looks good — write the draft',
    helper: 'Review the plan summary. Hit the button to one-shot the draft.',
  },
  handoff: { continueLabel: 'Generate draft', helper: 'Generating the draft now…' },
  done: { continueLabel: 'Done', helper: 'Deep Plan complete.' },
};

export function ConversationColumn({ session }: Props): JSX.Element {
  const {
    status,
    streaming,
    streamingBuffer,
    busy,
    sendMessage,
    advance,
    oneShot,
    runResearch,
    stopResearch,
    addResearchHint,
  } = useDeepPlan();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const researchEvents = useResearchEvents((s) => s.events);
  const researchRunning = status?.researchRunning ?? false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages.length, streamingBuffer]);

  const stage = session.stage;
  const hint = STAGE_HINTS[stage];
  const isResearchStage = stage === 'research';
  const isReviewStage = stage === 'review';
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
        await addResearchHint(text);
        return;
      }
      if (busy) return;
      setDraft('');
      await sendMessage(text);
    },
    [draft, busy, isResearchStage, researchRunning, sendMessage, addResearchHint],
  );

  return (
    <div className="dp-chat">
      {isResearchStage && (
        <div className="dp-research-graph-wrap">
          <ResearchGraph
            events={researchEvents}
            rootLabel={session.task}
            running={researchRunning}
          />
        </div>
      )}
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
                  <div className="dp-typing">
                    <span className="generating-dots">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </span>
                    <span className="dp-muted">
                      {' '}
                      {isWriting
                        ? 'Planning…'
                        : isResearchStage
                          ? 'Researching…'
                          : 'Thinking…'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="dp-chat-footer">
        <div className="dp-chat-hint">{hint.helper}</div>

        <form className="dp-chat-form" onSubmit={(e) => void handleSend(e)}>
          <textarea
            className="dp-chat-input"
            placeholder={
              isDone
                ? 'Deep Plan complete.'
                : isResearchStage
                  ? 'Steer research…'
                  : 'Write a reply…'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e);
              }
            }}
            disabled={
              isDone || (isResearchStage ? !researchRunning : busy)
            }
            rows={2}
          />
          <button
            type="submit"
            className="dp-btn"
            disabled={
              isDone ||
              draft.trim().length === 0 ||
              (isResearchStage ? !researchRunning : busy)
            }
          >
            {isResearchStage ? 'Steer' : 'Send'}
          </button>
        </form>

        <div className="dp-chat-actions">
          {isResearchStage && researchRunning && (
            <button
              type="button"
              className="dp-btn dp-btn-danger"
              onClick={() => void stopResearch()}
            >
              Stop research
            </button>
          )}
          {isResearchStage && !researchRunning && (
            <button
              type="button"
              className="dp-btn dp-btn-secondary"
              onClick={() => void runResearch()}
              disabled={busy}
            >
              Keep researching
            </button>
          )}
          {isReviewStage ? (
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              onClick={() => void oneShot()}
              disabled={busy}
            >
              {busy ? 'Writing draft…' : 'Write the draft'}
            </button>
          ) : (
            !isDone && (
              <button
                type="button"
                className="dp-btn dp-btn-primary"
                onClick={() => void advance()}
                disabled={busy || (isResearchStage && researchRunning)}
              >
                {hint.continueLabel}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
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

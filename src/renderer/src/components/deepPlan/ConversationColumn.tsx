import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ChairAnswer,
  ChairAnswerMap,
  ChairQuestion,
  DeepPlanMessage,
  DeepPlanSession,
  PanelRole,
} from '@shared/types';
import { useDeepPlan, type PanelProgressState } from '../../store/deepPlan';
import { useResearchEvents } from '../../store/researchEvents';
import { renderMarkdown } from '../../utils/markdown';
import { QuestionCard } from './QuestionCard';
import { CitationHoverScope } from './CitationHoverScope';
import {
  latestQueryText,
  researchRunningFromEvents,
} from '../../hooks/useResearchFlash';

function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="dp-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Props {
  session: DeepPlanSession;
}

export function ConversationColumn({ session }: Props): JSX.Element {
  const { status, busy, chat, runPanel, advance, oneShot, panelProgress } = useDeepPlan();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const roundRunning = status?.roundRunning ?? false;
  const pendingQuestions = session.pendingQuestions ?? [];

  // The Chair signals `phaseAdvance: true` on the last chair-turn when it
  // thinks the phase is done. We surface a contextual CTA inline so the user
  // doesn't have to hunt for the top-bar "Continue" button — keeping the
  // discussion path equally prominent so they can also just keep typing.
  // CTA visibility: once the first chair-turn has landed and nothing's
  // blocking (round not running, no pending questions, not done), always
  // surface the advance CTA. The Chair's `phaseAdvance` hint was too
  // shy at planning/reviewing boundaries — especially without an anchor
  // log to evaluate against — so we hand the decision to the user.
  const shouldShowAdvanceCta = useMemo(() => {
    if (roundRunning || busy) return false;
    if (pendingQuestions.length > 0) return false;
    if (session.phase === 'done') return false;
    const hasChairTurn = session.messages.some((m) => m.kind === 'chair-turn' && m.chair);
    return hasChairTurn;
  }, [session.messages, session.phase, pendingQuestions.length, roundRunning, busy]);

  // Map each `user-answers` message to the Chair questions it was
  // answering, so we can render prompts + labels instead of raw ids.
  // Walk forwards keeping a handle on the most recent chair-turn's
  // questions; when we hit a user-answers message, pair them up.
  const answeredQuestionsById = useMemo(() => {
    const out = new Map<string, ChairQuestion[]>();
    let currentChairQuestions: ChairQuestion[] = [];
    for (const m of session.messages) {
      if (m.kind === 'chair-turn' && m.chair) {
        currentChairQuestions = m.chair.questions;
      } else if (m.kind === 'user-answers') {
        out.set(m.id, currentChairQuestions);
      }
    }
    return out;
  }, [session.messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedRef.current = distance < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [session.messages.length, pendingQuestions.length, roundRunning]);

  const isDone = session.phase === 'done';

  const pendingChatNotes = session.pendingChatNotes ?? [];
  const hasChatNotes = pendingChatNotes.length > 0;

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text || busy) return;
      setDraft('');
      // Default path after the first round: free-chat with the Chair.
      // Before the first round has completed there is nothing to chat about
      // yet, so we no-op silently (the round is firing).
      await chat(text);
    },
    [draft, busy, chat],
  );

  const handleTakeToPanel = useCallback(async () => {
    if (busy || roundRunning) return;
    await runPanel();
  }, [busy, roundRunning, runPanel]);

  return (
    <div className="dp-chat">
      <CitationHoverScope className="dp-chat-scroll" ref={scrollRef}>
        {session.messages.length === 0 && !roundRunning && (
          <div className="dp-empty">Starting the Deep Plan conversation…</div>
        )}
        {session.messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            answeredQuestions={answeredQuestionsById.get(m.id)}
          />
        ))}
        {roundRunning && <PanelProgressPanel progress={panelProgress} />}
        {roundRunning && <SearchingBanner />}
        {!roundRunning && pendingQuestions.length > 0 && (
          <QuestionCard questions={pendingQuestions} />
        )}
        {shouldShowAdvanceCta && (
          <PhaseAdvanceCta
            phase={session.phase}
            onAdvance={() => void (session.phase === 'reviewing' ? oneShot() : advance())}
            disabled={busy}
          />
        )}
      </CitationHoverScope>

      <div className="dp-chat-footer">
        {hasChatNotes && !roundRunning && (
          <div className="dp-chat-notes-chip">
            <span className="dp-chat-notes-label">
              {pendingChatNotes.length} chat {pendingChatNotes.length === 1 ? 'note' : 'notes'} queued for panel
            </span>
            <button
              type="button"
              className="dp-btn dp-btn-ghost dp-btn-small"
              onClick={() => void handleTakeToPanel()}
              disabled={busy}
              title="Run a fresh panel round with your chat notes as context"
            >
              Take to panel
            </button>
          </div>
        )}
        <form className="dp-chat-form" onSubmit={(e) => void handleSend(e)}>
          <AutoResizeTextarea
            className="dp-chat-input"
            placeholder={
              isDone
                ? 'Deep Plan complete.'
                : pendingQuestions.length > 0
                ? 'Answer the card — or chat with the Chair…'
                : 'Chat with the Chair about the plan…'
            }
            value={draft}
            onChange={setDraft}
            onSubmit={() => void handleSend(new Event('submit') as unknown as React.FormEvent)}
            disabled={isDone || busy}
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

interface AutoResizeProps {
  className?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

function AutoResizeTextarea({
  className,
  placeholder,
  value,
  onChange,
  onSubmit,
  disabled,
}: AutoResizeProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(160, Math.floor(window.innerHeight * 0.4));
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      disabled={disabled}
      rows={2}
    />
  );
}

interface MessageBubbleProps {
  message: DeepPlanMessage;
  answeredQuestions?: ChairQuestion[];
}

function MessageBubble({
  message,
  answeredQuestions,
}: MessageBubbleProps): JSX.Element | null {
  if (message.kind === 'phase-transition') {
    return (
      <div className="dp-stage-transition">
        <span>{message.content}</span>
      </div>
    );
  }
  if (message.kind === 'user-answers') {
    return (
      <AnswersRecap
        answers={message.answers ?? {}}
        questions={answeredQuestions ?? []}
      />
    );
  }
  if (message.kind === 'user-chat' || message.kind === 'chair-chat') {
    // Free-chat turns are styled lighter than panel-round messages so the
    // user can see at a glance which threads are "panel work" vs "just
    // talking". Still markdown-rendered so citations + links work.
    const klass =
      message.kind === 'user-chat'
        ? 'dp-msg dp-msg-user dp-msg-chat dp-msg-chat-user'
        : 'dp-msg dp-msg-assistant dp-msg-chat dp-msg-chat-chair';
    return (
      <div className={klass}>
        <div className="dp-msg-body">
          <Markdown text={message.content} />
        </div>
      </div>
    );
  }

  const klass = message.role === 'user' ? 'dp-msg dp-msg-user' : 'dp-msg dp-msg-assistant';
  return (
    <div className={klass}>
      <div className="dp-msg-body">
        <Markdown text={message.content} />
      </div>
    </div>
  );
}

interface PhaseAdvanceCtaProps {
  phase: DeepPlanSession['phase'];
  onAdvance: () => void;
  disabled: boolean;
}

/**
 * Appears after the last chair-turn when the Chair signalled phaseAdvance.
 * Gives the user a clean choice: continue the conversation (just keep
 * typing below), or commit to the next phase. We keep the language light —
 * the chair has already summarised; this card is purely a UX handle.
 */
function PhaseAdvanceCta({ phase, onAdvance, disabled }: PhaseAdvanceCtaProps): JSX.Element {
  const nextLabel: string = (() => {
    if (phase === 'ideation') return 'Continue to planning';
    if (phase === 'planning') return 'Continue to reviewing';
    if (phase === 'reviewing') return 'Write the draft';
    return 'Continue';
  })();
  const nextName: string = (() => {
    if (phase === 'ideation') return 'planning';
    if (phase === 'planning') return 'reviewing';
    if (phase === 'reviewing') return 'drafting';
    return 'next phase';
  })();
  return (
    <div className="dp-advance-cta" role="status">
      <div className="dp-advance-cta-body">
        <div className="dp-advance-cta-title">Ready when you are.</div>
        <div className="dp-advance-cta-sub">
          Keep chatting below to shape the vision — anything you say will
          steer the next round. Or lock it in and move to {nextName}.
        </div>
      </div>
      <button
        type="button"
        className="dp-btn dp-btn-primary dp-btn-small"
        onClick={onAdvance}
        disabled={disabled}
      >
        {nextLabel}
      </button>
    </div>
  );
}

interface AnswersRecapProps {
  answers: ChairAnswerMap;
  questions: ChairQuestion[];
}

/**
 * Compact, readable recap of what the user answered. Looks up each
 * question by id so we can show the original prompt and the human
 * choice label rather than raw `q1: economics-policy` shorthand.
 * Skipped questions stay in the list but dim down — seeing "(skipped)"
 * helps the panel understand what the user chose not to commit on.
 */
function AnswersRecap({ answers, questions }: AnswersRecapProps): JSX.Element | null {
  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const entries = Object.entries(answers);
  if (entries.length === 0) return null;

  const resolve = (qId: string, ans: ChairAnswer): string => {
    const q = byId.get(qId);
    if (ans === null) return '(skipped)';
    if (Array.isArray(ans)) {
      const labels = ans.map((id) => q?.choices?.find((c) => c.id === id)?.label ?? id);
      return labels.join(', ');
    }
    if (q?.type === 'choice' || q?.type === 'confirm') {
      const c = q.choices?.find((x) => x.id === ans);
      return c?.label ?? ans;
    }
    return ans;
  };

  return (
    <div className="dp-answers">
      <div className="dp-answers-head">You answered</div>
      <ol className="dp-answers-list">
        {entries.map(([qId, ans]) => {
          const q = byId.get(qId);
          const prompt = q?.prompt ?? `Question ${qId}`;
          const answerText = resolve(qId, ans);
          const skipped = ans === null;
          return (
            <li
              key={qId}
              className={`dp-answers-row${skipped ? ' dp-answers-row-skipped' : ''}`}
            >
              <div className="dp-answers-q">{prompt}</div>
              <div className="dp-answers-a">{answerText}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---------------------------- Searching banner ---------------------------- */

/**
 * Shown below the panel card while the research engine is mid-run. The
 * floating pill on the graph already calls this out visually — this chat-
 * side banner exists so users who are scrolled up in the transcript (or
 * focused on the conversation column) also see that we're actively
 * searching the web and shouldn't close the window.
 */
function SearchingBanner(): JSX.Element | null {
  const events = useResearchEvents((s) => s.events);
  const searching = useMemo(() => researchRunningFromEvents(events), [events]);
  const currentQuery = useMemo(() => latestQueryText(events), [events]);
  if (!searching) return null;
  return (
    <div className="dp-searching" role="status" aria-live="polite">
      <span className="dp-searching-icon generating-dots" aria-hidden>
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </span>
      <div className="dp-searching-body">
        <div className="dp-searching-title">Searching the web — sit tight</div>
        <div className="dp-searching-sub">
          {currentQuery
            ? `Looking up “${currentQuery}”`
            : 'Running the queries the panel asked for…'}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Panel progress ---------------------------- */

/**
 * Each role exposes a short "I'm looking for X" tagline so the user sees
 * *what* the panelist is doing, not just that they're running. This
 * mirrors the persona block in the panel prompts — kept terse so the
 * live progress view stays scannable.
 */
const ROLE_DESCRIPTORS: Record<PanelRole, { label: string; tagline: string }> = {
  explorer: { label: 'Explorer', tagline: 'Angles you haven’t tried yet' },
  scoper: { label: 'Scoper', tagline: 'What’s in, what’s out' },
  stakes: { label: 'Stakes', tagline: 'Why this matters, and to whom' },
  architect: { label: 'Architect', tagline: 'Shape of the piece' },
  evidence: { label: 'Evidence', tagline: 'Sources behind each claim' },
  steelman: { label: 'Steelman', tagline: 'Strongest version of the argument' },
  skeptic: { label: 'Skeptic', tagline: 'Holes in the reasoning' },
  adversary: { label: 'Adversary', tagline: 'How a hostile reader attacks this' },
  editor: { label: 'Editor', tagline: 'Clarity, pacing, voice' },
  audience: { label: 'Audience', tagline: 'What readers actually want' },
  finaliser: { label: 'Finaliser', tagline: 'Ready to hand off to the drafter?' },
};

interface PanelProgressPanelProps {
  progress: PanelProgressState;
}

function PanelProgressPanel({ progress }: PanelProgressPanelProps): JSX.Element {
  const { roles, byRole, researchDispatched, chair } = progress;
  const doneCount = roles.filter((r) => byRole[r]?.state === 'done').length;
  const runningCount = roles.filter((r) => byRole[r]?.state === 'running').length;

  const status: string = (() => {
    if (chair === 'running') return 'Chair is synthesising the panel’s findings…';
    if (chair === 'done') return 'Chair is finalising your questions…';
    if (doneCount === roles.length && roles.length > 0) return 'Panel is done deliberating.';
    if (runningCount > 0) return `${runningCount} panelist${runningCount === 1 ? '' : 's'} still thinking…`;
    return 'Panel is assembling…';
  })();

  return (
    <div className="dp-panel">
      <div className="dp-panel-head">
        <div className="dp-panel-title">
          <span className="dp-panel-title-label">The panel is deliberating</span>
          <span className="dp-panel-title-count">
            {doneCount}/{roles.length} done
          </span>
        </div>
        <div className="dp-panel-status">
          <span className="generating-dots dp-panel-dots">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </span>
          <span className="dp-panel-status-text">{status}</span>
        </div>
      </div>

      <ul className="dp-panel-roles">
        {roles.map((role) => {
          const entry = byRole[role];
          const state = entry?.state ?? 'pending';
          const meta = ROLE_DESCRIPTORS[role];
          const findings =
            entry?.state === 'done'
              ? entry.findings
              : undefined;
          const searchQueries =
            entry?.state === 'done'
              ? entry.searchQueries
              : undefined;
          const errorMsg = entry?.state === 'failed' ? entry.error : undefined;

          return (
            <li key={role} className={`dp-panel-role dp-panel-role-${state}`}>
              <div className="dp-panel-role-indicator" aria-hidden>
                {state === 'pending' && <span className="dp-panel-indicator-empty" />}
                {state === 'running' && <span className="dp-panel-indicator-spin" />}
                {state === 'done' && <span className="dp-panel-indicator-check">✓</span>}
                {state === 'failed' && <span className="dp-panel-indicator-cross">!</span>}
              </div>
              <div className="dp-panel-role-body">
                <div className="dp-panel-role-head">
                  <span className="dp-panel-role-name">{meta.label}</span>
                  <PanelRoleStatusText
                    state={state}
                    findings={findings}
                    searchQueries={searchQueries}
                  />
                </div>
                <div className="dp-panel-role-tagline">
                  {state === 'failed' && errorMsg ? errorMsg : meta.tagline}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="dp-panel-foot">
        {researchDispatched > 0 && (
          <span className="dp-panel-foot-chip">
            {researchDispatched} {researchDispatched === 1 ? 'query' : 'queries'} sent to the web
          </span>
        )}
        <span
          className={`dp-panel-foot-chip dp-panel-foot-chair dp-panel-foot-chair-${chair}`}
        >
          {chair === 'idle' && 'Chair waiting'}
          {chair === 'running' && 'Chair synthesising'}
          {chair === 'done' && 'Chair ready'}
        </span>
      </div>
    </div>
  );
}

function PanelRoleStatusText({
  state,
  findings,
  searchQueries,
}: {
  state: 'pending' | 'running' | 'done' | 'failed';
  findings?: number;
  searchQueries?: number;
}): JSX.Element {
  if (state === 'pending') {
    return <span className="dp-panel-role-note dp-panel-role-note-pending">Queued</span>;
  }
  if (state === 'running') {
    return <span className="dp-panel-role-note dp-panel-role-note-running">Thinking…</span>;
  }
  if (state === 'failed') {
    return <span className="dp-panel-role-note dp-panel-role-note-failed">Skipped (error)</span>;
  }
  const parts: string[] = [];
  if (typeof findings === 'number') {
    parts.push(
      findings === 0
        ? 'No new concerns'
        : `${findings} ${findings === 1 ? 'concern' : 'concerns'} raised`,
    );
  }
  if (typeof searchQueries === 'number' && searchQueries > 0) {
    parts.push(
      `${searchQueries} search${searchQueries === 1 ? '' : 'es'} asked for`,
    );
  }
  return (
    <span className="dp-panel-role-note dp-panel-role-note-done">
      {parts.length > 0 ? parts.join(' · ') : 'Done'}
    </span>
  );
}

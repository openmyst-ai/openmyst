import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeepPlanMessage, DeepPlanSession, PanelRole } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';
import { renderMarkdown } from '../../utils/markdown';
import { QuestionCard } from './QuestionCard';

function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="dp-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Props {
  session: DeepPlanSession;
}

export function ConversationColumn({ session }: Props): JSX.Element {
  const { status, busy, sendMessage, panelProgress } = useDeepPlan();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const roundRunning = status?.roundRunning ?? false;
  const pendingQuestions = session.pendingQuestions ?? [];

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
  }, [session.messages.length, pendingQuestions.length]);

  const isDone = session.phase === 'done';

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text || busy) return;
      setDraft('');
      await sendMessage(text);
    },
    [draft, busy, sendMessage],
  );

  return (
    <div className="dp-chat">
      <div className="dp-chat-scroll" ref={scrollRef}>
        {session.messages.length === 0 && !roundRunning && (
          <div className="dp-empty">Starting the Deep Plan conversation…</div>
        )}
        {session.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {roundRunning && <PanelProgressIndicator progress={panelProgress} />}
        {!roundRunning && pendingQuestions.length > 0 && (
          <QuestionCard questions={pendingQuestions} />
        )}
      </div>

      <div className="dp-chat-footer">
        <form className="dp-chat-form" onSubmit={(e) => void handleSend(e)}>
          <AutoResizeTextarea
            className="dp-chat-input"
            placeholder={
              isDone
                ? 'Deep Plan complete.'
                : pendingQuestions.length > 0
                ? 'Answer the card — or type a free-text note…'
                : 'Write a reply or hit Continue to advance…'
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

function MessageBubble({ message }: { message: DeepPlanMessage }): JSX.Element | null {
  if (message.kind === 'phase-transition') {
    return (
      <div className="dp-stage-transition">
        <span>{message.content}</span>
      </div>
    );
  }
  if (message.kind === 'user-answers') {
    const entries = Object.entries(message.answers ?? {});
    if (entries.length === 0) return null;
    return (
      <div className="dp-msg dp-msg-user dp-msg-answers">
        <div className="dp-msg-body">
          <div className="dp-answers-label">You answered:</div>
          <ul className="dp-answers-list">
            {entries.map(([id, ans]) => {
              const rendered =
                ans === null
                  ? '(skipped)'
                  : Array.isArray(ans)
                  ? ans.join(', ')
                  : ans;
              return (
                <li key={id}>
                  <span className="dp-answers-qid">{id}:</span> {rendered}
                </li>
              );
            })}
          </ul>
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

const ROLE_LABELS: Record<PanelRole, string> = {
  explorer: 'Explorer',
  scoper: 'Scoper',
  stakes: 'Stakes',
  architect: 'Architect',
  evidence: 'Evidence',
  steelman: 'Steelman',
  skeptic: 'Skeptic',
  adversary: 'Adversary',
  editor: 'Editor',
  audience: 'Audience',
  finaliser: 'Finaliser',
};

interface PanelProgressIndicatorProps {
  progress: ReturnType<typeof useDeepPlan.getState>['panelProgress'];
}

function PanelProgressIndicator({ progress }: PanelProgressIndicatorProps): JSX.Element {
  return (
    <div className="dp-panel-progress">
      <div className="dp-panel-progress-head">
        <span className="generating-dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </span>
        <span className="dp-muted">
          Panel thinking{progress.researchDispatched > 0 ? ` · ${progress.researchDispatched} query ${progress.researchDispatched === 1 ? '' : 'dispatched'}` : ''}
        </span>
      </div>
      <div className="dp-panel-progress-roles">
        {progress.roles.map((role) => {
          const state = progress.byRole[role]?.state ?? 'pending';
          const extra =
            state === 'done'
              ? ` · ${(progress.byRole[role] as { findings: number }).findings}`
              : '';
          return (
            <span
              key={role}
              className={`dp-panel-role dp-panel-role-${state}`}
              title={state === 'failed' ? (progress.byRole[role] as { error: string }).error : undefined}
            >
              {ROLE_LABELS[role]}
              {extra}
            </span>
          );
        })}
        {progress.chair !== 'idle' && (
          <span className={`dp-panel-role dp-panel-role-chair dp-panel-role-${progress.chair}`}>
            Chair
          </span>
        )}
      </div>
    </div>
  );
}

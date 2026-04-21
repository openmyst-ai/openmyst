import { useMemo, useState } from 'react';
import type { ChairAnswer, ChairAnswerMap, ChairQuestion } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';

/**
 * Carousel of Chair-authored questions. The user steps through them one
 * at a time — picks a choice, types an open answer, or skips. When the
 * last card is handled, we submit the full answer map back to the main
 * process, which clears the pending slot and fires the next panel round.
 *
 * The whole card detaches from the chat transcript by design: Chair
 * summaries live in the chat, questions live here. This keeps the chat
 * readable long-term (summaries compress into a history) while still
 * letting the user drive each round with structured input.
 */

interface Props {
  questions: ChairQuestion[];
}

export function QuestionCard({ questions }: Props): JSX.Element | null {
  const submitAnswers = useDeepPlan((s) => s.submitAnswers);
  const busy = useDeepPlan((s) => s.busy);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ChairAnswerMap>({});
  // Active draft for the current question (open text or choice id/s).
  const [openDraft, setOpenDraft] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);

  const current = questions[index] ?? null;
  const total = questions.length;
  const isLast = index === total - 1;

  const resetDraft = (): void => {
    setOpenDraft('');
    setChoice(null);
    setMulti([]);
  };

  const commitAnswer = (value: ChairAnswer): ChairAnswerMap => {
    if (!current) return answers;
    const next = { ...answers, [current.id]: value };
    setAnswers(next);
    return next;
  };

  const finish = async (withAnswers: ChairAnswerMap): Promise<void> => {
    // Ensure every question has an entry — omissions are sent as null
    // (skipped) so the Chair can see what the user chose not to engage.
    const full: ChairAnswerMap = {};
    for (const q of questions) {
      full[q.id] = q.id in withAnswers ? withAnswers[q.id]! : null;
    }
    await submitAnswers(full);
  };

  const handleNext = async (value: ChairAnswer): Promise<void> => {
    const updated = commitAnswer(value);
    if (isLast) {
      await finish(updated);
      return;
    }
    setIndex(index + 1);
    resetDraft();
  };

  const handleSkip = async (): Promise<void> => {
    await handleNext(null);
  };

  const canSubmit = useMemo(() => {
    if (!current) return false;
    switch (current.type) {
      case 'choice':
      case 'confirm':
        return choice !== null;
      case 'multi':
        return multi.length > 0;
      case 'open':
        return openDraft.trim().length > 0;
      default:
        return false;
    }
  }, [current, choice, multi, openDraft]);

  if (total === 0 || !current) return null;

  const progress = `${index + 1} / ${total}`;

  return (
    <div className="dp-qcard">
      <div className="dp-qcard-head">
        <span className="dp-qcard-progress">Question {progress}</span>
      </div>
      <div className="dp-qcard-body">
        <div className="dp-qcard-prompt">{current.prompt}</div>
        {current.rationale && (
          <div className="dp-qcard-rationale">{current.rationale}</div>
        )}

        {(current.type === 'choice' || current.type === 'confirm') && (
          <div className="dp-qcard-choices">
            {(current.choices ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                className={`dp-qcard-choice${choice === c.id ? ' dp-qcard-choice-selected' : ''}`}
                onClick={() => setChoice(c.id)}
                disabled={busy}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {current.type === 'multi' && (
          <div className="dp-qcard-choices">
            {(current.choices ?? []).map((c) => {
              const picked = multi.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`dp-qcard-choice${picked ? ' dp-qcard-choice-selected' : ''}`}
                  onClick={() =>
                    setMulti((prev) =>
                      prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                    )
                  }
                  disabled={busy}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        )}

        {current.type === 'open' && (
          <textarea
            className="dp-qcard-textarea"
            rows={4}
            placeholder="Your answer…"
            value={openDraft}
            onChange={(e) => setOpenDraft(e.target.value)}
            disabled={busy}
            autoFocus
          />
        )}
      </div>

      <div className="dp-qcard-actions">
        <button
          type="button"
          className="dp-btn dp-btn-ghost dp-btn-small"
          onClick={() => void handleSkip()}
          disabled={busy}
        >
          Skip
        </button>
        <button
          type="button"
          className="dp-btn dp-btn-primary dp-btn-small"
          disabled={busy || !canSubmit}
          onClick={() => {
            if (!current) return;
            let value: ChairAnswer = null;
            switch (current.type) {
              case 'choice':
              case 'confirm':
                value = choice;
                break;
              case 'multi':
                value = multi;
                break;
              case 'open':
                value = openDraft.trim();
                break;
            }
            void handleNext(value);
          }}
        >
          {isLast ? 'Submit' : 'Next'}
        </button>
      </div>
    </div>
  );
}

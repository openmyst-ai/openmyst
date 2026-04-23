import { useMemo, useState } from 'react';
import type { ChairAnswer, ChairAnswerMap, ChairQuestion } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';

/**
 * Carousel of Chair-authored questions. The user steps through them one
 * at a time — picks a choice, types an open answer, or skips. When the
 * last card is handled, we submit the full answer map back to the main
 * process, which clears the pending slot and fires the next panel round.
 *
 * The card is visually distinct from the chat transcript by design: Chair
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
  const [openDraft, setOpenDraft] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState('');

  const current = questions[index] ?? null;
  const total = questions.length;
  const isLast = index === total - 1;

  const resetDraft = (): void => {
    setOpenDraft('');
    setChoice(null);
    setMulti([]);
    setCustomMode(false);
    setCustomDraft('');
  };

  const commitAnswer = (value: ChairAnswer): ChairAnswerMap => {
    if (!current) return answers;
    const next = { ...answers, [current.id]: value };
    setAnswers(next);
    return next;
  };

  const finish = async (withAnswers: ChairAnswerMap): Promise<void> => {
    // Ensure every question has an entry — omissions send as null so the
    // Chair can see what the user chose not to engage with.
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
        if (customMode) return customDraft.trim().length > 0;
        return choice !== null;
      case 'confirm':
        return choice !== null;
      case 'multi':
        return multi.length > 0;
      case 'open':
        return openDraft.trim().length > 0;
      default:
        return false;
    }
  }, [current, choice, multi, openDraft, customMode, customDraft]);

  if (total === 0 || !current) return null;

  const handleSubmit = (): void => {
    if (!current) return;
    let value: ChairAnswer = null;
    switch (current.type) {
      case 'choice':
        value = customMode ? customDraft.trim() : choice;
        break;
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
  };

  const typeLabel = ((): string => {
    switch (current.type) {
      case 'choice':
        return 'Pick one';
      case 'confirm':
        return 'Yes or no';
      case 'multi':
        return 'Pick any that apply';
      case 'open':
        return 'Your words';
      default:
        return '';
    }
  })();

  return (
    <div className="dp-qcard">
      <div className="dp-qcard-progress">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`dp-qcard-progress-seg${
              i < index ? ' dp-qcard-progress-seg-done' : ''
            }${i === index ? ' dp-qcard-progress-seg-active' : ''}`}
          />
        ))}
      </div>

      <div className="dp-qcard-meta">
        <span className="dp-qcard-step">
          Question {index + 1} of {total}
        </span>
        <span className="dp-qcard-type">{typeLabel}</span>
      </div>

      <div className="dp-qcard-prompt">{current.prompt}</div>
      {current.rationale && (
        <div className="dp-qcard-rationale">{current.rationale}</div>
      )}

      <div className="dp-qcard-field">
        {(current.type === 'choice' || current.type === 'confirm') && (
          <div className="dp-qcard-choices">
            {(current.choices ?? []).map((c) => {
              const selected = !customMode && choice === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`dp-qcard-choice${
                    selected ? ' dp-qcard-choice-selected' : ''
                  }${c.recommended ? ' dp-qcard-choice-recommended' : ''}`}
                  onClick={() => {
                    setCustomMode(false);
                    setChoice(c.id);
                  }}
                  disabled={busy}
                >
                  <span className="dp-qcard-choice-mark dp-qcard-choice-mark-radio" aria-hidden />
                  <span className="dp-qcard-choice-label">{c.label}</span>
                  {c.recommended && (
                    <span className="dp-qcard-choice-ribbon">Panel pick</span>
                  )}
                </button>
              );
            })}
            {current.type === 'choice' && current.allowCustom && (
              <button
                type="button"
                className={`dp-qcard-choice dp-qcard-choice-custom${
                  customMode ? ' dp-qcard-choice-selected' : ''
                }`}
                onClick={() => {
                  setCustomMode(true);
                  setChoice(null);
                }}
                disabled={busy}
              >
                <span className="dp-qcard-choice-mark dp-qcard-choice-mark-radio" aria-hidden />
                <span className="dp-qcard-choice-label">Write my own</span>
              </button>
            )}
            {current.type === 'choice' && current.allowCustom && customMode && (
              <textarea
                className="dp-qcard-custom-input"
                rows={3}
                placeholder="Your answer — a sentence is plenty"
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (canSubmit && !busy) handleSubmit();
                  }
                }}
                disabled={busy}
                autoFocus
              />
            )}
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
                  className={`dp-qcard-choice${
                    picked ? ' dp-qcard-choice-selected' : ''
                  }`}
                  onClick={() =>
                    setMulti((prev) =>
                      prev.includes(c.id)
                        ? prev.filter((x) => x !== c.id)
                        : [...prev, c.id],
                    )
                  }
                  disabled={busy}
                >
                  <span className="dp-qcard-choice-mark dp-qcard-choice-mark-check" aria-hidden>
                    {picked && '✓'}
                  </span>
                  <span className="dp-qcard-choice-label">{c.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {current.type === 'open' && (
          <textarea
            className="dp-qcard-textarea"
            rows={5}
            placeholder="Type your answer — a sentence is plenty"
            value={openDraft}
            onChange={(e) => setOpenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canSubmit && !busy) handleSubmit();
              }
            }}
            disabled={busy}
            autoFocus
          />
        )}
      </div>

      <div className="dp-qcard-actions">
        <button
          type="button"
          className="dp-qcard-skip"
          onClick={() => void handleSkip()}
          disabled={busy}
          title="The panel will pick what they think is right on your behalf."
        >
          Let the panel decide
        </button>
        <button
          type="button"
          className="dp-qcard-next"
          disabled={busy || !canSubmit}
          onClick={handleSubmit}
        >
          {isLast ? 'Submit all answers' : 'Next question →'}
        </button>
      </div>
    </div>
  );
}

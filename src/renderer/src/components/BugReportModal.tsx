import { useState } from 'react';
import { bridge } from '../api/bridge';

/**
 * Bug report flow:
 *   compose → preview (with full logs visible) → submit.
 *
 * Submit tries the relay worker first — that creates the GitHub issue on
 * behalf of a bot account so the user doesn't need a GitHub account of
 * their own. If the worker is unreachable/unconfigured, main falls back to
 * opening a pre-filled `issues/new` URL in the browser. The result tells
 * us which path won so the success copy can match.
 */

interface Props {
  onClose: () => void;
}

type Stage = 'compose' | 'preview' | 'submitting' | 'done';

interface Preview {
  title: string;
  body: string;
  deliveryMode: 'worker' | 'browser';
}

interface SubmitResult {
  issueUrl: string;
  issueNumber: number | null;
  delivered: 'worker' | 'browser';
  workerError?: string;
}

export function BugReportModal({ onClose }: Props): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState<Stage>('compose');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const goPreview = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setError('Please enter a title.');
      return;
    }
    setError(null);
    try {
      const p = await bridge.bugReport.preview({ title, description });
      setPreview(p);
      setStage('preview');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setStage('submitting');
    try {
      const r = await bridge.bugReport.submit({ title, description });
      setResult(r);
      setStage('done');
    } catch (err) {
      setError((err as Error).message);
      setStage('preview');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Report a bug</h2>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>

        {stage === 'compose' && (
          <>
            <section className="modal-section">
              <p className="muted">
                We'll attach your recent log activity so we can reproduce the issue.
                You'll see exactly what gets sent on the next screen before anything
                leaves the app.
              </p>
            </section>

            <section className="modal-section">
              <label className="field-label" htmlFor="bug-title">
                Title
              </label>
              <input
                id="bug-title"
                type="text"
                placeholder="Short summary of what went wrong"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </section>

            <section className="modal-section">
              <label className="field-label" htmlFor="bug-description">
                Description
              </label>
              <textarea
                id="bug-description"
                placeholder="What did you do? What did you expect? What actually happened?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
              />
            </section>

            {error && <div className="error">{error}</div>}

            <section className="modal-section">
              <div className="row">
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void goPreview()}
                  disabled={title.trim().length === 0}
                >
                  Preview
                </button>
              </div>
            </section>
          </>
        )}

        {(stage === 'preview' || stage === 'submitting') && preview && (
          <>
            <section className="modal-section">
              <p className="muted">
                {preview.deliveryMode === 'worker'
                  ? 'Clicking send posts this directly to GitHub through our relay — no GitHub account needed on your end.'
                  : 'Clicking send opens a pre-filled GitHub issue in your browser; you review and click Submit new issue there.'}
              </p>
            </section>

            <section className="modal-section">
              <label className="field-label">Title</label>
              <div className="bug-preview-title">{preview.title}</div>
            </section>

            <section className="modal-section">
              <label className="field-label">Body (including attached logs)</label>
              <pre className="bug-preview-body">{preview.body}</pre>
            </section>

            {error && <div className="error">{error}</div>}

            <section className="modal-section">
              <div className="row">
                <button
                  type="button"
                  onClick={() => setStage('compose')}
                  disabled={stage === 'submitting'}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void submit()}
                  disabled={stage === 'submitting'}
                >
                  {stage === 'submitting'
                    ? 'Sending…'
                    : preview.deliveryMode === 'worker'
                      ? 'Send to GitHub'
                      : 'Open in browser'}
                </button>
              </div>
            </section>
          </>
        )}

        {stage === 'done' && result && (
          <section className="modal-section">
            {result.delivered === 'worker' ? (
              <>
                <p>
                  Thanks! Your report was posted as{' '}
                  <a href={result.issueUrl} target="_blank" rel="noreferrer">
                    {result.issueNumber !== null
                      ? `issue #${result.issueNumber}`
                      : 'a new GitHub issue'}
                  </a>
                  .
                </p>
                {result.workerError && (
                  <p className="muted">
                    (First try failed: {result.workerError} — fell through to the
                    browser flow.)
                  </p>
                )}
              </>
            ) : (
              <>
                <p>
                  {result.workerError
                    ? 'Our relay wasn\'t reachable, so we opened a pre-filled GitHub issue in your browser instead. Click Submit new issue there to post it.'
                    : 'A pre-filled GitHub issue has opened in your browser. Click Submit new issue there to post it.'}
                </p>
                {result.workerError && (
                  <p className="muted">Details: {result.workerError}</p>
                )}
              </>
            )}
            <div className="row">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

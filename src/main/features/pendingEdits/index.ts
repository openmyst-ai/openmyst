import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { PendingEdit } from '@shared/types';
import { projectPath, ensureDir, broadcast, log, logError } from '../../platform';
import { readDocument, writeDocument } from '../documents';
import {
  applyEditOccurrence,
  applyEditOccurrenceAnchored,
  applyEditOccurrenceCanonical,
  applyEditOccurrenceFuzzy,
  mergePendingEdits,
} from '../chat/editLogic';

/**
 * Pending edits: the staging area between "LLM proposed an edit" and "the
 * edit is applied to the document on disk".
 *
 * Lifecycle of a pending edit:
 *   1. Chat turn parses `myst_edit` blocks from the LLM response.
 *   2. `addPendingEdits` persists them to `.myst/pending/<doc>.json` and
 *      broadcasts PendingEdits.Changed so the renderer re-fetches.
 *   3. The renderer shows a red strike-through + green widget in the editor
 *      (see src/renderer/src/tiptap/pendingEditPlugin.ts).
 *   4. User clicks Accept → `acceptPendingEdit` runs applyEditOccurrence,
 *      writes the new document, removes the entry, broadcasts changes.
 *      Clicks Reject → `rejectPendingEdit` just removes the entry.
 *      Clicks into the widget and types → `patchPendingEditNewString` updates
 *      the stored `new_string` without touching the document.
 *
 * Pending edits are deliberately append-only to disk per doc — we never
 * mutate an entry in place. On revision we rewrite the whole file. At
 * typical sizes (a few edits per doc) that's cheaper than thinking about it.
 */

function pendingPath(docFilename: string): string {
  return projectPath('.myst', 'pending', `${docFilename}.json`);
}

async function readPending(docFilename: string): Promise<PendingEdit[]> {
  try {
    const raw = await fs.readFile(pendingPath(docFilename), 'utf-8');
    return JSON.parse(raw) as PendingEdit[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writePending(docFilename: string, edits: PendingEdit[]): Promise<void> {
  await ensureDir(projectPath('.myst', 'pending'));
  await fs.writeFile(pendingPath(docFilename), JSON.stringify(edits, null, 2), 'utf-8');
}

function notifyChanged(): void {
  broadcast(IpcChannels.PendingEdits.Changed);
}

function notifyDocumentChanged(): void {
  broadcast(IpcChannels.Document.Changed);
}

export async function listPendingEdits(docFilename: string): Promise<PendingEdit[]> {
  return readPending(docFilename);
}

export async function addPendingEdits(
  docFilename: string,
  edits: Array<{ oldString: string; newString: string; occurrence?: number }>,
): Promise<void> {
  if (edits.length === 0) return;
  log('pending', 'add.request', {
    doc: docFilename,
    incomingCount: edits.length,
    previews: edits.map((e) => ({
      oldPreview: e.oldString.slice(0, 60),
      newPreview: e.newString.slice(0, 60),
      occ: e.occurrence ?? 1,
    })),
  });
  const existing = await readPending(docFilename);
  const batchId = randomUUID();
  const batchTotal = edits.length;
  const now = new Date().toISOString();

  const incoming = edits.map((e, idx) => ({
    oldString: e.oldString,
    newString: e.newString,
    occurrence: e.occurrence ?? 1,
    _idx: idx,
  }));

  const combined = mergePendingEdits(existing, incoming, (inc) => ({
    id: randomUUID(),
    docFilename,
    oldString: inc.oldString,
    newString: inc.newString,
    occurrence: inc.occurrence,
    createdAt: now,
    batchId,
    batchIndex: inc._idx + 1,
    batchTotal,
  }));

  await writePending(docFilename, combined);
  log('pending', 'add.committed', {
    doc: docFilename,
    existingCount: existing.length,
    combinedCount: combined.length,
    replacedInPlace: existing.length + edits.length - combined.length,
  });
  notifyChanged();
}

/**
 * Find a pending edit by id across all docs in the project. Used by accept/
 * reject — the renderer only sends us the edit id, so we scan.
 */
async function findPendingById(
  id: string,
): Promise<{ edit: PendingEdit; docFilename: string } | null> {
  const pendingDir = projectPath('.myst', 'pending');
  let entries: string[];
  try {
    entries = await fs.readdir(pendingDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const docFilename = entry.replace(/\.json$/, '');
    const edits = await readPending(docFilename);
    const edit = edits.find((e) => e.id === id);
    if (edit) return { edit, docFilename };
  }
  return null;
}

export async function acceptPendingEdit(id: string, overrideNewString?: string): Promise<void> {
  log('pending', 'accept.request', { id, hasOverride: overrideNewString !== undefined });
  const found = await findPendingById(id);
  if (!found) {
    logError('pending', 'accept.notFound', new Error('pending edit not found'), { id });
    throw new Error(`Pending edit ${id} not found.`);
  }
  const { edit, docFilename } = found;

  const effectiveNewString = overrideNewString ?? edit.newString;
  const doc = await readDocument(docFilename);
  log('pending', 'accept.applying', {
    id,
    doc: docFilename,
    oldStringPreview: edit.oldString.slice(0, 120),
    occurrence: edit.occurrence,
    docChars: doc.length,
    oldStringInDoc: edit.oldString === '' ? 'append' : doc.includes(edit.oldString),
  });
  let newDoc = applyEditOccurrence(doc, edit.oldString, effectiveNewString, edit.occurrence);
  if (newDoc === null) {
    // Exact match failed — try typographic-canonical fallback first. Handles
    // the narrow but common case where the LLM typed straight quotes, ASCII
    // dashes, or LF line endings while the doc has curly quotes, em-dashes,
    // NBSP, or CRLF. Cheaper and more targeted than the whitespace-fuzzy pass.
    const canonical = applyEditOccurrenceCanonical(
      doc,
      edit.oldString,
      effectiveNewString,
      edit.occurrence,
    );
    if (canonical !== null) {
      log('pending', 'accept.canonicalMatch', {
        id,
        doc: docFilename,
        oldStringPreview: edit.oldString.slice(0, 120),
      });
      newDoc = canonical;
    }
  }
  if (newDoc === null) {
    // Canonical failed — try whitespace-tolerant fallback. Handles drift
    // between space and newline, single vs double space, etc.
    const fuzzy = applyEditOccurrenceFuzzy(doc, edit.oldString, effectiveNewString, edit.occurrence);
    if (fuzzy !== null) {
      log('pending', 'accept.fuzzyMatch', {
        id,
        doc: docFilename,
        oldStringPreview: edit.oldString.slice(0, 120),
      });
      newDoc = fuzzy;
    }
  }
  if (newDoc === null) {
    // Still no match — try anchor-based matching. Handles long old_strings
    // where the LLM transcribed a paragraph with one embedded link/italic
    // slightly wrong (e.g. different link slug, lost bold). Matches by
    // prefix + suffix in normalized (markdown-stripped) space and splices
    // the replacement back onto the raw doc using a position map.
    const anchored = applyEditOccurrenceAnchored(doc, edit.oldString, effectiveNewString, edit.occurrence);
    if (anchored !== null) {
      log('pending', 'accept.anchoredMatch', {
        id,
        doc: docFilename,
        oldStringPreview: edit.oldString.slice(0, 120),
      });
      newDoc = anchored;
    }
  }
  if (newDoc === null) {
    // Dump enough context to diagnose a mismatch without flooding the log.
    const oldStr = edit.oldString;
    const firstLine = oldStr.split('\n')[0] ?? '';
    const firstWordHit = firstLine.length > 0 ? doc.indexOf(firstLine.slice(0, 20)) : -1;
    logError('pending', 'accept.notLocated', new Error('applyEditOccurrence returned null'), {
      id,
      doc: docFilename,
      docLen: doc.length,
      oldStringLen: oldStr.length,
      oldStringFull: oldStr,
      occurrence: edit.occurrence,
      firstLineFuzzyHitAt: firstWordHit,
      docHead: doc.slice(0, 200),
      docTail: doc.slice(-200),
    });
    throw new Error(
      'Could not locate the original text to apply this edit. Reject it and ask the LLM to retry.',
    );
  }
  await writeDocument(docFilename, newDoc);
  log('pending', 'accept.written', { id, doc: docFilename, newDocChars: newDoc.length });
  notifyDocumentChanged();

  const remaining = (await readPending(docFilename)).filter((e) => e.id !== id);
  await writePending(docFilename, remaining);
  log('pending', 'accept.cleared', { id, remainingCount: remaining.length });
  notifyChanged();
}

export async function rejectPendingEdit(id: string): Promise<void> {
  log('pending', 'reject.request', { id });
  const found = await findPendingById(id);
  if (!found) {
    log('pending', 'reject.notFound', { id });
    return;
  }
  const { docFilename } = found;
  const remaining = (await readPending(docFilename)).filter((e) => e.id !== id);
  await writePending(docFilename, remaining);
  log('pending', 'reject.cleared', { id, remainingCount: remaining.length });
  notifyChanged();
}

export async function patchPendingEditNewString(
  docFilename: string,
  id: string,
  newString: string,
): Promise<void> {
  log('pending', 'patch.request', {
    doc: docFilename,
    id,
    newLen: newString.length,
    newPreview: newString.slice(0, 120),
  });
  const edits = await readPending(docFilename);
  const idx = edits.findIndex((e) => e.id === id);
  if (idx === -1) {
    log('pending', 'patch.notFound', { id });
    return;
  }
  edits[idx] = { ...edits[idx]!, newString };
  await writePending(docFilename, edits);
  log('pending', 'patch.committed', { id, total: edits.length });
  notifyChanged();
}

export async function clearPendingEdits(docFilename: string): Promise<void> {
  await writePending(docFilename, []);
  notifyChanged();
}

export async function countPendingForDoc(docFilename: string): Promise<number> {
  const edits = await readPending(docFilename);
  return edits.length;
}

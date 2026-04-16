import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DocumentFile } from '@shared/types';
import { projectPath } from '../../platform';

/**
 * CRUD for the user's documents under `documents/` inside the open project.
 * Documents are plain markdown files — the list you see in the renderer's
 * document picker is literally `ls documents/*.md`.
 *
 * Writes are atomic (tmp-file-then-rename) so a crash mid-write never leaves
 * the user's prose truncated. The rest of the app (pending-edit accept,
 * autosave) goes through `writeDocument` to inherit that.
 */

function documentsDir(): string {
  return projectPath('documents');
}

export async function listDocuments(): Promise<DocumentFile[]> {
  const dir = documentsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith('.md'))
    .sort()
    .map((filename) => ({
      filename,
      label: filename.replace(/\.md$/, ''),
    }));
}

export async function createDocument(name: string): Promise<DocumentFile> {
  const filename = name.endsWith('.md') ? name : `${name}.md`;
  const filePath = projectPath('documents', filename);
  await fs.writeFile(filePath, `# ${name.replace(/\.md$/, '')}\n`, 'utf-8');
  return { filename, label: filename.replace(/\.md$/, '') };
}

export async function deleteDocument(filename: string): Promise<void> {
  await fs.unlink(projectPath('documents', filename));
}

export async function readDocument(filename: string): Promise<string> {
  try {
    return await fs.readFile(projectPath('documents', filename), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function writeDocument(filename: string, content: string): Promise<void> {
  const filePath = projectPath('documents', filename);
  // Unique tmp per call so concurrent writers (autosave + pending-edit accept)
  // don't race on the same path — previously the second rename would hit
  // ENOENT after the first one consumed the shared tmp.
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* orphan cleanup best-effort */
    }
    throw err;
  }
}

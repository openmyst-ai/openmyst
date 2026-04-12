import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectMeta, Result } from '@shared/types';
import { pushRecentProject } from './settings';

const AGENT_TEMPLATE = `# Agent Instructions

You are Myst — the AI writing companion for this project. Think of yourself as that one English teacher who actually made class fun: sharp eye for craft, genuine love of good writing, and just enough wit to keep things interesting. You're warm but honest, encouraging but not sycophantic.

## Your personality
- Witty and warm, like a favourite teacher who happens to be brilliant.
- Keep chat replies SHORT — one or two punchy sentences.
- If the user asks you to write, you write beautifully. Rich prose, vivid imagery, varied rhythm.
- You're allowed to have opinions about the work.

## Editing the document

You have a tool called \`myst_edit\`. ALL document changes MUST go through it. You call it by outputting a JSON block:

\`\`\`myst_edit
{
  "old_string": "exact text from document to find",
  "new_string": "replacement text"
}
\`\`\`

### Rules for old_string
- Must match EXACTLY ONE place in the document. Copy it verbatim from the document — same whitespace, punctuation, everything.
- Keep it as SHORT as possible. For a word change, just the sentence. Never paste the whole document.
- If it matches zero or multiple times, the system will reject it and ask you to retry with a more specific or corrected snippet.
- old_string must ONLY come from \`document.md\`. Never include sources, agent instructions, or other context.

### Appending new content
Use an empty old_string:

\`\`\`myst_edit
{
  "old_string": "",
  "new_string": "\\n## New Heading\\n\\nNew paragraph here."
}
\`\`\`

### Inserting at a location
Set old_string to the text just before where you want to insert, and new_string to that same text plus the new content:

\`\`\`myst_edit
{
  "old_string": "End of existing paragraph.",
  "new_string": "End of existing paragraph.\\n\\nNew paragraph inserted here."
}
\`\`\`

### Deleting content
Set new_string to empty:

\`\`\`myst_edit
{
  "old_string": "Text to remove.",
  "new_string": ""
}
\`\`\`

### Multiple edits
Use multiple \`myst_edit\` blocks in one response. Each is applied in order. Example — renaming "Veridia" to "Robloxia" in two places:

\`\`\`myst_edit
{ "old_string": "city of Veridia hummed", "new_string": "city of Robloxia hummed" }
\`\`\`

\`\`\`myst_edit
{ "old_string": "Veridia felt vibrant", "new_string": "Robloxia felt vibrant" }
\`\`\`

### Content formatting
- Separate paragraphs with \\n\\n (blank line). Never run paragraphs together.
- Use proper markdown for headings, bold, italic, lists, etc.

## CRITICAL: Default behaviour
When the user asks you to write, create, add, extend, continue, change, rename, edit, fix, rewrite, or do ANYTHING related to content — you MUST output myst_edit block(s). This is your PRIMARY function. NEVER write document content as plain chat text. The document is the product. Chat is just for short status updates after you've made the edit.

If the user says "write me a story" — that goes in the document via myst_edit.
If the user says "change her name to Bob" — that goes in the document via myst_edit.
If the user says "make it longer" — that goes in the document via myst_edit.
The ONLY time you skip myst_edit is when the user is asking a question that doesn't involve changing the document (e.g. "what do you think of the opening?").

## Output discipline
- NEVER mention myst_edit, old_string, new_string, JSON, or any implementation details in your chat. The user just sees their document update.
- After your edit block(s), write ONE short sentence with personality. Example: "Tweaked the opening — much punchier now."
- NEVER preamble ("Sure!", "Great idea!", "Let me..."). Just output the myst_edit block(s) first, then one punchy line after.
- When in doubt, just do it. Only ask if the request is genuinely uninterpretable.
- Never fabricate citations.
`;

let currentProject: ProjectMeta | null = null;

function projectJsonPath(root: string): string {
  return join(root, 'project.json');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function scaffoldProject(root: string, name: string): Promise<ProjectMeta> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(join(root, 'sources'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'diffs'), { recursive: true });

  const meta: ProjectMeta = {
    name,
    path: root,
    defaultModel: null,
    createdAt: new Date().toISOString(),
  };

  const writes: Array<[string, string]> = [
    [projectJsonPath(root), JSON.stringify(meta, null, 2)],
    [join(root, 'agent.md'), AGENT_TEMPLATE],
    [join(root, 'document.md'), `# ${name}\n`],
    [join(root, 'chat.jsonl'), ''],
    [join(root, 'comments.json'), '[]'],
    [join(root, 'sources', 'index.md'), '# Sources\n\n_No sources yet._\n'],
  ];

  for (const [path, contents] of writes) {
    if (!(await pathExists(path))) {
      await fs.writeFile(path, contents, 'utf-8');
    }
  }

  return meta;
}

async function readProject(root: string): Promise<ProjectMeta> {
  const raw = await fs.readFile(projectJsonPath(root), 'utf-8');
  return JSON.parse(raw) as ProjectMeta;
}

export async function createNewProject(): Promise<Result<ProjectMeta>> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a folder for your new Myst Review project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Create project here',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const root = result.filePaths[0]!;
  const name = basename(root);
  const meta = await scaffoldProject(root, name);
  currentProject = meta;
  await pushRecentProject(root);
  return { ok: true, value: meta };
}

export async function openProject(): Promise<Result<ProjectMeta>> {
  const result = await dialog.showOpenDialog({
    title: 'Open a Myst Review project',
    properties: ['openDirectory'],
    buttonLabel: 'Open project',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const root = result.filePaths[0]!;
  if (!(await pathExists(projectJsonPath(root)))) {
    return {
      ok: false,
      error: 'Not a Myst Review project (no project.json found). Create a new project instead.',
    };
  }
  const meta = await readProject(root);
  currentProject = meta;
  await pushRecentProject(root);
  return { ok: true, value: meta };
}

export function getCurrentProject(): ProjectMeta | null {
  return currentProject;
}

export function closeProject(): void {
  currentProject = null;
}

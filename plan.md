# Myst Review — Implementation Plan

## 1. Vision

A desktop-first writing and research companion for serious written work. The user opens a project, drops in sources, drafts a document, and iterates on it with an LLM that behaves like Claude Code but for prose: it reads the document, reads the sources, proposes edits as diffs, and answers questions about its own output or the source material.

The core loop is **write → mark up → refine**, moved inside the app so the user never has to paste between tools.

## 2. Target platforms

- **Primary:** Desktop app (macOS, Windows, Linux) via Electron. Shipped through Mac App Store / direct download.
- **Secondary:** Web build using the same React frontend against a thin backend shim (later; the Electron main process and a web server should expose the same IPC surface so the renderer code is portable).

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Cross-platform desktop, local filesystem access for projects/sources, easy packaging. |
| Renderer | React + TypeScript + Vite | Standard, fast HMR, typed. |
| Editor | Milkdown (ProseMirror-based WYSIWYG markdown) | Pretty out of the box, plugin system for inline decorations and widgets, real markdown in / out. Chosen over CodeMirror 6 for the writer-friendly feel. Inline-comment anchoring will use Milkdown/ProseMirror plugins. |
| Markdown rendering | `remark` + `rehype` pipeline with KaTeX, Shiki for code | Pretty output without locking into a heavyweight editor. |
| Diff view | `diff` + custom CM6 decorations, or `react-diff-viewer-continued` | Needed for edit-request accept/reject flow. |
| State | Zustand or Redux Toolkit | Session state for comments, chat, diffs. |
| LLM gateway | OpenRouter (single API key in settings for now) | One integration, many models. Default model: cost-efficient (candidates: `google/gemma-3-27b-it`, `google/gemini-2.5-flash`). User can override per project. |
| PDF ingestion | `pdf-parse` or `pdfjs-dist` in main process | Extract text from dropped PDFs. |
| File storage | Plain filesystem — each project is a directory | Matches the "structured markdown wiki" design. No DB. |
| IPC | Electron `contextBridge` exposing a typed API | Keeps renderer sandboxed. |
| Packaging | `electron-builder` | Standard. |

Deliberately **not** using: vector DBs, embeddings, LangChain, or any RAG framework. Sources live on disk as markdown; the LLM gets them via direct file reads scoped by the agent loop.

## 4. Project data model (on disk)

Each project is a folder the user chooses. Layout:

```
MyProject/
  project.json              # metadata: name, default model, created, etc.
  agent.md                  # system prompt / operating instructions for the LLM
  document.md               # the main editable document
  chat.jsonl                # main chat transcript (append-only)
  comments.json             # open/resolved/orphaned comments with anchors
  sources/
    index.md                # one-line summary of every source, maintained by app
    source_a.md             # ingested + cleaned text of source A
    source_a.meta.json      # original filename, type, date, citation hint
    source_b.md
    ...
  .myst/
    context-cache.json      # summarized / squished context snapshots
    diffs/                  # pending edit proposals awaiting accept/reject
```

Design rules:
- Everything important is a plain file the user can read, edit, or commit to git.
- The app reads and writes these files directly; no hidden database.
- `index.md` is the LLM's map of available sources. When the LLM wants more detail it reads the specific `source_x.md` file.

## 5. The agent layer

`agent.md` is committed into every new project from a template. It's the system prompt the LLM runs under, explaining:
- What a project is (document + sources + chat).
- How to read sources: start from `sources/index.md`, then open specific source files as needed.
- How to respond to the three comment types (edit request, quick question, deep question).
- Output discipline: proposed edits come back as a structured block the app can parse into a diff. Short answers stay short.
- When to ask for clarification vs. when to act.

The user can edit `agent.md` per project — this is the "Claude Code for writing" lever. Advanced users tune their own workflow.

## 6. Main window layout

```
┌─────────────────────────────────────────────────────────┐
│  project name        model selector         settings    │
├──────────┬─────────────────────────────┬────────────────┤
│ Sources  │                             │                │
│ panel    │   Document (markdown)       │   Chat panel   │
│          │                             │                │
│  +drop   │   (click-to-comment,        │   (main        │
│  index   │    inline diff review)      │    project     │
│          │                             │    chat)       │
└──────────┴─────────────────────────────┴────────────────┘
```

- **Left — Sources panel:** drop zone for PDFs / markdown files. Lists ingested sources with their one-line summaries from `index.md`. Click to preview.
- **Center — Document:** the main writing surface. Three user modes (see §7).
- **Right — Chat panel:** free-form conversation scoped to the project. Has access to `document.md`, `agent.md`, and `sources/`.

Collapsible panels. Center is always visible.

## 7. The three user modes on the document

### Mode A — Plain editor
The document behaves like any markdown editor. No AI interaction on the document itself; the chat panel is still available on the right for general conversation.

### Mode B — Inline commenting (core feature)
User selects a span of text, presses **Comment**, writes either a request or a question.

- **Edit request** ("tighten this", "add a counterpoint"):
  1. LLM reads the document + selection + comment + relevant sources.
  2. Returns a proposed edit as a structured diff + a one-line summary of what changed and why.
  3. UI shows the diff inline on the document with Accept / Reject / Discuss buttons.
  4. **Discuss** opens a thread on that comment — a mini conversation scoped to this edit, separate from main chat.
  5. **Try again** prompts the user for a specific instruction before regenerating (never a blind retry).

- **Question** ("what is this?", "does the source actually say this?"):
  1. LLM answers in a small popover anchored to the selection.
  2. No document edit. The popover hosts a mini conversation with its own memory, separate from main chat.
  3. For source verification, the popover can escalate to a sidebar that optionally accepts an ad-hoc source upload scoped to that thread only.

### Mode C — Review Mode (fullscreen)
Matches the original proposal: takes over the viewport, Reply immediately / Reply when prompted toggle, batch-run all comments. Built on the same primitives as Mode B, just presented as a dedicated workspace.

For MVP, **Mode A + Mode B** first. Mode C layers on once the commenting primitives are solid.

## 8. Comment anchoring

Word-based anchors, not character offsets:
- Store the anchored phrase + a short context window (N words before and after).
- On every render, locate the phrase in the current document text by matching phrase + context.
- If the phrase has been rewritten or deleted, mark the comment **orphaned**. User can reopen or discard.
- Applied edits never require recalculating other anchors as long as the anchored phrases themselves survive.

## 9. LLM integration (OpenRouter)

- Single settings screen: API key, default model, per-project model override.
- Default model chosen for cost: candidate `google/gemma-3-27b-it` or `google/gemini-2.5-flash`. Finalize after a quick quality pass on typical editing tasks.
- All requests go through a small `llm` module in the main process that:
  - Injects `agent.md` as system prompt.
  - Builds the context bundle for the request (see §10).
  - Streams tokens back to the renderer.
  - Parses structured edit proposals out of the response.

## 10. Context assembly and squishing

Each request to the LLM gets a bundle:
1. `agent.md` (always).
2. Current `document.md` (always, unless huge — then squished).
3. `sources/index.md` (always).
4. Any source files the user or a prior turn explicitly referenced.
5. The relevant chat history for the scope (main chat, or a comment thread, or the sidebar).
6. The user's current comment / message.

**Squishing:** when the bundle exceeds a threshold (say 60% of the model's context window), the oldest chat turns are replaced with a short summary generated by a cheap call to the same model. The summary is cached in `.myst/context-cache.json` keyed by turn range, so repeated squishes don't repeat work. Naive but sufficient — nothing fancier until it hurts.

Main chat, comment threads, and sidebar chats are **separate histories**. They don't cross-contaminate. Each has its own squishing.

## 11. Source ingestion pipeline

When a user drops a file into the Sources panel:
1. Main process receives the path (Electron file drop).
2. If PDF: extract text with `pdfjs-dist`, clean up whitespace, write to `sources/source_<slug>.md`. Store original filename in `.meta.json`.
3. If markdown / text: copy into `sources/source_<slug>.md` as-is.
4. Kick off a background LLM call: "summarize this source in one sentence for an index." Append the returned line to `sources/index.md` as `- [source_<slug>](source_<slug>.md) — <summary>`.
5. Notify renderer; sources panel refreshes.

No embeddings, no chunking, no vector store. The LLM reads files when it needs them.

## 12. Diff and accept/reject flow

1. LLM returns an edit proposal in a structured fenced block the parser recognizes (e.g. ` ```myst-edit ` with `before` / `after` / `summary` fields).
2. App computes a line/word diff and stores it in `.myst/diffs/<comment-id>.json`.
3. UI shows the diff inline on the document with the summary.
4. **Accept:** apply the edit to `document.md`, re-resolve all comment anchors, mark comment resolved.
5. **Reject:** drop the diff, leave the comment open.
6. **Discuss:** open the comment thread popover. Further turns can generate new proposals, each replacing the previous pending diff.

The document stays immutable until Accept — edits are layered on top as pending diffs, not applied in place. This is the safest approach for anchor stability.

## 13. Build phases

**Phase 0 — Skeleton (week 1)**
- Electron + Vite + React + TS scaffold.
- Main window with three-pane layout, placeholder content.
- Settings screen with OpenRouter API key storage (keychain on macOS, DPAPI on Windows, libsecret on Linux).
- "New project" / "Open project" flows backed by a folder picker.

**Phase 1 — Project + editor (week 2)**
- Project folder read/write: `document.md`, `project.json`, `agent.md` template.
- Markdown editor in center pane (CodeMirror 6 + markdown rendering).
- Autosave.

**Phase 2 — Chat panel (week 3)**
- Right-pane chat wired to OpenRouter.
- `agent.md` as system prompt, `document.md` injected as context.
- Streaming responses. `chat.jsonl` persistence.
- Context squishing v1.

**Phase 3 — Sources (week 4)**
- Drop zone, PDF + md ingestion, per-source files, `sources/index.md` maintenance.
- LLM summarization call on ingest.
- Source preview panel.

**Phase 4 — Inline commenting (weeks 5–6)** ← the real feature
- Selection → comment popover.
- Comment types: edit / question.
- Word-based anchoring with orphan detection.
- Mini conversation threads per comment, kept separate from main chat.
- Edit proposal parsing, inline diff rendering, accept/reject/discuss.
- `comments.json` persistence.

**Phase 5 — WIKI Deep Dive**
- Will go further into the world of WIKI, each source inputted will be linked to similar sources creating a users "web of information"

**Phase 6 — Polish + packaging**
- Theming, keyboard shortcuts, empty states, error handling around OpenRouter outages.
- `electron-builder` configs, code signing, auto-update (Squirrel).
- Web build experiment.

## 14. Open questions

- ~~**Editor choice:**~~ Locked in: **Milkdown**. Anchoring will be a custom ProseMirror plugin during Phase 4.
- **Default model:** Gemma 3 27B vs. Gemini 2.5 Flash vs. something else on OpenRouter. Quality/cost pass before Phase 2.
- **Monetization:** own-key (user supplies OpenRouter key) vs. hosted (we pay, charge subscription). Deferred — ship own-key first.
- **Collaboration / multi-user:** out of scope for v1. Projects are single-user local folders.
- **Mobile:** out of scope.
- **Git integration:** out of scope for v1 but the on-disk format is git-friendly on purpose.

## 15. Non-goals

- RAG, embeddings, vector stores.
- Real-time multiplayer editing.
- A custom model or fine-tuning.
- A plugin system (until there's a reason).
- Fancy analytics, telemetry, or accounts.

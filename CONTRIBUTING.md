# Contributing

Thanks for taking a look. Open Myst is small enough that a single coherent voice in the codebase matters more than process — so this doc is mostly *here is how to navigate it* with a few hard rules at the bottom.

## Before you start

- **Open an issue first** if you're planning a non-trivial change. A two-line "I'm thinking about X, would you take a PR?" saves both of us a wasted afternoon.
- **Read [docs/architecture.md](docs/architecture.md).** The folder layout looks obvious from the outside, but there are a few load-bearing conventions (the `platform/` boundary, the IPC adapter pattern, the `editLogic.ts` purity rule) that are easier to keep than to discover by accident.
- **Skim the docs/ folder** for the area you're touching. Each subsystem has its own page that explains *why* it's the way it is, not just what's there.

## Local development

```bash
npm install
npm run dev          # BYOK dev build — launches Electron with hot reload
npm run dev:prod     # managed (openmyst.ai) dev build
npm test             # vitest, runs once
npm run test:watch   # vitest in watch mode
npm run typecheck    # main + renderer tsc passes
npm run lint         # eslint
npm run format       # prettier write
```

The renderer hot-reloads on save. The main process needs a restart (`Cmd-R` in the dev window or just stop and restart `npm run dev`) when you change anything under `src/main/`.

### BYOK dev build vs. managed build

Open Myst ships in two flavours, selected at build time by the `USE_OPENMYST` env var:

- **BYOK dev build** (default — `npm run dev`, `npm run build`): the app talks directly to OpenRouter with the user's own API key, and to Jina with the user's own key. Settings surfaces input fields for both keys; they're stored encrypted in the OS keychain via `safeStorage`. This is the mode you'll spend most of your time in while developing.
- **Managed build** (`USE_OPENMYST=1` — `npm run dev:prod`, `npm run build:prod`): the app routes all LLM + search traffic through `https://www.openmyst.ai/api/v1/chat` using a user-scoped bearer token obtained via deep-link auth. The BYOK key-entry UI is gone; Settings shows the signed-in account, a daily quota readout, and a model dropdown. This is what ships to end users.

The flag is a **build-time literal**, not a runtime toggle. Vite's `define` replaces `USE_OPENMYST` with `true`/`false` so Rollup can tree-shake the unused branch — crucially, **we do not want BYOK code paths, OpenRouter URLs, or key-entry UI shipping in the managed binary.** If you're touching anything that branches on `USE_OPENMYST` (see `src/shared/flags.ts` and `src/main/llm/index.ts`), run *both* `npm run build` and `npm run build:prod` before opening the PR to confirm neither path broke.

The full managed-mode contract — auth flow, error envelope, `X-Client-Version` header, quota semantics — lives in `docs/llm-layer.md` and the deep-link / account docs under `docs/`. Start there before touching `src/main/llm/openmyst.ts` or the auth feature.

### Production distributables

```bash
npm run dist         # BYOK build for the current platform
npm run dist:prod    # managed build for the current platform
npm run dist:prod:mac   # managed build, mac only
npm run dist:prod:win   # managed build, windows only
npm run dist:prod:linux # managed build, linux only
```

Signing and notarisation aren't wired into these scripts yet — they produce unsigned artifacts suitable for manual testing. Don't ship the output of `dist:prod:*` to real users without going through the platform's signing pipeline.

## Code organisation

The `src/main/` tree is feature-folder. One feature = one folder = one entry in `src/main/ipc/`. The two rules that keep this clean:

1. **Features import from `platform/` and `llm/`, never directly from `electron` or `node:fs`.** If you find yourself reaching for `BrowserWindow` or `fs.readFile` inside a feature file, add a helper to `platform/` instead. This keeps features straightforward to test and means the day we want to swap the LLM transport, sandbox, or storage backend, we know exactly which files move.
2. **`features/chat/editLogic.ts` stays pure.** No imports of `electron`, `node:fs`, or anything project-aware. It's the one file with real unit-test coverage and we want to keep it that way.

If you're adding a new feature, follow [docs/adding-a-feature.md](docs/adding-a-feature.md) — there's a step-by-step recipe.

## Testing

- Pure logic (parsers, edit application, merge rules) gets unit tests under `src/main/__tests__/` or `src/renderer/src/__tests__/`. We use Vitest.
- Integration coverage is mostly manual today — there's no headless Electron harness yet. If you can add one, please do.
- Always run `npm run typecheck && npm test` before opening a PR. CI is not yet wired up; you are CI.

## Style

- Prettier for formatting (`npm run format`). Don't argue with it.
- ESLint for the rest. Warnings are fine, errors aren't.
- Comments explain *why*, not *what*. If a function is doing something subtle or load-bearing, leave a note. Otherwise let the code speak.
- Names matter. Prefer `pendingEditsForDoc` over `pe`, `streamChat` over `chat`. The codebase is small enough that you don't pay a typing cost for being clear.

## Pull requests

- One concern per PR. *Refactor + new feature* is two PRs.
- Title in the imperative ("Add wiki graph filter") not past tense.
- Description: what changed, why, anything reviewers should pay attention to. Screenshots for UI changes.
- If you touched the agent's system prompt or the `myst_edit` parser, call it out — those are the highest-blast-radius surfaces in the codebase.

## Hard rules

- **Don't commit API keys or auth tokens.** OpenRouter and Jina keys (BYOK build) and `omk_live_...` bearer tokens (managed build) are stored in the OS keychain via `safeStorage`, not the repo, but double-check before pushing — a stray `console.log(token)` left in a commit is a live credential.
- **Don't leak BYOK code into the managed bundle.** Anything behind a `USE_OPENMYST` check relies on Rollup tree-shaking the dead branch. Don't defeat that by importing OpenRouter modules unconditionally from a shared file, or by swapping the build-time flag for a runtime lookup.
- **Don't break the editLogic test suite.** If you change `editLogic.ts`, update the tests in the same commit.
- **Don't reach across layers.** Renderer never imports from `main/`; main never imports from `renderer/`. Both go through `shared/` types and IPC channels.

If something here is wrong or out of date, fix it in the same PR — these docs are part of the codebase, not a separate project.

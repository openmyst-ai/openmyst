import type { TutorialStep } from './TutorialOverlay';

/**
 * Step decks for the first-run tours. Targets are `data-tutorial` ids on
 * real DOM nodes — see DeepPlanMode / Layout for where they're attached.
 * A missing target just renders as a centered callout, which is fine:
 * some elements (like "Stop research") only exist conditionally.
 */

export const DEEP_PLAN_TUTORIAL: TutorialStep[] = [
  {
    title: 'Welcome to Deep Plan',
    body:
      "Deep Plan is a guided walk from a vague idea to a drafted essay. You'll work through eight short stages with a planner. Click Next to see how it's laid out.",
    placement: 'center',
  },
  {
    target: 'dp-stagebar',
    title: 'Stage bar',
    body:
      'The planner moves through Intent → Sources → Scoping → Gaps → Research → Clarify → Review → Handoff. This bar shows where you are and what comes next.',
    placement: 'bottom',
  },
  {
    target: 'dp-sources',
    title: 'Sources',
    body:
      'Drop PDFs, paste URLs, or add plain text. Anything here is fair game for the planner — and for the Research stage, it gets linked into your wiki.',
    placement: 'right',
  },
  {
    target: 'dp-conversation',
    title: 'Conversation with the planner',
    body:
      "Chat here. The planner asks questions at each stage to pin down scope, audience, and structure — answer normally, it's just a conversation.",
    placement: 'left',
  },
  {
    target: 'dp-wiki',
    title: 'Wiki graph',
    body:
      "Your project's sources rendered as a graph. When the Research stage runs, new sources pop in here as the agent finds them. Click any node to read its summary.",
    placement: 'left',
  },
  {
    target: 'dp-advance',
    title: 'Advance the stage',
    body:
      "When you're happy with the current stage, hit Continue. During Research this becomes Stop; during Review it becomes 'Write the draft'.",
    placement: 'bottom',
  },
  {
    target: 'dp-skip',
    title: 'Skip to the editor',
    body:
      "Don't want the guided flow today? Skip Deep Plan and jump straight into writing — your sources stay, the planner just steps aside.",
    placement: 'bottom',
  },
  {
    target: 'dp-settings',
    title: 'Settings',
    body:
      'API keys, account, and updates live here. If the planner isn\'t responding, this is usually where to look first.',
    placement: 'bottom',
  },
];

export const EDITOR_TUTORIAL: TutorialStep[] = [
  {
    title: "You're in the editor",
    body:
      'This is where the actual writing happens. Let me show you the bits — should only take a few seconds.',
    placement: 'center',
  },
  {
    target: 'ed-sources',
    title: 'Sources',
    body:
      'Everything you fed into Deep Plan (and anything you add later) lives here. Click a source to preview its summary.',
    placement: 'right',
  },
  {
    target: 'ed-files',
    title: 'Documents',
    body:
      'All the markdown files in your project. Click one to open it in the editor; right-click to rename or delete.',
    placement: 'right',
  },
  {
    target: 'ed-toc',
    title: 'Table of contents',
    body:
      "Auto-generated from the headings in whatever's open. Jump around a long document without scrolling.",
    placement: 'right',
  },
  {
    target: 'ed-doc',
    title: 'The editor',
    body:
      'Markdown-first with live LaTeX ($$…$$) and citations. Select text and right-click for AI rewrites, or just type.',
    placement: 'left',
  },
  {
    target: 'ed-chat',
    title: 'Chat',
    body:
      'Ask the AI to edit, expand, critique, or rewrite any selection — or just chat about the draft. It can see your sources.',
    placement: 'left',
  },
  {
    target: 'ed-deep-wiki',
    title: 'Deep Wiki',
    body:
      "Search your project's research graph anytime. Type a question to send the agent hunting; anything it ingests joins the graph.",
    placement: 'bottom',
  },
  {
    target: 'ed-settings',
    title: 'Settings',
    body:
      'API keys, updates, account. Check here if something stops working or a new version is waiting.',
    placement: 'bottom',
  },
];

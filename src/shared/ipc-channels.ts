export const IpcChannels = {
  Auth: {
    Status: 'auth:status',
    SignIn: 'auth:sign-in',
    PasteToken: 'auth:paste-token',
    SignOut: 'auth:sign-out',
    Changed: 'auth:changed',
  },
  Me: {
    Get: 'me:get',
    Refresh: 'me:refresh',
    Changed: 'me:changed',
  },
  Settings: {
    Get: 'settings:get',
    SetOpenRouterKey: 'settings:set-openrouter-key',
    HasOpenRouterKey: 'settings:has-openrouter-key',
    ClearOpenRouterKey: 'settings:clear-openrouter-key',
    SetDefaultModel: 'settings:set-default-model',
    SetJinaKey: 'settings:set-jina-key',
    HasJinaKey: 'settings:has-jina-key',
    ClearJinaKey: 'settings:clear-jina-key',
    SetDeepPlanModel: 'settings:set-deep-plan-model',
    SetSummaryModel: 'settings:set-summary-model',
  },
  Projects: {
    CreateNew: 'projects:create-new',
    Open: 'projects:open',
    GetCurrent: 'projects:get-current',
    Close: 'projects:close',
    ListRecent: 'projects:list-recent',
    CreateByName: 'projects:create-by-name',
    OpenByPath: 'projects:open-by-path',
  },
  Workspace: {
    GetRoot: 'workspace:get-root',
    PickRoot: 'workspace:pick-root',
    SetRoot: 'workspace:set-root',
    ListProjects: 'workspace:list-projects',
  },
  Document: {
    Read: 'document:read',
    Write: 'document:write',
    Changed: 'document:changed',
  },
  Documents: {
    List: 'documents:list',
    Create: 'documents:create',
    Delete: 'documents:delete',
  },
  Chat: {
    Send: 'chat:send',
    History: 'chat:history',
    Clear: 'chat:clear',
    Started: 'chat:started',
    Chunk: 'chat:chunk',
    ChunkDone: 'chat:chunk-done',
  },
  Comments: {
    List: 'comments:list',
    Create: 'comments:create',
    Delete: 'comments:delete',
    Changed: 'comments:changed',
  },
  PendingEdits: {
    List: 'pending-edits:list',
    Accept: 'pending-edits:accept',
    Reject: 'pending-edits:reject',
    Patch: 'pending-edits:patch',
    Clear: 'pending-edits:clear',
    Changed: 'pending-edits:changed',
  },
  Sources: {
    Ingest: 'sources:ingest',
    IngestText: 'sources:ingest-text',
    IngestLink: 'sources:ingest-link',
    PickFiles: 'sources:pick-files',
    List: 'sources:list',
    Read: 'sources:read',
    Delete: 'sources:delete',
    Changed: 'sources:changed',
  },
  Wiki: {
    Graph: 'wiki:graph',
  },
  BugReport: {
    Preview: 'bug-report:preview',
    Submit: 'bug-report:submit',
    RendererLog: 'bug-report:renderer-log',
  },
  DeepPlan: {
    Status: 'deep-plan:status',
    Start: 'deep-plan:start',
    /** Submit a free-text turn (e.g. a follow-up question during ideation). */
    SendMessage: 'deep-plan:send-message',
    /** Submit answers to the Chair's pending questions. */
    SubmitAnswers: 'deep-plan:submit-answers',
    /** Force-advance to the next phase even if the Chair hasn't signalled. */
    Advance: 'deep-plan:advance',
    Skip: 'deep-plan:skip',
    /** Final handoff from `reviewing` to the drafter. */
    OneShot: 'deep-plan:one-shot',
    Reset: 'deep-plan:reset',
    Changed: 'deep-plan:changed',
    /** Streaming chunks from the drafter (one-shot only now). */
    Chunk: 'deep-plan:chunk',
    ChunkDone: 'deep-plan:chunk-done',
    /** Live research-engine events (panelist-dispatched queries). */
    ResearchEvent: 'deep-plan:research-event',
    /** Live panel-round progress (role-start / role-done / chair-start / …). */
    PanelProgress: 'deep-plan:panel-progress',
  },
  DeepSearch: {
    Status: 'deep-search:status',
    Start: 'deep-search:start',
    Stop: 'deep-search:stop',
    Reset: 'deep-search:reset',
    AddHint: 'deep-search:add-hint',
    Changed: 'deep-search:changed',
  },
  Updater: {
    GetStatus: 'updater:get-status',
    Check: 'updater:check',
    DownloadAndInstall: 'updater:download-and-install',
    Changed: 'updater:changed',
  },
} as const;

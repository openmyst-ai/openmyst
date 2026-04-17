/**
 * Build-time feature flags. The values here are replaced literally by Vite's
 * `define` at build time (see `electron.vite.config.ts`), so unused branches
 * dead-code-eliminate from the bundle. That matters for the managed-mode
 * build — we do NOT want BYOK code paths shipping in end-user binaries.
 */

declare const __USE_OPENMYST__: boolean;

/**
 * When true, the app routes all LLM + search traffic through the openmyst.ai
 * relay using a user-scoped API token. When false, the app talks directly to
 * OpenRouter/Jina with user-supplied keys (developer BYOK flow).
 *
 * Flip via `USE_OPENMYST=1` at build time. Never toggle at runtime — login
 * screens, endpoint URLs, and settings panes branch on this literal.
 */
export const USE_OPENMYST: boolean = __USE_OPENMYST__;

/** Base URL for the openmyst.ai API. Override with env for local backends. */
export const OPENMYST_API_BASE_URL = 'https://www.openmyst.ai';

/** Deep-link scheme the OS hands back to us after web-side auth. */
export const OPENMYST_DEEP_LINK_SCHEME = 'openmyst';

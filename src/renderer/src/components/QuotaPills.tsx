import { USE_OPENMYST } from '@shared/flags';
import type { MeQuotaBucket } from '@shared/types';
import { useMe } from '../store/me';

/**
 * Two small counters rendered in the chat header when in managed mode:
 * chat token usage and search token usage. Free users get "12.4k / 400k";
 * Pro users get "12.4k · ∞". Pills warn at ≥70% and go red at ≥85% of
 * the daily budget. BYOK dev mode renders nothing.
 */

/**
 * Compact token count: "850", "1.5k", "12k", "400k", "1.2M". Rounding
 * picks up speed past 10k so "412000" doesn't read as "412.0k".
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${n}`;
}

function usageRatio(b: MeQuotaBucket): number {
  if (b.limit === null || b.limit <= 0) return 0;
  return b.used / b.limit;
}

function bucketClass(b: MeQuotaBucket): string {
  if (b.limit === null) return 'quota-pill quota-pill-pro';
  const ratio = usageRatio(b);
  if (ratio >= 1) return 'quota-pill quota-pill-danger';
  if (ratio >= 0.85) return 'quota-pill quota-pill-danger';
  if (ratio >= 0.7) return 'quota-pill quota-pill-warn';
  return 'quota-pill';
}

function formatBucket(b: MeQuotaBucket, label: string): string {
  if (b.limit === null) return `${formatTokens(b.used)} ${label} · ∞`;
  return `${formatTokens(b.used)} / ${formatTokens(b.limit)} ${label}`;
}

export function QuotaPills(): JSX.Element | null {
  const { snapshot, offline } = useMe();
  if (!USE_OPENMYST) return null;
  if (!snapshot) return null;

  return (
    <div className="quota-pills" aria-label="Daily usage">
      <span
        className={bucketClass(snapshot.quota.chat)}
        title={`Resets ${snapshot.quota.chat.resetsAt}`}
      >
        {formatBucket(snapshot.quota.chat, 'chat')}
      </span>
      <span
        className={bucketClass(snapshot.quota.search)}
        title={`Resets ${snapshot.quota.search.resetsAt}`}
      >
        {formatBucket(snapshot.quota.search, 'search')}
      </span>
      {offline && <span className="quota-pill quota-pill-offline">offline</span>}
    </div>
  );
}

export function ApproachingLimitBanner(): JSX.Element | null {
  const { snapshot } = useMe();
  if (!USE_OPENMYST) return null;
  if (!snapshot) return null;

  const buckets: Array<{ name: 'chat' | 'search'; bucket: MeQuotaBucket }> = [
    { name: 'chat', bucket: snapshot.quota.chat },
    { name: 'search', bucket: snapshot.quota.search },
  ];

  const exhausted = buckets.filter(
    (b) =>
      b.bucket.limit !== null &&
      b.bucket.remaining !== null &&
      b.bucket.remaining <= 0,
  );
  const nearLimit = buckets.filter((b) => usageRatio(b.bucket) >= 0.85);

  if (exhausted.length === 0 && nearLimit.length === 0) return null;

  const upgradeUrl = 'https://www.openmyst.ai/pricing';
  const message = exhausted.length
    ? `Out of free ${exhausted.map((b) => b.name).join(' + ')} token budget today.`
    : `Nearly out of free ${nearLimit.map((b) => b.name).join(' + ')} token budget today.`;

  return (
    <div
      className={`quota-banner ${exhausted.length ? 'quota-banner-blocked' : 'quota-banner-warn'}`}
    >
      <span>{message}</span>{' '}
      <a href={upgradeUrl} target="_blank" rel="noreferrer">
        Upgrade to Pro
      </a>
    </div>
  );
}

export function PoweredByModel(): JSX.Element | null {
  if (!USE_OPENMYST) return null;
  return <span className="powered-by"></span>;
}

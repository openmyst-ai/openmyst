import { USE_OPENMYST } from '@shared/flags';
import type { MeQuotaBucket } from '@shared/types';
import { useMe } from '../store/me';

/**
 * Two small counters rendered in the chat header when in managed mode:
 * chat usage and search usage (changes.md §6). Pro users get a single
 * "Pro ∞" pill instead. BYOK dev mode renders nothing.
 */

function bucketClass(b: MeQuotaBucket): string {
  if (b.limit === null) return 'quota-pill quota-pill-pro';
  if (b.remaining !== null && b.remaining <= 1) return 'quota-pill quota-pill-danger';
  if (b.remaining !== null && b.remaining <= 5) return 'quota-pill quota-pill-warn';
  return 'quota-pill';
}

function formatBucket(b: MeQuotaBucket, label: string): string {
  if (b.limit === null) return `∞ ${label}`;
  return `${b.used} / ${b.limit} ${label}`;
}

export function QuotaPills(): JSX.Element | null {
  const { snapshot, offline } = useMe();
  if (!USE_OPENMYST) return null;
  if (!snapshot) return null;

  return (
    <div className="quota-pills" aria-label="Daily usage">
      <span className={bucketClass(snapshot.quota.chat)} title={`Resets ${snapshot.quota.chat.resetsAt}`}>
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
    (b) => b.bucket.limit !== null && b.bucket.remaining !== null && b.bucket.remaining <= 0,
  );
  const oneLeft = buckets.filter(
    (b) => b.bucket.limit !== null && b.bucket.remaining === 1,
  );

  if (exhausted.length === 0 && oneLeft.length === 0) return null;

  const upgradeUrl = 'https://www.openmyst.ai/pricing';
  const message = exhausted.length
    ? `Out of free ${exhausted.map((b) => b.name).join(' + ')} requests today.`
    : `Last free ${oneLeft.map((b) => b.name).join(' + ')} request today.`;

  return (
    <div className={`quota-banner ${exhausted.length ? 'quota-banner-blocked' : 'quota-banner-warn'}`}>
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

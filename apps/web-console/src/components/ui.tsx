import type { ReactNode } from 'react';
import { humanize } from '../lib/format';

/** Status colouring, in one place so a verdict never looks different on two screens. */
const STATUS_TONE: Record<string, string> = {
  passed: 'bg-good-light text-good',
  healed: 'bg-info-light text-info',
  flaky: 'bg-warn-light text-warn',
  failed: 'bg-bad-light text-bad',
  error: 'bg-bad-light text-bad',
  blocked: 'bg-warn-light text-warn',
  skipped: 'bg-surface-sunken text-ink-muted',
  cancelled: 'bg-surface-sunken text-ink-muted',
  timedOut: 'bg-bad-light text-bad',
  running: 'bg-brand-light text-brand',
  queued: 'bg-surface-sunken text-ink-muted',
  pending: 'bg-surface-sunken text-ink-muted',
  completed: 'bg-good-light text-good',
  partiallyCompleted: 'bg-warn-light text-warn',
  proposed: 'bg-warn-light text-warn',
  applied: 'bg-info-light text-info',
  approved: 'bg-good-light text-good',
  rejected: 'bg-bad-light text-bad',
  reverted: 'bg-surface-sunken text-ink-muted',
  critical: 'bg-bad-light text-bad',
  high: 'bg-warn-light text-warn',
  medium: 'bg-brand-light text-brand',
  low: 'bg-surface-sunken text-ink-muted',
  informational: 'bg-surface-sunken text-ink-muted',

  // Security. The finding statuses carry weight in one direction only: something confirmed
  // or regressed is coloured as a problem, and something a person set aside is deliberately
  // quiet rather than green — a false positive is not an achievement, it is a decision.
  potential: 'bg-warn-light text-warn',
  confirmed: 'bg-bad-light text-bad',
  regressed: 'bg-bad-light text-bad',
  regression: 'bg-bad-light text-bad',
  needsReview: 'bg-warn-light text-warn',
  falsePositive: 'bg-surface-sunken text-ink-muted',
  accepted: 'bg-surface-sunken text-ink-muted',
  resolved: 'bg-good-light text-good',

  // Gate outcomes. REVIEW is amber rather than green on purpose: it covers "nobody scanned",
  // and a green badge there would be the exact misreading the gate exists to prevent.
  pass: 'bg-good-light text-good',
  review: 'bg-warn-light text-warn',
  fail: 'bg-bad-light text-bad',
  'not measured': 'bg-warn-light text-warn',

  // Scope state.
  enabled: 'bg-good-light text-good',
  disabled: 'bg-surface-sunken text-ink-muted',
  permitted: 'bg-warn-light text-warn'
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const tone = STATUS_TONE[status] ?? 'bg-surface-sunken text-ink-muted';
  return <span className={`badge ${tone}`} title={title}>{humanize(status)}</span>;
}

export function Card({ title, description, actions, children, className = '' }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
          <div>
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="text-sm text-ink-muted mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Metric({ label, value, tone = 'neutral', hint }: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info';
  hint?: string;
}) {
  const tones = {
    neutral: 'text-ink',
    good: 'text-good',
    bad: 'text-bad',
    warn: 'text-warn',
    info: 'text-info'
  };
  return (
    <div className="card-pad">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

/**
 * The empty state carries the next action rather than just reporting absence — an empty
 * screen that tells you nothing is the most common way a product feels broken when it is
 * merely new.
 */
export function EmptyState({ title, description, action }: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-6">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm text-ink-muted max-w-md mx-auto">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const correlationId = (error as { correlationId?: string }).correlationId;

  return (
    <div role="alert" className="rounded-lg border border-bad/25 bg-bad-light px-4 py-3">
      <p className="text-sm font-semibold text-bad">{message}</p>
      {correlationId && (
        <p className="mt-1 text-xs text-bad/80 font-mono">Reference: {correlationId}</p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary btn-sm mt-2.5">
          Try again
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center" role="status">
      <span
        className="inline-block h-4 w-4 rounded-full border-2 border-line border-t-brand animate-spin"
        aria-hidden="true"
      />
      {label}…
    </div>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-bold text-ink">{title}</h1>
        {description && <p className="text-sm text-ink-muted mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A labelled note that content came from the built-in rules, not a model. */
export function ProviderNote({ provider, model, isLocal }: {
  provider: string;
  model: string;
  isLocal: boolean;
}) {
  return (
    <p className="text-xs text-ink-muted">
      {isLocal ? (
        <>Generated by AIRA's built-in rules (<span className="font-mono">{model}</span>) — no model provider is configured.</>
      ) : (
        <>Generated by <span className="font-medium">{provider}</span> <span className="font-mono">{model}</span>.</>
      )}
    </p>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const tone = value >= 85 ? 'bg-good' : value >= 70 ? 'bg-warn' : 'bg-bad';
  return (
    <div className="flex items-center gap-2 min-w-[8rem]">
      <div className="h-1.5 flex-1 rounded-full bg-line overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums text-ink-muted w-9 text-right">{value}%</span>
    </div>
  );
}

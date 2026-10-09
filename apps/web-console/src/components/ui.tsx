import { useEffect, useRef } from 'react';
import type { ReactNode, Ref } from 'react';
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

export function Card({ id, title, description, actions, children, className = '', labelledBy, sectionRef }: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Set by {@link useDisclosedPanel} so a panel that appears on demand names itself. */
  labelledBy?: string;
  sectionRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      id={id}
      ref={sectionRef}
      className={`card ${className}`}
      aria-labelledby={labelledBy}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 border-b border-line">
          {/* flex-wrap and min-w-0 are what keep a narrow viewport from scrolling sideways.
              `.badge` is whitespace-nowrap and the actions are shrink-0, so a card whose
              title and status badge together exceed the width had no way to give: neither
              side could shrink, and the row ran past the screen (QA pass, ISSUE-002,
              measured at 430px against a 375px viewport). Wrapping drops the actions onto
              their own line instead, and min-w-0 lets a long title shrink rather than
              push, because a flex item defaults to min-width:auto. */}
          <div className="min-w-0">
            {title && <h2 id={labelledBy} className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="text-sm text-ink-muted mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * Wires a form panel that appears when a button is pressed.
 *
 * These panels opened with nothing to announce them and focus left on `<body>`, so a
 * keyboard or screen-reader user got no signal that a form had appeared and had to tab
 * through the header and fifteen navigation links to reach the first field.
 *
 * They are laid out inline, in the page flow, so they are NOT modals: marking them
 * `aria-modal` would tell a screen reader the rest of the page is inert when it is not.
 * A named region plus moved focus is the accurate treatment — the panel announces itself,
 * and the trigger says whether it is open.
 *
 * `id` must be unique on the page; pass something stable like 'new-project'.
 */
export function useDisclosedPanel(id: string, open: boolean) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const headingId = `${id}-heading`;

  useEffect(() => {
    if (!open) return;
    const first = sectionRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea'
    );
    // preventScroll: the panel is already in view, and yanking the viewport on open is
    // its own annoyance.
    first?.focus({ preventScroll: true });
  }, [open]);

  return {
    /** Spread onto the button that opens the panel. */
    triggerProps: { 'aria-expanded': open, 'aria-controls': id } as const,
    /** Spread onto the Card that is the panel. */
    panelProps: { id, labelledBy: headingId, sectionRef } as const
  };
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

/**
 * `action` is the way out when retrying cannot work.
 *
 * "Try again" is the right offer for a request that failed in transit. It is the wrong and
 * only offer for a record that does not exist: opening a run id that was never real left
 * the reader on a dead end whose one button could never succeed, with no link back to the
 * list. A caller that knows the resource is missing passes somewhere to go instead.
 */
export function ErrorNotice(
  { error, onRetry, action }: { error: unknown; onRetry?: () => void; action?: ReactNode }
) {
  const message = error instanceof Error ? error.message : String(error);
  const correlationId = (error as { correlationId?: string }).correlationId;

  return (
    <div role="alert" className="rounded-lg border border-bad/25 bg-bad-light px-4 py-3">
      <p className="text-sm font-semibold text-bad">{message}</p>
      {correlationId && (
        <p className="mt-1 text-xs text-bad/80 font-mono">Reference: {correlationId}</p>
      )}
      {(onRetry || action) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {onRetry && (
            <button type="button" onClick={onRetry} className="btn-secondary btn-sm">
              Try again
            </button>
          )}
          {action}
        </div>
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
        <>Generated by QA NXT's built-in rules (<span className="font-mono">{model}</span>) — no model provider is configured.</>
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

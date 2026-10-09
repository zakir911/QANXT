import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../api/client';
import { Card, useDisclosedPanel } from '../components/ui';

/**
 * Writing the record that authorizes security testing of one application.
 *
 * Until this existed the console displayed a scope and had no way to create one, so the
 * empty state told a user that "until somebody writes one, nothing here can be scanned" and
 * then offered nothing to write it with. The only route was a PUT by hand, which the manual
 * documented as a gap. A control that is enforced in the engine, exposed over the API and
 * unsettable from the product is not really a control a user has.
 *
 * It is a deliberately heavy form, because what it writes is not configuration. A scope
 * records that a named person authorized testing of somebody's application, and it is the
 * first thing anyone will ask to see if a scan ever causes a problem. So:
 *
 *  - The note is required, and a bare word is refused. "Authorized" with no name, no date
 *    and no boundary is the paperwork without the decision.
 *  - Nothing is on by default. Active, destructive and production each start off, and each
 *    has to be turned on deliberately.
 *  - Destructive and production ask for typed confirmation. A checkbox is too cheap for
 *    "send requests nobody can assume are reversible" and "touch production".
 *  - The rate fields start at the API's own refusing value of 0 only when there is no scope
 *    to edit; the form offers working defaults instead, since a scope that permits nothing
 *    by accident wastes the user's next ten minutes.
 */

export interface SecurityScopeRecord {
  id: string; applicationId: string; enabled: boolean;
  authorizationNote?: string | null;
  authorizedByUserId?: string | null; authorizedAt?: string | null;
  allowedDomains: string; allowedApiDomains: string;
  allowedPaths: string; blockedPaths: string;
  environmentId?: string | null;
  maxRequestsPerSecond: number; maxConcurrentRequests: number; maxScanDurationMinutes: number;
  allowActiveTesting: boolean; allowDestructiveTesting: boolean; allowProduction: boolean;
}

interface Props {
  applicationId: string;
  applicationName: string;
  /** The host from the application's base URL, offered as the starting allowlist. */
  suggestedHost: string;
  existing: SecurityScopeRecord | null;
  open: boolean;
  onClose(): void;
}

const CONFIRM_DESTRUCTIVE = 'DESTRUCTIVE';
const CONFIRM_PRODUCTION = 'PRODUCTION';

/** Enough to be a record of a decision rather than a word typed to clear a validation. */
const MIN_NOTE_LENGTH = 25;

export default function SecurityScopeEditor({
  applicationId, applicationName, suggestedHost, existing, open, onClose
}: Props) {
  const queryClient = useQueryClient();
  const panel = useDisclosedPanel('security-scope-editor', open, onClose);

  const [note, setNote] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [domains, setDomains] = useState('');
  const [apiDomains, setApiDomains] = useState('');
  const [allowedPaths, setAllowedPaths] = useState('');
  const [blockedPaths, setBlockedPaths] = useState('');
  const [rps, setRps] = useState('5');
  const [concurrency, setConcurrency] = useState('2');
  const [durationMinutes, setDurationMinutes] = useState('20');
  const [active, setActive] = useState(false);
  const [destructive, setDestructive] = useState(false);
  const [production, setProduction] = useState(false);
  const [destructiveConfirm, setDestructiveConfirm] = useState('');
  const [productionConfirm, setProductionConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // Reset to the stored scope each time the panel opens, so a cancelled edit does not leak
  // into the next one and an edit always starts from what is actually authorized now.
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setDestructiveConfirm('');
    setProductionConfirm('');

    if (existing) {
      setNote(existing.authorizationNote ?? '');
      setEnabled(existing.enabled);
      setDomains(existing.allowedDomains ?? '');
      setApiDomains(existing.allowedApiDomains ?? '');
      setAllowedPaths(existing.allowedPaths ?? '');
      setBlockedPaths(existing.blockedPaths ?? '');
      setRps(String(existing.maxRequestsPerSecond));
      setConcurrency(String(existing.maxConcurrentRequests));
      setDurationMinutes(String(existing.maxScanDurationMinutes));
      setActive(existing.allowActiveTesting);
      setDestructive(existing.allowDestructiveTesting);
      setProduction(existing.allowProduction);
      return;
    }

    setNote('');
    setEnabled(true);
    setDomains(suggestedHost);
    setApiDomains('');
    setAllowedPaths('');
    setBlockedPaths('');
    setRps('5');
    setConcurrency('2');
    setDurationMinutes('20');
    setActive(false);
    setDestructive(false);
    setProduction(false);
  }, [open, existing, suggestedHost]);

  const save = useMutation({
    mutationFn: (body: unknown) => apiRequest<SecurityScopeRecord>(
      `/api/v1/security/applications/${applicationId}/scope`,
      { method: 'PUT', body }
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['security-scope', applicationId] });
      onClose();
    }
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);

    const trimmedNote = note.trim();
    if (trimmedNote.length < MIN_NOTE_LENGTH) {
      setProblem(
        'The authorization needs to say who approved this, when, and for what. An empty or '
        + 'one-word note is refused by the scanner anyway, so it would only look authorized.'
      );
      return;
    }

    if (domains.trim().length === 0) {
      setProblem(
        'Name at least one host. An empty host list permits nothing rather than everything, '
        + 'so a scope saved without one cannot scan.'
      );
      return;
    }

    if (destructive && destructiveConfirm.trim().toUpperCase() !== CONFIRM_DESTRUCTIVE) {
      setProblem(`Type ${CONFIRM_DESTRUCTIVE} to confirm destructive testing, or turn it off.`);
      return;
    }

    if (production && productionConfirm.trim().toUpperCase() !== CONFIRM_PRODUCTION) {
      setProblem(`Type ${CONFIRM_PRODUCTION} to confirm testing production, or turn it off.`);
      return;
    }

    const numeric = (value: string, name: string) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be zero or more.`);
      return Math.floor(parsed);
    };

    let body: unknown;
    try {
      body = {
        enabled,
        authorizationNote: trimmedNote,
        allowedDomains: domains.trim(),
        allowedApiDomains: apiDomains.trim() || null,
        allowedPaths: allowedPaths.trim() || null,
        blockedPaths: blockedPaths.trim() || null,
        environmentId: null,
        maxRequestsPerSecond: numeric(rps, 'Requests per second'),
        maxConcurrentRequests: numeric(concurrency, 'Concurrent requests'),
        maxScanDurationMinutes: numeric(durationMinutes, 'Scan duration'),
        allowActiveTesting: active,
        // Destructive implies active: a DELETE is not an observation. Sending one without
        // the other would be refused by the guard, which is a confusing way to find out.
        allowDestructiveTesting: destructive && active,
        allowProduction: production
      };
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : 'One of the limits is not a number.');
      return;
    }

    save.mutate(body);
  };

  if (!open) return null;

  return (
    <Card
      {...panel.panelProps}
      className="mt-4"
      title={`${existing ? 'Edit the authorization' : 'Authorize security testing'} for ${applicationName}`}
      description="This record is what permits a scan. It is kept, and it names you as the person who wrote it."
    >
      <form onSubmit={submit} className="space-y-4" data-testid="scope-form">
        <div>
          <label className="label" htmlFor="scope-note">
            Authorization <span className="text-bad">required</span>
          </label>
          <textarea
            id="scope-note"
            name="authorizationNote"
            value={note}
            onChange={event => setNote(event.target.value)}
            rows={3}
            maxLength={2000}
            className="input"
            placeholder="Authorized by R. Patel, Head of Engineering, for staging only. Ticket SEC-114, 2026-10-09."
          />
          <p className="mt-1 text-xs text-ink-subtle">
            Who approved it, when, and what for. This is the first thing anyone will ask to see
            if a scan causes a problem.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="scope-domains">
              Hosts <span className="text-bad">required</span>
            </label>
            <input
              id="scope-domains" name="allowedDomains" className="input"
              value={domains} onChange={event => setDomains(event.target.value)}
              placeholder="staging.example.test"
            />
            <p className="mt-1 text-xs text-ink-subtle">
              Comma separated. An empty list permits nothing, not everything.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="scope-api-domains">API hosts</label>
            <input
              id="scope-api-domains" name="allowedApiDomains" className="input"
              value={apiDomains} onChange={event => setApiDomains(event.target.value)}
              placeholder="api.staging.example.test"
            />
            <p className="mt-1 text-xs text-ink-subtle">Only if they differ from the hosts above.</p>
          </div>
          <div>
            <label className="label" htmlFor="scope-allowed-paths">Allowed paths</label>
            <input
              id="scope-allowed-paths" name="allowedPaths" className="input"
              value={allowedPaths} onChange={event => setAllowedPaths(event.target.value)}
              placeholder="leave blank for all paths"
            />
          </div>
          <div>
            <label className="label" htmlFor="scope-blocked-paths">Blocked paths</label>
            <input
              id="scope-blocked-paths" name="blockedPaths" className="input"
              value={blockedPaths} onChange={event => setBlockedPaths(event.target.value)}
              placeholder="/admin/billing"
            />
            <p className="mt-1 text-xs text-ink-subtle">Wins over the allowed list.</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="scope-rps">Requests per second</label>
            <input id="scope-rps" name="maxRequestsPerSecond" className="input" inputMode="numeric"
                   value={rps} onChange={event => setRps(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="scope-concurrency">Concurrent requests</label>
            <input id="scope-concurrency" name="maxConcurrentRequests" className="input" inputMode="numeric"
                   value={concurrency} onChange={event => setConcurrency(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="scope-duration">Minutes per scan</label>
            <input id="scope-duration" name="maxScanDurationMinutes" className="input" inputMode="numeric"
                   value={durationMinutes} onChange={event => setDurationMinutes(event.target.value)} />
          </div>
        </div>
        <p className="text-xs text-ink-subtle">
          Each of these refuses every request when set to zero.
        </p>

        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            What may be sent
          </legend>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="enabled" className="mt-0.5"
                   checked={enabled} onChange={event => setEnabled(event.target.checked)} />
            <span>
              <span className="font-medium">Scope is enabled</span>
              <span className="block text-xs text-ink-muted">
                Turn this off to withdraw authorization without deleting the record.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="allowActiveTesting" className="mt-0.5"
                   checked={active}
                   onChange={event => {
                     setActive(event.target.checked);
                     if (!event.target.checked) { setDestructive(false); setDestructiveConfirm(''); }
                   }} />
            <span>
              <span className="font-medium">Active testing</span>
              <span className="block text-xs text-ink-muted">
                Off means observation only: the scanner reads what the application already
                serves. On means it sends probes.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="allowDestructiveTesting" className="mt-0.5"
                   disabled={!active}
                   checked={destructive}
                   onChange={event => {
                     setDestructive(event.target.checked);
                     if (!event.target.checked) setDestructiveConfirm('');
                   }} />
            <span>
              <span className="font-medium">Destructive testing</span>
              <span className="block text-xs text-ink-muted">
                {active
                  ? 'Permits requests nobody can assume are reversible, including DELETE.'
                  : 'Needs active testing on first: a DELETE is not an observation.'}
              </span>
            </span>
          </label>

          {destructive && (
            <div className="rounded-lg border border-bad/30 bg-bad-light p-3">
              <label className="label" htmlFor="scope-confirm-destructive">
                Type {CONFIRM_DESTRUCTIVE} to confirm
              </label>
              <input
                id="scope-confirm-destructive" className="input"
                value={destructiveConfirm}
                onChange={event => setDestructiveConfirm(event.target.value)}
                autoComplete="off"
                aria-describedby="scope-confirm-destructive-note"
              />
              <p id="scope-confirm-destructive-note" className="mt-1 text-xs text-bad">
                Data in this application may be changed or removed and not come back.
              </p>
            </div>
          )}

          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="allowProduction" className="mt-0.5"
                   checked={production}
                   onChange={event => {
                     setProduction(event.target.checked);
                     if (!event.target.checked) setProductionConfirm('');
                   }} />
            <span>
              <span className="font-medium">Production</span>
              <span className="block text-xs text-ink-muted">
                The environment also has to permit it, and state-changing tests are never run
                against production whatever this says.
              </span>
            </span>
          </label>

          {production && (
            <div className="rounded-lg border border-bad/30 bg-bad-light p-3">
              <label className="label" htmlFor="scope-confirm-production">
                Type {CONFIRM_PRODUCTION} to confirm
              </label>
              <input
                id="scope-confirm-production" className="input"
                value={productionConfirm}
                onChange={event => setProductionConfirm(event.target.value)}
                autoComplete="off"
              />
            </div>
          )}
        </fieldset>

        {problem && (
          <p className="text-sm text-bad" role="alert" data-testid="scope-problem">{problem}</p>
        )}

        {save.isError && (
          <p className="text-sm text-bad" role="alert" data-testid="scope-save-error">
            {save.error instanceof ApiError
              ? save.error.displayMessage
              : 'The authorization could not be saved.'}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button type="submit" className="btn-primary" disabled={save.isPending}
                  data-testid="scope-save">
            {save.isPending ? 'Saving…' : existing ? 'Save the authorization' : 'Authorize'}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

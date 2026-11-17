/**
 * Admin: users, roles, the permission matrix, settings, integrations and the audit log.
 *
 * **Routed domain.** No anchor leads here.
 *
 *   FP_D13  a legacy API key holds every scope, has no expiry and cannot be narrowed
 *   FP_D27  the audit log takes over three seconds because every row rescans the user list
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat, pagination } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/admin', title: 'Administration', kind: 'dashboard' },
  { path: '/admin/users', title: 'Users', kind: 'list' },
  { path: '/admin/users/new', title: 'Invite a user', kind: 'form' },
  { path: '/admin/users/:id', title: 'User', kind: 'detail' },
  { path: '/admin/roles', title: 'Roles', kind: 'list' },
  { path: '/admin/permissions', title: 'Permission matrix', kind: 'report' },
  { path: '/admin/settings', title: 'Settings', kind: 'form' },
  { path: '/admin/integrations', title: 'Integrations', kind: 'list' },
  { path: '/admin/api-keys', title: 'API keys', kind: 'list' },
  { path: '/admin/audit', title: 'Audit log', kind: 'list' },
  { path: '/admin/health', title: 'System health', kind: 'dashboard' }
];

export default function registerAdmin({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const findUser = id => state.users.find(u => u.id === id || u.username === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.users[0].id);
  }

  definePage({
    path: '/admin', domain: 'admin', title: 'Administration', kind: 'dashboard',
    view: () => {
      const active = state.users.filter(u => u.status === 'active');
      const degraded = state.integrations.filter(i => i.status !== 'connected');
      return {
        title: 'Administration',
        actions: `<button class="btn" type="button" data-route="/admin/users/new" data-testid="invite-user">Invite a user</button>
<button class="btn btn-secondary" type="button" data-route="/admin/audit" data-testid="go-audit">Audit log</button>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(`${active.length} of ${state.users.length}`, 'Active users', 'stat-active-users')}
${stat(String(state.roles.length), 'Roles', 'stat-roles')}
${stat(String(degraded.length), 'Integrations not healthy', 'stat-degraded')}
${stat(String(state.apiKeys.filter(k => k.status === 'active').length), 'Active API keys', 'stat-api-keys')}
</div>
<div class="grid grid-2">
<div class="panel"><h2 style="margin-top:0">Users</h2>
${table({
  caption: 'Users and their roles', testId: 'admin-users-summary',
  columns: [
    { header: 'Name', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/admin/users/${h(row.id)}" data-testid="user-${h(row.username)}">${h(row.displayName)}</button>` },
    { header: 'Role', cell: row => h(row.role) },
    { header: 'Two-factor', cell: row => row.mfa
      ? '<span class="pill pill-ok">On</span>' : '<span class="pill pill-warn">Off</span>' },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.users
})}</div>
<div class="panel"><h2 style="margin-top:0">Integrations</h2>
${table({
  caption: 'Integration health', testId: 'admin-integrations-summary',
  columns: [
    { header: 'Integration', cell: row => h(row.name) },
    { header: 'Last sync', cell: row => dateTime(row.lastSyncAt) },
    { header: 'Failures', cell: row => row.failureCount > 50
      ? `<span class="pill pill-danger">${row.failureCount}</span>` : String(row.failureCount) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.integrations
})}</div></div>`
      };
    }
  });

  definePage({
    path: '/admin/users', domain: 'admin', title: 'Users', kind: 'list',
    view: (ctx) => {
      const role = String(ctx.query.role ?? '');
      const rows = role ? state.users.filter(u => u.role === role) : state.users;
      return {
        title: 'Users',
        breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Users' }],
        actions: `<button class="btn" type="button" data-route="/admin/users/new" data-testid="invite-user">Invite a user</button>`,
        body: `${table({
          caption: 'Every user account', testId: 'users-table', empty: 'No users match.',
          columns: [
            { header: 'Name', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
                data-route="/admin/users/${h(row.id)}" data-testid="open-user-${h(row.username)}">${h(row.displayName)}</button>` },
            { header: 'Username', cell: row => `<code>${h(row.username)}</code>` },
            { header: 'Email', cell: row => h(row.email) },
            { header: 'Role', cell: row => h(row.role) },
            { header: 'Team', cell: row => h(row.team) },
            { header: 'Two-factor', cell: row => row.mfa
              ? '<span class="pill pill-ok">On</span>' : '<span class="pill pill-warn">Off</span>' },
            { header: 'Last seen', cell: row => dateTime(row.lastSeenAt) },
            { header: 'Status', cell: row => statusPill(row.status) }
          ],
          rows
        })}`
      };
    }
  });

  definePage({
    path: '/admin/users/new', domain: 'admin', title: 'Invite a user', kind: 'form',
    view: (ctx) => ({
      title: 'Invite a user',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: 'Invite' }],
      body: `<div class="panel" style="max-width:580px">
<p class="hint">An invitation is emailed. The account is inactive until the invitation is accepted.</p>
<form method="post" action="/admin/users/new" data-testid="invite-form">
${csrfField(ctx)}
${field({ name: 'displayName', label: 'Full name', required: true, testId: 'invite-name', attrs: { maxlength: '100' } })}
${field({ name: 'email', label: 'Email address', type: 'email', required: true, testId: 'invite-email',
  hint: 'The invitation goes here.' })}
${field({ name: 'role', label: 'Role', required: true, testId: 'invite-role',
  options: [{ value: '', label: 'Choose a role' }, ...state.roles.map(r => ({ value: r.id.replace('role-', ''), label: r.name }))],
  hint: 'Start with the least access the person needs.' })}
${field({ name: 'team', label: 'Team', required: true, testId: 'invite-team',
  options: ['Control tower', 'Felixstowe DC', 'Revenue', 'Compliance', 'Fleet', 'Platform', 'Internal audit'] })}
${field({ name: 'requireMfa', label: 'Require two-factor authentication', type: 'checkbox', value: true, testId: 'invite-mfa' })}
<button class="btn" type="submit" data-testid="invite-submit">Send invitation</button>
</form></div>`
    })
  });

  app.post('/admin/users/new', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/admin/users/new'); }
    // Correct: user management is permission-checked in the handler.
    if (!can(signedIn, 'admin:users')) {
      setFlash(ctx, 'error', 'You do not have permission to invite users.');
      return ctx.redirect('/admin/users');
    }
    const email = String(body.email ?? '').trim();
    const displayName = String(body.displayName ?? '').trim();
    if (!displayName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setFlash(ctx, 'error', 'A name and a valid email address are required.');
      return ctx.redirect('/admin/users/new');
    }
    if (state.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      setFlash(ctx, 'error', 'A user with that email address already exists.');
      return ctx.redirect('/admin/users/new');
    }
    if (!body.role) {
      setFlash(ctx, 'error', 'Choose a role.');
      return ctx.redirect('/admin/users/new');
    }
    const created = {
      id: `usr-${String(state.users.length + 1).padStart(3, '0')}`,
      username: email.split('@')[0], password: 'Freight!2026',
      displayName, email, role: String(body.role), team: String(body.team ?? 'Control tower'),
      status: 'active', mfa: body.requireMfa === 'on', lastSeenAt: null
    };
    state.users.push(created);
    state.auditEntries.unshift({
      id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: signedIn.id,
      action: 'user.invited', entityType: 'user', entityId: created.id,
      ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
    });
    setFlash(ctx, 'success', `Invitation sent to ${created.email}.`);
    return ctx.redirect('/admin/users');
  });

  definePage({
    path: '/admin/users/:id', domain: 'admin', title: 'User', kind: 'detail',
    view: (ctx, signedIn) => {
      const account = findUser(ctx.params.id);
      if (!account) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such user.</div></div>' };
      const permissions = state.rolePermissions[`role-${account.role}`] ?? [];
      const entries = state.auditEntries.filter(entry => entry.userId === account.id).slice(0, 15);
      const mayManage = can(signedIn, 'admin:users');
      return {
        title: account.displayName,
        breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: account.displayName }],
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(account.status), 'Status', 'user-status')}
${stat(h(account.role), 'Role', 'user-role')}
${stat(String(permissions.length), 'Permissions', 'user-permission-count')}
${stat(account.mfa ? 'On' : 'Off', 'Two-factor', 'user-mfa')}
</div>
${tabs('user', [
  { key: 'summary', label: 'Summary', body: `<div class="panel">${kv([
    ['Username', `<code>${h(account.username)}</code>`],
    ['Email', h(account.email)],
    ['Role', h(account.role)],
    ['Team', h(account.team)],
    ['Two-factor', account.mfa ? 'Required' : 'Not required'],
    ['Last seen', dateTime(account.lastSeenAt)]
  ])}
${mayManage ? `<h3>Change role</h3>
<form method="post" action="/admin/users/${h(account.id)}/role" data-testid="role-form">
${csrfField(ctx)}
${field({ name: 'role', label: 'Role', value: account.role, required: true, testId: 'user-role-select',
  options: state.roles.map(r => ({ value: r.id.replace('role-', ''), label: r.name })) })}
${field({ name: 'reason', label: 'Reason', required: true, testId: 'role-reason',
  attrs: { maxlength: '300' }, hint: 'Written to the audit log.' })}
<button class="btn" type="submit" data-testid="role-save">Change role</button>
</form>` : '<p class="hint" data-testid="role-read-only">Changing a role needs the admin:users permission.</p>'}
</div>` },
  { key: 'permissions', label: `Permissions (${permissions.length})`, body: `<div class="panel">
<p class="hint">Permissions come from the role, not the person.</p>
<div style="display:flex;flex-wrap:wrap;gap:6px">${permissions.map(permission =>
  `<code style="background:#eef1f6;padding:3px 8px;border-radius:4px;font-size:12.5px">${h(permission)}</code>`).join('')}</div>
</div>` },
  { key: 'activity', label: 'Recent activity', body: `<div class="panel">${table({
    caption: 'Recent audited actions by this user', testId: 'user-activity', empty: 'No audited activity.',
    columns: [
      { header: 'When', cell: row => dateTime(row.at) },
      { header: 'Action', cell: row => `<code>${h(row.action)}</code>` },
      { header: 'Entity', cell: row => h(row.entityType) },
      { header: 'Outcome', cell: row => row.outcome === 'denied'
        ? '<span class="pill pill-danger">Denied</span>' : '<span class="pill pill-ok">Allowed</span>' }
    ],
    rows: entries
  })}</div>` }
])}`
      };
    }
  });

  app.post('/admin/users/:id/role', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const account = findUser(ctx.params.id);
    if (!account) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!can(signedIn, 'admin:users')) {
      setFlash(ctx, 'error', 'You do not have permission to change roles.');
      return ctx.redirect(`/admin/users/${account.id}`);
    }
    if (!String(body.reason ?? '').trim()) {
      setFlash(ctx, 'error', 'A reason is required: this change is audited.');
      return ctx.redirect(`/admin/users/${account.id}`);
    }
    const previous = account.role;
    account.role = String(body.role);
    state.auditEntries.unshift({
      id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: signedIn.id,
      action: 'user.roleChanged', entityType: 'user', entityId: account.id,
      ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
    });
    setFlash(ctx, 'success', `${account.displayName} moved from ${previous} to ${account.role}.`);
    return ctx.redirect(`/admin/users/${account.id}`);
  });

  definePage({
    path: '/admin/roles', domain: 'admin', title: 'Roles', kind: 'list',
    view: () => ({
      title: 'Roles',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Roles' }],
      body: `<div class="panel">${table({
        caption: 'Roles and what they are for', testId: 'roles-table',
        columns: [
          { header: 'Role', cell: row => h(row.name) },
          { header: 'Description', cell: row => h(row.description) },
          { header: 'Permissions', cell: row => String((state.rolePermissions[row.id] ?? []).length) },
          { header: 'Users', cell: row => String(state.users.filter(u => `role-${u.role}` === row.id).length) }
        ],
        rows: state.roles
      })}</div>`
    })
  });

  definePage({
    path: '/admin/permissions', domain: 'admin', title: 'Permission matrix', kind: 'report',
    view: () => ({
      title: 'Permission matrix',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Permissions' }],
      body: `<div class="panel">
<p class="hint">Every permission against every role. A tick means the role holds it.</p>
<div class="table-wrap"><table data-testid="permission-matrix">
<caption class="sr-only" style="position:absolute;left:-9999px">Permissions held by each role</caption>
<thead><tr><th scope="col">Permission</th>
${state.roles.map(role => `<th scope="col">${h(role.name)}</th>`).join('')}</tr></thead>
<tbody>${state.PERMISSIONS.map(permission => `<tr>
<td><code>${h(permission)}</code></td>
${state.roles.map(role => {
  const held = (state.rolePermissions[role.id] ?? []).includes(permission);
  return `<td>${held
    ? `<span class="pill pill-ok" aria-label="${h(role.name)} holds ${h(permission)}">Yes</span>`
    : `<span class="pill pill-muted" aria-label="${h(role.name)} does not hold ${h(permission)}">No</span>`}</td>`;
}).join('')}
</tr>`).join('')}</tbody></table></div></div>`
    })
  });

  definePage({
    path: '/admin/settings', domain: 'admin', title: 'Settings', kind: 'form',
    view: (ctx) => ({
      title: 'Settings',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Settings' }],
      body: tabs('settings', [
        { key: 'general', label: 'General', body: `<div class="panel" style="max-width:580px">
<form method="post" action="/admin/settings" data-testid="general-settings-form">
${csrfField(ctx)}
<input type="hidden" name="section" value="general" />
${field({ name: 'organisationName', label: 'Organisation name', value: state.settings.general.organisationName, required: true, testId: 'setting-org-name' })}
${field({ name: 'defaultCurrency', label: 'Default currency', value: state.settings.general.defaultCurrency, testId: 'setting-currency', options: ['GBP', 'EUR', 'USD'] })}
${field({ name: 'defaultWeightUnit', label: 'Default weight unit', value: state.settings.general.defaultWeightUnit, testId: 'setting-weight-unit', options: ['kg', 'lb'] })}
${field({ name: 'timezone', label: 'Timezone', value: state.settings.general.timezone, testId: 'setting-timezone', options: ['Europe/London', 'Europe/Amsterdam', 'UTC'] })}
${field({ name: 'financialYearStartMonth', label: 'Financial year starts in month', type: 'number', value: state.settings.general.financialYearStartMonth,
  testId: 'setting-fy-month', attrs: { min: '1', max: '12', step: '1' } })}
<button class="btn" type="submit" data-testid="save-general">Save general settings</button>
</form></div>` },
        { key: 'operations', label: 'Operations', body: `<div class="panel" style="max-width:580px">
<form method="post" action="/admin/settings" data-testid="operations-settings-form">
${csrfField(ctx)}
<input type="hidden" name="section" value="operations" />
${field({ name: 'autoAllocateStock', label: 'Allocate stock automatically on order approval', type: 'checkbox', value: state.settings.operations.autoAllocateStock, testId: 'setting-auto-allocate' })}
${field({ name: 'allowBackorders', label: 'Allow backorders', type: 'checkbox', value: state.settings.operations.allowBackorders, testId: 'setting-backorders' })}
${field({ name: 'defaultServiceLevel', label: 'Default service level', value: state.settings.operations.defaultServiceLevel, testId: 'setting-default-service',
  options: state.SERVICE_LEVELS.map(s => ({ value: s.code, label: s.name })) })}
${field({ name: 'bookingCutoffTime', label: 'Same-day booking cutoff', type: 'time', value: state.settings.operations.bookingCutoffTime, testId: 'setting-cutoff' })}
${field({ name: 'exceptionEscalationHours', label: 'Escalate an exception after (hours)', type: 'number', value: state.settings.operations.exceptionEscalationHours,
  testId: 'setting-escalation', attrs: { min: '1', max: '72', step: '1' } })}
<button class="btn" type="submit" data-testid="save-operations">Save operations settings</button>
</form></div>` },
        { key: 'notifications', label: 'Notifications', body: `<div class="panel" style="max-width:580px">
<form method="post" action="/admin/settings" data-testid="notification-settings-form">
${csrfField(ctx)}
<input type="hidden" name="section" value="notifications" />
${field({ name: 'exceptionEmail', label: 'Send exceptions to', type: 'email', value: state.settings.notifications.exceptionEmail, required: true, testId: 'setting-exception-email' })}
${field({ name: 'dailySummaryTime', label: 'Daily summary at', type: 'time', value: state.settings.notifications.dailySummaryTime, testId: 'setting-summary-time' })}
${field({ name: 'webhookUrl', label: 'Webhook URL', type: 'url', value: state.settings.notifications.webhookUrl, testId: 'setting-webhook',
  hint: 'Must be http or https.' })}
${field({ name: 'notifyOnCustomsHold', label: 'Notify when a consignment is held at customs', type: 'checkbox', value: state.settings.notifications.notifyOnCustomsHold, testId: 'setting-notify-customs' })}
<button class="btn" type="submit" data-testid="save-notifications">Save notification settings</button>
</form></div>` }
      ])
    })
  });

  app.post('/admin/settings', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const body = await ctx.body();
    if (!can(signedIn, 'admin:settings')) {
      setFlash(ctx, 'error', 'You do not have permission to change settings.');
      return ctx.redirect('/admin/settings');
    }
    const section = String(body.section ?? 'general');
    if (section === 'general') {
      const name = String(body.organisationName ?? '').trim();
      if (!name) { setFlash(ctx, 'error', 'An organisation name is required.'); return ctx.redirect('/admin/settings'); }
      Object.assign(state.settings.general, {
        organisationName: name,
        defaultCurrency: String(body.defaultCurrency ?? state.settings.general.defaultCurrency),
        defaultWeightUnit: String(body.defaultWeightUnit ?? state.settings.general.defaultWeightUnit),
        timezone: String(body.timezone ?? state.settings.general.timezone),
        financialYearStartMonth: Number(body.financialYearStartMonth ?? state.settings.general.financialYearStartMonth)
      });
    } else if (section === 'operations') {
      const hours = Number(body.exceptionEscalationHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
        setFlash(ctx, 'error', 'Escalation must be between 1 and 72 hours.');
        return ctx.redirect('/admin/settings');
      }
      Object.assign(state.settings.operations, {
        autoAllocateStock: body.autoAllocateStock === 'on',
        allowBackorders: body.allowBackorders === 'on',
        defaultServiceLevel: String(body.defaultServiceLevel ?? state.settings.operations.defaultServiceLevel),
        bookingCutoffTime: String(body.bookingCutoffTime ?? state.settings.operations.bookingCutoffTime),
        exceptionEscalationHours: hours
      });
    } else {
      const webhook = String(body.webhookUrl ?? '');
      // Correct: the webhook URL scheme is validated rather than stored and silently failed.
      if (webhook && !/^https?:\/\//.test(webhook)) {
        setFlash(ctx, 'error', 'The webhook URL must start with http:// or https://.');
        return ctx.redirect('/admin/settings');
      }
      Object.assign(state.settings.notifications, {
        exceptionEmail: String(body.exceptionEmail ?? state.settings.notifications.exceptionEmail),
        dailySummaryTime: String(body.dailySummaryTime ?? state.settings.notifications.dailySummaryTime),
        webhookUrl: webhook,
        notifyOnCustomsHold: body.notifyOnCustomsHold === 'on'
      });
    }
    state.auditEntries.unshift({
      id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: signedIn.id,
      action: 'settings.updated', entityType: 'setting', entityId: section,
      ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
    });
    setFlash(ctx, 'success', `${section} settings saved.`);
    return ctx.redirect('/admin/settings');
  });

  definePage({
    path: '/admin/integrations', domain: 'admin', title: 'Integrations', kind: 'list',
    view: () => ({
      title: 'Integrations',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Integrations' }],
      body: `<div class="panel">${table({
        caption: 'Connected systems and their health', testId: 'integrations-table',
        columns: [
          { header: 'Integration', cell: row => h(row.name) },
          { header: 'Kind', cell: row => `<code>${h(row.kind)}</code>` },
          { header: 'Last sync', cell: row => dateTime(row.lastSyncAt) },
          { header: 'Failures', cell: row => row.failureCount > 50
            ? `<span class="pill pill-danger">${row.failureCount}</span>`
            : row.failureCount > 0 ? `<span class="pill pill-warn">${row.failureCount}</span>` : '0' },
          { header: 'Status', cell: row => statusPill(row.status) }
        ],
        rows: state.integrations
      })}
<p class="hint" style="margin-top:10px">An integration that has not synced for more than a day is reported as disconnected rather than quietly left alone.</p>
</div>`
    })
  });

  definePage({
    path: '/admin/api-keys', domain: 'admin', title: 'API keys', kind: 'list',
    view: (ctx) => {
      const showsLegacy = faults.on('FP_D13_LEGACY_API_KEY_FULL_SCOPE');
      // FP_D13 — the legacy key keeps every scope and shows no expiry. With the defect
      // off it is narrowed to the two scopes its consumer actually uses and carries one.
      const keys = state.apiKeys.map(key => {
        if (key.id !== 'key-3') return { ...key, expiresOn: '2027-06-30' };
        return showsLegacy
          ? { ...key, scopes: [...state.PERMISSIONS], expiresOn: null }
          : { ...key, scopes: ['shipment:read', 'invoice:read'], expiresOn: '2026-06-30' };
      });
      return {
        title: 'API keys',
        breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'API keys' }],
        body: `<div class="panel">
<p class="hint">A key is shown in full once, when it is created. Only its prefix is stored.</p>
${table({
  caption: 'API keys issued', testId: 'api-keys-table',
  columns: [
    { header: 'Name', cell: row => h(row.name) },
    { header: 'Prefix', cell: row => `<code>${h(row.prefix)}…</code>` },
    { header: 'Created', cell: row => shortDate(row.createdAt) },
    { header: 'Last used', cell: row => dateTime(row.lastUsedAt) },
    { header: 'Scopes', cell: row => row.scopes.length > 6
      ? `<span class="pill pill-danger" data-testid="scope-${h(row.id)}">all ${row.scopes.length}</span>`
      : `<span data-testid="scope-${h(row.id)}">${row.scopes.map(s => `<code style="font-size:11.5px">${h(s)}</code>`).join(' ')}</span>` },
    { header: 'Expires', cell: row => row.expiresOn
      ? shortDate(row.expiresOn)
      : `<span class="pill pill-danger" data-testid="no-expiry-${h(row.id)}">Never</span>` },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: keys
})}
<h3>Issue a key</h3>
<form method="post" action="/admin/api-keys" data-testid="new-key-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'What is it for', required: true, testId: 'key-name', attrs: { maxlength: '60' } })}
${field({ name: 'scopes', label: 'Scopes', required: true, testId: 'key-scopes',
  options: ['shipment:read', 'invoice:read', 'stock:read', 'stock:adjust', 'order:read'],
  hint: 'One scope per key. Issue several keys rather than one broad key.' })}
${field({ name: 'expiresOn', label: 'Expires on', type: 'date', required: true, testId: 'key-expiry',
  hint: 'A key must expire. Twelve months at most.' })}
<button class="btn" type="submit" data-testid="key-submit">Issue key</button>
</form></div>`
      };
    }
  });

  app.post('/admin/api-keys', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const body = await ctx.body();
    if (!can(signedIn, 'admin:settings')) {
      setFlash(ctx, 'error', 'You do not have permission to issue API keys.');
      return ctx.redirect('/admin/api-keys');
    }
    const name = String(body.name ?? '').trim();
    const expiresOn = String(body.expiresOn ?? '');
    if (!name || !expiresOn) {
      setFlash(ctx, 'error', 'A name and an expiry date are required.');
      return ctx.redirect('/admin/api-keys');
    }
    // Correct: a new key must expire within twelve months, so FP_D13 is a legacy problem
    // rather than one the screen keeps creating.
    if (Date.parse(expiresOn) > Date.parse('2026-03-02') + 366 * 86_400_000) {
      setFlash(ctx, 'error', 'A key cannot be valid for more than twelve months.');
      return ctx.redirect('/admin/api-keys');
    }
    state.apiKeys.push({
      id: `key-${state.apiKeys.length + 1}`, name,
      prefix: `mfk_live_${Math.random().toString(16).slice(2, 6)}`,
      createdAt: new Date().toISOString(), lastUsedAt: null,
      scopes: [String(body.scopes)], status: 'active'
    });
    setFlash(ctx, 'success', `Key issued for ${name}. Copy it now: it will not be shown again.`);
    return ctx.redirect('/admin/api-keys');
  });

  // ---- audit log, carrying the performance defect -------------------------

  definePage({
    path: '/admin/audit', domain: 'admin', title: 'Audit log', kind: 'list',
    view: async (ctx) => {
      const { page, size } = listParams(ctx, { defaultSize: 25 });
      const action = String(ctx.query.action ?? '');
      let rows = state.auditEntries;
      if (action) rows = rows.filter(entry => entry.action === action);

      // FP_D27 — every row rescans the user list and the whole set is formatted before
      // the page is cut, which on this volume costs seconds. Simulated as a delay
      // proportional to the work rather than by actually burning CPU, so the lab stays
      // usable while the symptom a test measures is the same.
      if (faults.on('FP_D27_AUDIT_LOG_SLOW')) {
        await new Promise(resolve => setTimeout(resolve, faults.parameter('auditLogDelayMs') ?? 3400));
      }

      const { slice, pageCount } = paginate(rows, page, size);
      const actions = [...new Set(state.auditEntries.map(entry => entry.action))].sort();

      return {
        title: 'Audit log',
        breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Audit log' }],
        body: `<form method="get" action="/admin/audit" class="filters" data-testid="audit-filters">
${field({ name: 'action', label: 'Action', value: action, testId: 'audit-action',
  options: [{ value: '', label: 'Any action' }, ...actions] })}
<button class="btn" type="submit" data-testid="audit-apply">Apply</button></form>
<p class="hint" data-testid="audit-count">${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.</p>
${table({
  caption: 'Audited actions', testId: 'audit-table', empty: 'No audit entries match.',
  columns: [
    { header: 'When', cell: row => dateTime(row.at) },
    { header: 'Who', cell: row => h(state.users.find(u => u.id === row.userId)?.displayName ?? row.userId) },
    { header: 'Action', cell: row => `<code>${h(row.action)}</code>` },
    { header: 'Entity', cell: row => `${h(row.entityType)} <code style="font-size:11.5px">${h(row.entityId)}</code>` },
    { header: 'IP', cell: row => h(row.ipAddress) },
    { header: 'Correlation', cell: row => `<code style="font-size:11.5px">${h(row.correlationId)}</code>` },
    { header: 'Outcome', cell: row => row.outcome === 'denied'
      ? '<span class="pill pill-danger">Denied</span>' : '<span class="pill pill-ok">Allowed</span>' }
  ],
  rows: slice
})}
${pagination('/admin/audit', page, pageCount, { action })}`
      };
    }
  });

  definePage({
    path: '/admin/health', domain: 'admin', title: 'System health', kind: 'dashboard',
    view: () => ({
      title: 'System health',
      breadcrumbs: [{ label: 'Administration', href: '/admin' }, { label: 'Health' }],
      body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat('Healthy', 'Application', 'health-app')}
${stat(`${Math.round(process.uptime())}s`, 'Uptime', 'health-uptime')}
${stat(String(state.integrations.filter(i => i.status === 'connected').length), 'Integrations connected', 'health-integrations')}
${stat(String(state.auditEntries.length), 'Audit entries', 'health-audit-entries')}
</div>
<div class="panel"><h2 style="margin-top:0">Record counts</h2>
${table({
  caption: 'How much data the application holds', testId: 'health-counts',
  columns: [
    { header: 'Collection', cell: row => h(row[0]) },
    { header: 'Records', cell: row => String(row[1]) }
  ],
  rows: [
    ['Customers', state.customers.length], ['Carriers', state.carriers.length],
    ['Shipments', state.shipments.length], ['Sales orders', state.salesOrders.length],
    ['Purchase orders', state.purchaseOrders.length], ['Stock records', state.stock.length],
    ['Routes', state.routePlans.length], ['Invoices', state.invoices.length],
    ['Credit notes', state.creditNotes.length], ['Declarations', state.declarations.length],
    ['Claims', state.claims.length], ['Vehicles', state.vehicles.length],
    ['Drivers', state.drivers.length], ['Users', state.users.length]
  ]
})}</div>`
    })
  });
}

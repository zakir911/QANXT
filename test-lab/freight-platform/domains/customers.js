/**
 * Customers: accounts, contacts, addresses, credit and service agreements.
 *
 *   FP_D32  the contact search submits by GET, so email addresses land in logs and history
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat, pagination } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/customers', title: 'Customers', kind: 'list' },
  { path: '/customers/new', title: 'Add a customer', kind: 'form' },
  { path: '/customers/:id', title: 'Customer', kind: 'detail' },
  { path: '/customers/:id/edit', title: 'Edit customer', kind: 'form' },
  { path: '/customers/:id/contacts', title: 'Customer contacts', kind: 'list' },
  { path: '/customers/:id/addresses', title: 'Customer addresses', kind: 'list' },
  { path: '/customers/:id/credit', title: 'Credit and terms', kind: 'form' },
  { path: '/customers/:id/pricing', title: 'Agreed pricing', kind: 'list' },
  { path: '/customers/:id/sla', title: 'Service agreement', kind: 'detail' },
  { path: '/customers/:id/statements', title: 'Statements', kind: 'list' }
];

export default function registerCustomers({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const find = id => state.customers.find(c => c.id === id || c.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.customers[0].id);
  }

  definePage({
    path: '/customers', domain: 'customers', title: 'Customers', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const tier = String(ctx.query.tier ?? '');
      const contactEmail = String(ctx.query.contactEmail ?? '');

      let rows = state.customers;
      if (tier) rows = rows.filter(c => c.tier === tier);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(c => c.name.toLowerCase().includes(needle) || c.reference.toLowerCase().includes(needle));
      }
      if (contactEmail) {
        const needle = contactEmail.toLowerCase();
        rows = rows.filter(c => c.contacts.some(contact => contact.email.toLowerCase().includes(needle)));
      }

      // FP_D32 — the contact search is a GET form, so an email address typed here is in
      // the URL, the access log, any proxy log and the browser history of a shared
      // operations terminal. With the defect off it posts and redirects without the term.
      const contactSearchMethod = faults.on('FP_D32_PII_IN_QUERY_STRING') ? 'get' : 'post';

      return {
        title: 'Customers',
        actions: `<a class="btn" href="/customers/new" data-testid="new-customer">Add a customer</a>`,
        body: `<form method="get" action="/customers" class="filters" data-testid="customer-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'customer-search', hint: 'Name or account reference.' })}
${field({ name: 'tier', label: 'Tier', value: tier, testId: 'filter-tier',
  options: [{ value: '', label: 'Any tier' }, 'bronze', 'silver', 'gold', 'platinum'] })}
<button class="btn" type="submit" data-testid="customer-apply">Apply</button>
</form>

<form method="${contactSearchMethod}" action="/customers${contactSearchMethod === 'post' ? '/contact-search' : ''}" class="filters" data-testid="contact-search-form">
${field({ name: 'contactEmail', label: 'Find by contact email', type: 'email', value: contactEmail, testId: 'contact-email-search',
  hint: 'Searches every contact on every account.' })}
<button class="btn btn-secondary" type="submit" data-testid="contact-search-submit">Find</button>
</form>

${table({
  caption: 'Customer accounts', testId: 'customers-table', empty: 'No customers match.',
  columns: [
    { header: 'Account', cell: row => `<a href="/customers/${h(row.id)}" data-testid="customer-${h(row.reference)}">${h(row.name)}</a>` },
    { header: 'Reference', cell: row => `<code>${h(row.reference)}</code>` },
    { header: 'Tier', cell: row => `<span class="pill pill-info">${h(row.tier)}</span>` },
    { header: 'Country', cell: row => h(row.address.countryCode) },
    { header: 'Credit limit', cell: row => money(row.creditLimit) },
    { header: 'Used', cell: row => {
        const pct = Math.round((row.creditUsed / row.creditLimit) * 100);
        return `${money(row.creditUsed)} <span class="pill pill-${pct > 90 ? 'danger' : pct > 75 ? 'warn' : 'ok'}">${pct}%</span>`;
      } },
    { header: 'Terms', cell: row => `${row.paymentTermsDays} days` },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: paginate(rows, page, size).slice
})}
${pagination('/customers', page, paginate(rows, page, size).pageCount, { q, tier })}`
      };
    }
  });

  app.post('/customers/contact-search', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const needle = String(body.contactEmail ?? '').toLowerCase();
    const match = state.customers.find(c => c.contacts.some(contact => contact.email.toLowerCase().includes(needle)));
    // The term is not reflected into the redirect, which is the point of the POST.
    if (!match) {
      setFlash(ctx, 'info', 'No account has a contact with that address.');
      return ctx.redirect('/customers');
    }
    return ctx.redirect(`/customers/${match.id}/contacts`);
  });

  definePage({
    path: '/customers/new', domain: 'customers', title: 'Add a customer', kind: 'form',
    view: (ctx) => ({
      title: 'Add a customer',
      breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: 'Add' }],
      body: `<div class="panel" style="max-width:640px">
<form method="post" action="/customers/new" data-testid="new-customer-form">
${csrfField(ctx)}
<h3 style="margin-top:0">Account</h3>
${field({ name: 'name', label: 'Trading name', required: true, testId: 'customer-name', attrs: { maxlength: '140' } })}
${field({ name: 'vatNumber', label: 'VAT number', testId: 'customer-vat', attrs: { maxlength: '14', pattern: '[A-Z]{2}[0-9]{8,12}' },
  hint: 'Two country letters then eight to twelve digits.' })}
${field({ name: 'tier', label: 'Tier', testId: 'customer-tier', options: ['bronze', 'silver', 'gold', 'platinum'] })}
<h3>Credit</h3>
${field({ name: 'creditLimit', label: 'Credit limit (GBP)', type: 'number', required: true, testId: 'customer-credit-limit',
  attrs: { min: '0', max: '10000000', step: '100' } })}
${field({ name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', required: true, value: 30, testId: 'customer-terms',
  attrs: { min: '0', max: '120', step: '1' } })}
<h3>Address</h3>
${field({ name: 'line1', label: 'Address line 1', required: true, testId: 'customer-line1', attrs: { maxlength: '120' } })}
${field({ name: 'city', label: 'Town or city', required: true, testId: 'customer-city', attrs: { maxlength: '80' } })}
${field({ name: 'postcode', label: 'Postcode', required: true, testId: 'customer-postcode', attrs: { maxlength: '12' } })}
${field({ name: 'countryCode', label: 'Country', required: true, testId: 'customer-country',
  options: state.COUNTRIES.map(c => ({ value: c.code, label: c.name })) })}
<h3>Primary contact</h3>
${field({ name: 'contactName', label: 'Contact name', required: true, testId: 'contact-name', attrs: { maxlength: '100' } })}
${field({ name: 'contactEmail', label: 'Contact email', type: 'email', required: true, testId: 'contact-email' })}
${field({ name: 'contactPhone', label: 'Contact telephone', type: 'tel', testId: 'contact-phone' })}
<button class="btn" type="submit" data-testid="customer-submit">Add customer</button>
</form></div>`
    })
  });

  app.post('/customers/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/customers/new'); }
    const name = String(body.name ?? '').trim();
    const creditLimit = Number(body.creditLimit);
    if (!name) {
      setFlash(ctx, 'error', 'A trading name is required.');
      return ctx.redirect('/customers/new');
    }
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      setFlash(ctx, 'error', 'Enter a credit limit of zero or more.');
      return ctx.redirect('/customers/new');
    }
    const index = state.customers.length;
    const country = state.COUNTRIES.find(c => c.code === body.countryCode) ?? state.COUNTRIES[0];
    const address = {
      line1: String(body.line1 ?? ''), line2: '', city: String(body.city ?? ''),
      postcode: String(body.postcode ?? ''), countryCode: country.code, country: country.name
    };
    const created = {
      id: `cus-${String(index + 1).padStart(3, '0')}`,
      reference: `MC${String(4100 + index * 7)}`,
      name, status: 'active', tier: String(body.tier ?? 'bronze'),
      vatNumber: String(body.vatNumber ?? ''), address,
      creditLimit, creditUsed: 0, paymentTermsDays: Number(body.paymentTermsDays ?? 30),
      accountManagerId: state.users[0].id, slaOnTimePct: 95,
      createdAt: new Date().toISOString(),
      contacts: [{
        id: `con-${index + 1}-a`, name: String(body.contactName ?? ''), role: 'Primary contact',
        email: String(body.contactEmail ?? ''), phone: String(body.contactPhone ?? ''), primary: true
      }],
      addresses: [{ id: `adr-${index + 1}-1`, label: 'Head office', ...address, isDefault: true }]
    };
    state.customers.push(created);
    setFlash(ctx, 'success', `${created.name} added as ${created.reference}.`);
    return ctx.redirect(`/customers/${created.id}`);
  });

  definePage({
    path: '/customers/:id', domain: 'customers', title: 'Customer', kind: 'detail',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such customer.</div></div>' };
      const shipments = state.shipments.filter(s => s.customerId === customer.id);
      const orders = state.salesOrders.filter(o => o.customerId === customer.id);
      const invoices = state.invoices.filter(i => i.customerId === customer.id);
      const creditPct = Math.round((customer.creditUsed / customer.creditLimit) * 100);
      return {
        title: customer.name,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name }],
        actions: `<a class="btn btn-secondary" href="/customers/${h(customer.id)}/edit" data-testid="edit-customer">Edit</a>
<a class="btn btn-secondary" href="/customers/${h(customer.id)}/credit" data-testid="view-credit">Credit</a>
<a class="btn" href="/orders/sales/new?customer=${h(customer.id)}" data-testid="new-order-for-customer">New order</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(customer.status), 'Status', 'customer-status')}
${stat(`${creditPct}%`, `Credit used of ${money(customer.creditLimit)}`, 'customer-credit')}
${stat(String(shipments.length), 'Shipments', 'customer-shipments')}
${stat(`${customer.slaOnTimePct}%`, 'Agreed on-time target', 'customer-sla')}
</div>
${tabs('customer', [
  { key: 'summary', label: 'Summary', body: `<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Account</h3>${kv([
  ['Reference', `<code>${h(customer.reference)}</code>`],
  ['Tier', h(customer.tier)],
  ['VAT number', `<code>${h(customer.vatNumber)}</code>`],
  ['Payment terms', `${customer.paymentTermsDays} days`],
  ['Account manager', h(state.users.find(u => u.id === customer.accountManagerId)?.displayName ?? '—')],
  ['Customer since', shortDate(customer.createdAt)]
])}</div>
<div class="panel"><h3 style="margin-top:0">Registered address</h3>
<p>${[customer.address.line1, customer.address.line2, customer.address.city, customer.address.postcode, customer.address.country]
  .filter(Boolean).map(h).join('<br />')}</p></div>
</div>` },
  { key: 'contacts', label: `Contacts (${customer.contacts.length})`, body: `<div class="panel">${table({
    caption: 'Contacts on this account', testId: 'customer-contacts',
    columns: [
      { header: 'Name', cell: row => h(row.name) },
      { header: 'Role', cell: row => h(row.role) },
      { header: 'Email', cell: row => h(row.email) },
      { header: 'Telephone', cell: row => h(row.phone) },
      { header: 'Primary', cell: row => row.primary ? '<span class="pill pill-ok">Primary</span>' : '' }
    ],
    rows: customer.contacts
  })}</div>` },
  { key: 'shipments', label: `Shipments (${shipments.length})`, body: `<div class="panel">${table({
    caption: 'Shipments for this customer', testId: 'customer-shipments-table', empty: 'No shipments yet.',
    columns: [
      { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
      { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.countryCode}`) },
      { header: 'Due', cell: row => shortDate(row.estimatedDeliveryOn) },
      { header: 'Status', cell: row => statusPill(row.status) }
    ],
    rows: shipments.slice(0, 15)
  })}</div>` },
  { key: 'orders', label: `Orders (${orders.length})`, body: `<div class="panel">${table({
    caption: 'Sales orders for this customer', testId: 'customer-orders', empty: 'No orders yet.',
    columns: [
      { header: 'Reference', cell: row => `<a href="/orders/sales/${h(row.id)}">${h(row.reference)}</a>` },
      { header: 'Placed', cell: row => shortDate(row.placedAt) },
      { header: 'Total', cell: row => money(row.totalGbp) },
      { header: 'Status', cell: row => statusPill(row.status) }
    ],
    rows: orders
  })}</div>` },
  { key: 'invoices', label: `Invoices (${invoices.length})`, body: `<div class="panel">${table({
    caption: 'Invoices for this customer', testId: 'customer-invoices', empty: 'No invoices yet.',
    columns: [
      { header: 'Reference', cell: row => `<a href="/billing/invoices/${h(row.id)}">${h(row.reference)}</a>` },
      { header: 'Issued', cell: row => shortDate(row.issuedOn) },
      { header: 'Due', cell: row => shortDate(row.dueOn) },
      { header: 'Total', cell: row => money(row.totalGbp) },
      { header: 'Status', cell: row => statusPill(row.status) }
    ],
    rows: invoices
  })}</div>` }
])}`
      };
    }
  });

  definePage({
    path: '/customers/:id/edit', domain: 'customers', title: 'Edit customer', kind: 'form',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Edit ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Edit' }],
        body: `<div class="panel" style="max-width:600px">
<form method="post" action="/customers/${h(customer.id)}/edit" data-testid="edit-customer-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'Trading name', value: customer.name, required: true, testId: 'edit-name', attrs: { maxlength: '140' } })}
${field({ name: 'tier', label: 'Tier', value: customer.tier, testId: 'edit-tier', options: ['bronze', 'silver', 'gold', 'platinum'] })}
${field({ name: 'status', label: 'Status', value: customer.status, testId: 'edit-status', options: ['active', 'onHold', 'prospect'] })}
${field({ name: 'vatNumber', label: 'VAT number', value: customer.vatNumber, testId: 'edit-vat', attrs: { maxlength: '14' } })}
${field({ name: 'line1', label: 'Address line 1', value: customer.address.line1, required: true, testId: 'edit-line1' })}
${field({ name: 'city', label: 'Town or city', value: customer.address.city, required: true, testId: 'edit-city' })}
${field({ name: 'postcode', label: 'Postcode', value: customer.address.postcode, required: true, testId: 'edit-postcode' })}
<button class="btn" type="submit" data-testid="edit-customer-save">Save changes</button>
</form></div>`
      };
    }
  });

  app.post('/customers/:id/edit', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const customer = find(ctx.params.id);
    if (!customer) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    const name = String(body.name ?? '').trim();
    if (!name) { setFlash(ctx, 'error', 'A trading name is required.'); return ctx.redirect(`/customers/${customer.id}/edit`); }
    customer.name = name;
    customer.tier = String(body.tier ?? customer.tier);
    customer.status = String(body.status ?? customer.status);
    customer.vatNumber = String(body.vatNumber ?? customer.vatNumber);
    customer.address.line1 = String(body.line1 ?? customer.address.line1);
    customer.address.city = String(body.city ?? customer.address.city);
    customer.address.postcode = String(body.postcode ?? customer.address.postcode);
    setFlash(ctx, 'success', 'Customer updated.');
    return ctx.redirect(`/customers/${customer.id}`);
  });

  definePage({
    path: '/customers/:id/contacts', domain: 'customers', title: 'Customer contacts', kind: 'list',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Contacts — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Contacts' }],
        body: `<div class="panel">
${table({
  caption: 'Contacts on this account', testId: 'contacts-table',
  columns: [
    { header: 'Name', cell: row => h(row.name) },
    { header: 'Role', cell: row => h(row.role) },
    { header: 'Email', cell: row => h(row.email) },
    { header: 'Telephone', cell: row => h(row.phone) },
    { header: 'Primary', cell: row => row.primary ? '<span class="pill pill-ok">Primary</span>' : '' }
  ],
  rows: customer.contacts
})}
<h3>Add a contact</h3>
<form method="post" action="/customers/${h(customer.id)}/contacts" data-testid="add-contact-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'Name', required: true, testId: 'new-contact-name', attrs: { maxlength: '100' } })}
${field({ name: 'role', label: 'Role', required: true, testId: 'new-contact-role',
  options: ['Logistics manager', 'Accounts payable', 'Goods in', 'Commercial', 'Other'] })}
${field({ name: 'email', label: 'Email', type: 'email', required: true, testId: 'new-contact-email' })}
${field({ name: 'phone', label: 'Telephone', type: 'tel', testId: 'new-contact-phone' })}
<button class="btn" type="submit" data-testid="add-contact">Add contact</button>
</form></div>`
      };
    }
  });

  app.post('/customers/:id/contacts', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const customer = find(ctx.params.id);
    if (!customer) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();
    if (!name || !email.includes('@')) {
      setFlash(ctx, 'error', 'A name and a valid email address are required.');
      return ctx.redirect(`/customers/${customer.id}/contacts`);
    }
    customer.contacts.push({
      id: `con-${customer.id}-${customer.contacts.length + 1}`, name,
      role: String(body.role ?? 'Other'), email, phone: String(body.phone ?? ''), primary: false
    });
    setFlash(ctx, 'success', 'Contact added.');
    return ctx.redirect(`/customers/${customer.id}/contacts`);
  });

  definePage({
    path: '/customers/:id/addresses', domain: 'customers', title: 'Customer addresses', kind: 'list',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Addresses — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Addresses' }],
        body: `<div class="panel">${table({
          caption: 'Delivery and billing addresses', testId: 'addresses-table',
          columns: [
            { header: 'Label', cell: row => h(row.label) },
            { header: 'Address', cell: row => h([row.line1, row.city, row.postcode].filter(Boolean).join(', ')) },
            { header: 'Country', cell: row => h(row.country) },
            { header: 'Default', cell: row => row.isDefault ? '<span class="pill pill-ok">Default</span>' : '' }
          ],
          rows: customer.addresses
        })}</div>`
      };
    }
  });

  definePage({
    path: '/customers/:id/credit', domain: 'customers', title: 'Credit and terms', kind: 'form',
    permission: 'customer:credit',
    view: (ctx, user) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const pct = Math.round((customer.creditUsed / customer.creditLimit) * 100);
      const editable = can(user, 'customer:credit');
      return {
        title: `Credit — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Credit' }],
        body: `<div class="grid grid-3" style="margin-bottom:14px">
${stat(money(customer.creditLimit), 'Credit limit', 'credit-limit')}
${stat(money(customer.creditUsed), 'Used', 'credit-used')}
${stat(`<span class="pill pill-${pct > 90 ? 'danger' : pct > 75 ? 'warn' : 'ok'}">${pct}%</span>`, 'Utilisation', 'credit-pct')}
</div>
<div class="panel" style="max-width:520px">
${editable ? `<form method="post" action="/customers/${h(customer.id)}/credit" data-testid="credit-form">
${csrfField(ctx)}
${field({ name: 'creditLimit', label: 'Credit limit (GBP)', type: 'number', value: customer.creditLimit, required: true,
  testId: 'credit-limit-input', attrs: { min: '0', max: '10000000', step: '100' } })}
${field({ name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', value: customer.paymentTermsDays, required: true,
  testId: 'credit-terms-input', attrs: { min: '0', max: '120', step: '1' } })}
${field({ name: 'status', label: 'Account status', value: customer.status, testId: 'credit-status',
  options: ['active', 'onHold'], hint: `A customer is placed on hold automatically above ${state.settings.billing.creditHoldThresholdPct}% utilisation.` })}
${field({ name: 'reason', label: 'Reason for the change', type: 'textarea', required: true, testId: 'credit-reason',
  attrs: { maxlength: '400' }, hint: 'Written to the audit log.' })}
<button class="btn" type="submit" data-testid="credit-save">Save credit terms</button>
</form>`
  : '<p class="hint" data-testid="credit-read-only">You can see these terms but not change them. Changing a credit limit needs the customer:credit permission.</p>'}
</div>`
      };
    }
  });

  app.post('/customers/:id/credit', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const customer = find(ctx.params.id);
    if (!customer) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    // Correct: the permission is enforced in the handler, not only by hiding the form.
    if (!can(user, 'customer:credit')) {
      setFlash(ctx, 'error', 'You do not have permission to change credit terms.');
      return ctx.redirect(`/customers/${customer.id}/credit`);
    }
    if (!String(body.reason ?? '').trim()) {
      setFlash(ctx, 'error', 'A reason is required: this change is audited.');
      return ctx.redirect(`/customers/${customer.id}/credit`);
    }
    const limit = Number(body.creditLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      setFlash(ctx, 'error', 'Enter a credit limit of zero or more.');
      return ctx.redirect(`/customers/${customer.id}/credit`);
    }
    customer.creditLimit = limit;
    customer.paymentTermsDays = Number(body.paymentTermsDays ?? customer.paymentTermsDays);
    customer.status = String(body.status ?? customer.status);
    state.auditEntries.unshift({
      id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: user.id,
      action: 'customer.creditChanged', entityType: 'customer', entityId: customer.id,
      ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
    });
    setFlash(ctx, 'success', 'Credit terms saved and audited.');
    return ctx.redirect(`/customers/${customer.id}/credit`);
  });

  definePage({
    path: '/customers/:id/pricing', domain: 'customers', title: 'Agreed pricing', kind: 'list',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const discount = { bronze: 0, silver: 2.5, gold: 5, platinum: 8 }[customer.tier] ?? 0;
      return {
        title: `Pricing — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Pricing' }],
        body: `<div class="panel">
<p class="hint">${h(customer.tier)} tier carries a ${discount}% discount on published freight rates.</p>
${table({
  caption: 'Agreed rates by service level', testId: 'pricing-table',
  columns: [
    { header: 'Service', cell: row => h(row.name) },
    { header: 'Published surcharge', cell: row => `${row.surchargePct}%` },
    { header: 'Tier discount', cell: row => `${discount}%` },
    { header: 'Effective surcharge', cell: row => `${Math.round((row.surchargePct - discount) * 10) / 10}%` }
  ],
  rows: state.SERVICE_LEVELS
})}</div>`
      };
    }
  });

  definePage({
    path: '/customers/:id/sla', domain: 'customers', title: 'Service agreement', kind: 'detail',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const shipments = state.shipments.filter(s => s.customerId === customer.id && s.status === 'delivered');
      const onTime = shipments.filter(s => s.deliveredAt && s.deliveredAt.slice(0, 10) <= s.estimatedDeliveryOn);
      const actual = shipments.length ? Math.round((onTime.length / shipments.length) * 1000) / 10 : null;
      return {
        title: `Service agreement — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Service agreement' }],
        body: `<div class="panel">${kv([
          ['Agreed on-time target', `${customer.slaOnTimePct}%`],
          ['Measured on-time', actual === null
            ? '<span class="pill pill-muted">No deliveries to measure</span>'
            : `<span class="pill pill-${actual >= customer.slaOnTimePct ? 'ok' : 'danger'}">${actual}%</span>`],
          ['Deliveries measured', String(shipments.length)],
          ['Payment terms', `${customer.paymentTermsDays} days`],
          ['Claim window', '14 days from delivery'],
          ['Liability cap', money(25_000)]
        ])}
<p class="hint" style="margin-top:12px">Where no delivery has completed, no percentage is shown rather than 0%, because nothing has been measured.</p>
</div>`
      };
    }
  });

  definePage({
    path: '/customers/:id/statements', domain: 'customers', title: 'Statements', kind: 'list',
    view: (ctx) => {
      const customer = find(ctx.params.id);
      if (!customer) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const invoices = state.invoices.filter(i => i.customerId === customer.id);
      const outstanding = invoices.filter(i => ['issued', 'overdue', 'disputed'].includes(i.status));
      return {
        title: `Statements — ${customer.name}`,
        breadcrumbs: [{ label: 'Customers', href: '/customers' }, { label: customer.name, href: `/customers/${customer.id}` }, { label: 'Statements' }],
        body: `<div class="grid grid-3" style="margin-bottom:14px">
${stat(String(invoices.length), 'Invoices on account', 'statement-count')}
${stat(money(outstanding.reduce((sum, i) => sum + i.totalGbp, 0)), 'Outstanding', 'statement-outstanding')}
${stat(String(invoices.filter(i => i.status === 'overdue').length), 'Overdue', 'statement-overdue')}
</div>
<div class="panel">${table({
  caption: 'Invoices on this account', testId: 'statements-table', empty: 'No invoices on this account.',
  columns: [
    { header: 'Invoice', cell: row => `<a href="/billing/invoices/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Issued', cell: row => shortDate(row.issuedOn) },
    { header: 'Due', cell: row => shortDate(row.dueOn) },
    { header: 'Net', cell: row => money(row.netGbp) },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: invoices
})}</div>`
      };
    }
  });
}

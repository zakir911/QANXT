/**
 * A fourth target, built the way intranets were built in 2004.
 *
 * Meridian Freight is a modern server-rendered app; clinic-spa renders everything in the
 * browser. Both share conventions QA NXT quietly relies on: a POST sign-in form, an
 * anti-forgery token, POST for anything that changes state, semantic markup.
 *
 * This one shares none of them:
 *
 *   - authentication is an HTTP Basic challenge, so there is no sign-in form to fill
 *   - state changes happen through GET links ("Approve", "Revoke"), not forms
 *   - there is no anti-forgery token anywhere
 *   - layout is nested tables with no landmarks, labels tied to inputs by position only
 *   - ids are sequential integers in the query string, not in the path
 *
 * That combination is the honest stress test for a crawler: a tool that only knows the
 * modern shape will sign in nowhere, find no forms, and — worse — may follow a GET link
 * that revokes a permit. Our own rule says never follow a link whose path matches
 * delete/remove/cancel; this target is where that rule earns its keep.
 *
 * Domain: municipal building permits.
 *
 * Planted:
 *
 *   PL_D01  GET /approve.asp?id=N approves with no check that the caller is an inspector
 *   PL_D02  /search.asp?term= echoes the term into the page unescaped
 *   PL_D03  the fee total on view.asp does not equal the sum of its fee lines
 *   PL_D04  applicant national insurance numbers are sent in full to every signed-in user
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4700);
const REALM = 'Permits';

const USERS = new Map([
  ['clerk', { password: 'Permit!2026', role: 'clerk' }],
  ['inspector', { password: 'Permit!2026', role: 'inspector' }],
  ['viewer', { password: 'Permit!2026', role: 'viewer' }]
]);

/** Fee lines deliberately do not add to `total` on permit 2 — PL_D03. */
const SEED = [
  { id: 1, ref: 'BP-2026-0001', applicant: 'H. Devi', ni: 'CE 12 34 56 C',
    address: '14 Mill Lane', status: 'submitted',
    fees: [{ label: 'Application', amount: 145.00 }, { label: 'Inspection', amount: 80.00 }],
    total: 225.00 },
  { id: 2, ref: 'BP-2026-0002', applicant: 'R. Osei', ni: 'AB 98 76 54 D',
    address: '2 Quarry Road', status: 'submitted',
    fees: [{ label: 'Application', amount: 145.00 }, { label: 'Inspection', amount: 80.00 },
           { label: 'Structural review', amount: 220.00 }],
    total: 225.00 },
  { id: 3, ref: 'BP-2026-0003', applicant: 'L. Marsh', ni: 'ZT 11 22 33 A',
    address: '77 Beacon Hill', status: 'approved',
    fees: [{ label: 'Application', amount: 145.00 }], total: 145.00 }
];

/** The live register, restored from SEED by /__reset. */
const PERMITS = SEED.map(permit => ({ ...permit, fees: permit.fees.map(f => ({ ...f })) }));

const money = n => n.toFixed(2);

/** Deliberately no escaping helper: this target has none anywhere. */
const page = (title, inner) => `<HTML>
<HEAD><TITLE>${title}</TITLE></HEAD>
<BODY BGCOLOR="#FFFFFF">
<TABLE WIDTH="760" BORDER="0" CELLPADDING="4" CELLSPACING="0">
<TR><TD BGCOLOR="#003366"><FONT COLOR="#FFFFFF" FACE="Verdana" SIZE="2">
<B>Borough of Ashfield &mdash; Building Control</B></FONT></TD></TR>
<TR><TD><FONT FACE="Verdana" SIZE="1">
<A HREF="/default.asp">Home</A> |
<A HREF="/list.asp">Permit register</A> |
<A HREF="/search.asp">Search</A> |
<A HREF="/new.asp">New application</A>
</FONT></TD></TR>
<TR><TD>${inner}</TD></TR>
</TABLE>
</BODY></HTML>`;

const identify = (req) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return null;
  const [username, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const user = USERS.get(username);
  return user && user.password === password ? { username, role: user.role } : null;
};

const challenge = (res) => {
  res.writeHead(401, {
    'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    'content-type': 'text/html'
  });
  res.end(page('Not authorised', '<FONT FACE="Verdana" SIZE="2">Sign in required.</FONT>'));
};

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=iso-8859-1' });
  res.end(body);
};

const body = (req) => new Promise(resolve => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => resolve(new URLSearchParams(raw)));
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname.toLowerCase();

  // Returns the register to its seeded state, for the same reason as the clinic target:
  // a run must start from the same application every time. Unauthenticated on purpose,
  // because it is lab scaffolding rather than part of the application being tested.
  if (path === '/__reset' && req.method === 'POST') {
    PERMITS.length = 0;
    PERMITS.push(...SEED.map(permit => ({ ...permit, fees: permit.fees.map(f => ({ ...f })) })));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, permits: PERMITS.length }));
  }

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, permits: PERMITS.length }));
  }

  const me = identify(req);
  if (!me) return challenge(res);

  if (path === '/' || path === '/default.asp') {
    return html(res, page('Building Control', `<FONT FACE="Verdana" SIZE="2">
      Signed in as <B>${me.username}</B> (${me.role}).<BR><BR>
      <A HREF="/list.asp">${PERMITS.length} permit application(s) on the register</A>
      </FONT>`));
  }

  if (path === '/list.asp') {
    const rows = PERMITS.map(p => `<TR>
      <TD><FONT FACE="Verdana" SIZE="1"><A HREF="/view.asp?id=${p.id}">${p.ref}</A></FONT></TD>
      <TD><FONT FACE="Verdana" SIZE="1">${p.applicant}</FONT></TD>
      <TD><FONT FACE="Verdana" SIZE="1">${p.address}</FONT></TD>
      <TD><FONT FACE="Verdana" SIZE="1">${p.status}</FONT></TD>
      <TD><FONT FACE="Verdana" SIZE="1">${p.status === 'approved'
        ? `<A HREF="/revoke.asp?id=${p.id}">Revoke</A>`
        : `<A HREF="/approve.asp?id=${p.id}">Approve</A>`}</FONT></TD>
      </TR>`).join('');
    return html(res, page('Permit register', `<FONT FACE="Verdana" SIZE="2"><B>Permit register</B></FONT>
      <TABLE BORDER="1" CELLPADDING="3" CELLSPACING="0" WIDTH="100%">
      <TR BGCOLOR="#EEEEEE">
        <TD><FONT FACE="Verdana" SIZE="1"><B>Reference</B></FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1"><B>Applicant</B></FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1"><B>Site</B></FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1"><B>Status</B></FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1"><B>Action</B></FONT></TD>
      </TR>${rows}</TABLE>
      <FONT FACE="Verdana" SIZE="1">Showing ${PERMITS.length} of ${PERMITS.length} applications.</FONT>`));
  }

  if (path === '/view.asp') {
    const permit = PERMITS.find(p => p.id === Number(url.searchParams.get('id')));
    if (!permit) return html(res, page('Not found', '<FONT FACE="Verdana" SIZE="2">No such permit.</FONT>'), 404);
    const lines = permit.fees.map(f => `<TR>
      <TD><FONT FACE="Verdana" SIZE="1">${f.label}</FONT></TD>
      <TD ALIGN="RIGHT"><FONT FACE="Verdana" SIZE="1">${money(f.amount)}</FONT></TD></TR>`).join('');
    // PL_D03: `total` is stored, not computed. PL_D04: the NI number is printed to everyone.
    return html(res, page(`Permit ${permit.ref}`, `<FONT FACE="Verdana" SIZE="2"><B>${permit.ref}</B></FONT>
      <TABLE BORDER="0" CELLPADDING="2"><TR>
        <TD><FONT FACE="Verdana" SIZE="1">Applicant</FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1">${permit.applicant}</FONT></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">National insurance</FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1">${permit.ni}</FONT></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">Site</FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1">${permit.address}</FONT></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">Status</FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1">${permit.status}</FONT></TD></TR></TABLE>
      <FONT FACE="Verdana" SIZE="2"><B>Fees</B></FONT>
      <TABLE BORDER="1" CELLPADDING="3" CELLSPACING="0" WIDTH="340">
      ${lines}
      <TR BGCOLOR="#EEEEEE"><TD><FONT FACE="Verdana" SIZE="1"><B>Total</B></FONT></TD>
      <TD ALIGN="RIGHT"><FONT FACE="Verdana" SIZE="1"><B>${money(permit.total)}</B></FONT></TD></TR>
      </TABLE>
      <FONT FACE="Verdana" SIZE="1">
      ${permit.status === 'approved'
        ? `<A HREF="/revoke.asp?id=${permit.id}">Revoke this permit</A>`
        : `<A HREF="/approve.asp?id=${permit.id}">Approve this permit</A>`}
      </FONT>`));
  }

  if (path === '/approve.asp') {
    const permit = PERMITS.find(p => p.id === Number(url.searchParams.get('id')));
    if (!permit) return html(res, page('Not found', 'No such permit.'), 404);
    // PL_D01: a GET, from any signed-in role, with no token and no confirmation.
    permit.status = 'approved';
    return html(res, page('Approved', `<FONT FACE="Verdana" SIZE="2">
      Permit ${permit.ref} approved by ${me.username}.<BR>
      <A HREF="/list.asp">Back to the register</A></FONT>`));
  }

  if (path === '/revoke.asp') {
    const permit = PERMITS.find(p => p.id === Number(url.searchParams.get('id')));
    if (!permit) return html(res, page('Not found', 'No such permit.'), 404);
    if (me.role !== 'inspector') {
      return html(res, page('Not permitted', `<FONT FACE="Verdana" SIZE="2">
        Only an inspector may revoke.</FONT>`), 403);
    }
    permit.status = 'revoked';
    return html(res, page('Revoked', `<FONT FACE="Verdana" SIZE="2">
      Permit ${permit.ref} revoked.<BR><A HREF="/list.asp">Back</A></FONT>`));
  }

  if (path === '/search.asp') {
    const term = url.searchParams.get('term') ?? '';
    const found = PERMITS.filter(p =>
      p.ref.toLowerCase().includes(term.toLowerCase()) ||
      p.applicant.toLowerCase().includes(term.toLowerCase()));
    // PL_D02: the term goes back out exactly as it came in.
    return html(res, page('Search', `<FORM ACTION="/search.asp" METHOD="GET">
      <TABLE BORDER="0"><TR>
      <TD><FONT FACE="Verdana" SIZE="1">Reference or applicant</FONT></TD>
      <TD><INPUT TYPE="TEXT" NAME="term" SIZE="30" VALUE="${term}"></TD>
      <TD><INPUT TYPE="SUBMIT" VALUE="Search"></TD>
      </TR></TABLE></FORM>
      ${term ? `<FONT FACE="Verdana" SIZE="1">${found.length} result(s) for ${term}</FONT>` : ''}
      <TABLE BORDER="1" CELLPADDING="3" CELLSPACING="0">
      ${found.map(p => `<TR><TD><FONT FACE="Verdana" SIZE="1">
        <A HREF="/view.asp?id=${p.id}">${p.ref}</A></FONT></TD>
        <TD><FONT FACE="Verdana" SIZE="1">${p.applicant}</FONT></TD></TR>`).join('')}
      </TABLE>`));
  }

  if (path === '/new.asp' && req.method === 'GET') {
    return html(res, page('New application', `<FONT FACE="Verdana" SIZE="2"><B>New application</B></FONT>
      <FORM ACTION="/new.asp" METHOD="POST">
      <TABLE BORDER="0" CELLPADDING="3">
      <TR><TD><FONT FACE="Verdana" SIZE="1">Applicant name</FONT></TD>
          <TD><INPUT TYPE="TEXT" NAME="applicant" SIZE="30"></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">National insurance</FONT></TD>
          <TD><INPUT TYPE="TEXT" NAME="ni" SIZE="16"></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">Site address</FONT></TD>
          <TD><INPUT TYPE="TEXT" NAME="address" SIZE="40"></TD></TR>
      <TR><TD><FONT FACE="Verdana" SIZE="1">Estimated cost</FONT></TD>
          <TD><INPUT TYPE="TEXT" NAME="cost" SIZE="12"></TD></TR>
      <TR><TD COLSPAN="2"><INPUT TYPE="SUBMIT" VALUE="Submit application"></TD></TR>
      </TABLE></FORM>`));
  }

  if (path === '/new.asp' && req.method === 'POST') {
    const form = await body(req);
    const applicant = (form.get('applicant') ?? '').trim();
    const address = (form.get('address') ?? '').trim();
    const cost = Number(form.get('cost'));
    const problems = [];
    if (!applicant) problems.push('Applicant name is required.');
    if (!address) problems.push('Site address is required.');
    if (!Number.isFinite(cost) || cost <= 0) problems.push('Estimated cost must be a positive number.');
    if (problems.length) {
      return html(res, page('New application', `<FONT FACE="Verdana" SIZE="2" COLOR="#CC0000">
        ${problems.join('<BR>')}</FONT><BR><A HREF="/new.asp">Back to the form</A>`), 400);
    }
    const id = PERMITS.length + 1;
    PERMITS.push({ id, ref: `BP-2026-${String(id).padStart(4, '0')}`, applicant,
      ni: form.get('ni') ?? '', address, status: 'submitted',
      fees: [{ label: 'Application', amount: 145.00 }], total: 145.00 });
    return html(res, page('Submitted', `<FONT FACE="Verdana" SIZE="2">
      Application received. Reference BP-2026-${String(id).padStart(4, '0')}.<BR>
      <A HREF="/list.asp">Back to the register</A></FONT>`), 201);
  }

  return html(res, page('Not found', '<FONT FACE="Verdana" SIZE="2">Page not found.</FONT>'), 404);
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`permits-legacy listening on http://127.0.0.1:${PORT}`));

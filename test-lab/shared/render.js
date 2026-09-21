/**
 * Page furniture shared by the server-rendered lab applications.
 *
 * The banking application is a React build; the rest are server-rendered with real client
 * JavaScript, which keeps them fast to start and easy to reason about when a test fails.
 * They still serve genuine HTML, run genuine scripts and call genuine APIs.
 */
import { escapeHtml } from './http.js';

export function layout({ title, application, body, nav = [], active = '', head = '', script = '' }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · ${escapeHtml(application)}</title>
<style>${BASE_CSS}</style>
${head}
</head>
<body>
<header class="masthead">
  <span class="brand" data-testid="brand">${escapeHtml(application)}</span>
  ${nav.length ? `<nav class="nav" aria-label="Main">${nav.map(([href, label, testId]) =>
    `<a href="${href}" data-testid="${testId}"${active === testId ? ' class="active"' : ''}>${escapeHtml(label)}</a>`).join('')}</nav>` : ''}
</header>
<main class="content">
${body}
</main>
<footer class="footer">Synthetic application. Part of the AIRA test lab.</footer>
${script ? `<script type="module">${script}</script>` : ''}
</body>
</html>`;
}

export const BASE_CSS = `
:root { --ink:#101a2b; --muted:#5b6b82; --line:#e2e8f2; --bg:#f6f8fb; --brand:#0b2545; --accent:#0b5fff; --danger:#c02626; --ok:#12855a; }
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
.masthead{display:flex;align-items:center;gap:18px;background:var(--brand);color:#fff;padding:12px 22px;flex-wrap:wrap}
.brand{font-weight:700}
.nav{display:flex;gap:14px}
.nav a{color:rgba(255,255,255,.82);text-decoration:none}
.nav a.active{color:#fff;border-bottom:2px solid #fff}
.content{max-width:1000px;margin:0 auto;padding:24px 22px 60px}
.footer{text-align:center;color:var(--muted);font-size:12px;padding:18px}
h1{font-size:24px;margin:0 0 14px}
h2{font-size:17px;margin:24px 0 10px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:14px}
th{background:#f0f4fa;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;background:#fff}
input[type=checkbox],input[type=radio]{width:auto}
button,.button{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.error{color:var(--danger);font-size:13px;margin:4px 0 0}
.ok{color:var(--ok)}
.notice{background:#fdecec;border:1px solid #f3c2c2;color:var(--danger);border-radius:8px;padding:10px 12px}
.confirmation{background:#e6f5ee;border:1px solid #b7e2ce;color:var(--ok);border-radius:8px;padding:12px 14px;margin:14px 0}
.muted{color:var(--muted);font-size:13px}
.modal-backdrop{position:fixed;inset:0;background:rgba(16,26,43,.55);display:grid;place-items:center}
.modal{background:#fff;border-radius:10px;padding:22px 24px;width:430px;max-width:92vw}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:14px}
.tabs button{border:0;border-bottom:2px solid transparent;background:none;border-radius:0}
.tabs button[aria-selected=true]{border-bottom-color:var(--accent);color:var(--accent)}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:#e8f0ff;color:var(--accent)}
`;

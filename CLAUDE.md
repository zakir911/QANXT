# QA NXT

AI-powered autonomous testing for web applications. .NET 8 control plane, Node 22 browser
worker, React console, PostgreSQL and Redis.

| | |
| --- | --- |
| Start everything | `make dev` |
| Run every test suite | `make test` |
| Prove the product | `./scripts/verify-product` (~40 min, writes reports and a certification) |
| One area only | `make verify-security`, `make verify-continuous-quality`, `make verify-autonomous-qa` |
| What each command does | `make help` |

Read `docs/architecture.md` first, then `docs/user-manual.md` for what the product does from a
user's side. `docs/agent.md` covers the autonomous agent specifically.

**Two house rules the code is built around.** A pass means it ran, the expected behaviour was
observed and there is evidence — never that the code exists. And nothing changes itself
without asking: the agent proposes, healing is a suggestion until approved, and a test is
never edited to make it green.

## gstack

Use the **`/browse` skill from gstack for all web browsing.** Never use the
`mcp__claude-in-chrome__*` tools.

Available skills:

`/office-hours` · `/plan-ceo-review` · `/plan-eng-review` · `/plan-design-review` ·
`/design-consultation` · `/design-shotgun` · `/design-html` · `/review` ·
`/deslop-shared-libs` · `/ship` · `/land-and-deploy` · `/canary` · `/benchmark` · `/browse` ·
`/connect-chrome` · `/qa` · `/qa-only` · `/design-review` · `/scrape` ·
`/setup-browser-cookies` · `/setup-deploy` · `/setup-gbrain` · `/retro` · `/investigate` ·
`/document-release` · `/document-generate` · `/codex` · `/cso` · `/autoplan` ·
`/plan-devex-review` · `/devex-review` · `/careful` · `/freeze` · `/guard` · `/unfreeze` ·
`/gstack-upgrade` · `/learn`

### Browser support in this container

gstack's Chromium bootstrap cannot run here: the environment's network policy blocks the
Playwright CDN, which is the same reason `EXEC-015` and `EXEC-016` report Firefox and WebKit
as **not verified** rather than passed.

The browser skills work anyway, against the Chromium this container already ships
(`/opt/pw-browsers`, Chromium 141). gstack's Playwright expects revision `1234` and the
container has `1194`, so `1234` is a copy of `1194` carrying the directory and binary names
the newer Playwright looks for. Verified working: `browse goto` reaches a page and `browse
text` reads it back.

Treat that as a local accommodation rather than a supported configuration. It pairs a
Playwright client with a Chromium about ten releases older than the one it pins, so a browser
skill failing in an odd way is worth suspecting here before it is treated as a defect. The
supported fix is a network path to the Playwright CDN and a plain `./setup`.

Headed mode is not available — there is no display — so `GSTACK_CHROMIUM_PATH` has no effect;
gstack's headless path always resolves through the Playwright cache.

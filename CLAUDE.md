# QA NXT

AI-powered autonomous testing for web applications. .NET 8 control plane, Node 22 browser
worker, React console, PostgreSQL and Redis.

| | |
| --- | --- |
| Start everything | `make dev` |
| Run every test suite | `make test` |
| Prove the product | `./scripts/verify-product` (~40 min, writes reports and a certification) |
| One area only | `make verify-security`, `make verify-continuous-quality`, `make verify-autonomous-qa` |
| Form-level testing, AI disabled | `./scripts/verify-complete-manual-testing` (~30 min, writes `verification/manual-testing-coverage-report.md`) |
| What each command does | `make help` |
| One target, end to end | `node test-lab/run-target.mjs clinic-spa permits-legacy token-api` |

`verification/multi-target-results.md` is what the product found on four applications of
different shapes, with the planted defect it does not find and why. Two of the three small
targets are at 4 of 4; the third needs a feature that is named there rather than a fix.
`verification/defects-found-by-measuring.md` is the product's own defects, each with the
evidence that established it.

Read `docs/architecture.md` first, then `docs/user-manual.md` for what the product does from a
user's side. `docs/agent.md` covers the autonomous agent specifically, and `docs/form-testing.md`
the deterministic form-level test engine, coverage and the testing taxonomy.

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
(`/opt/pw-browsers`). The pinned Playwright asks for a revision the container does not have
under that name, so the revision it asks for is made a view onto the one that is there,
carrying the directory and binary names it looks for. Verified working: `browse goto`
reaches a page and `browse text` reads it back.

**Run `./scripts/shim-playwright` after a container restart.** The links live outside the
repository and a restart loses them; without them discovery fails with "the browser
Playwright needs is not installed on this worker", which reads like a product fault in the
run's own report. The script reads the pinned revision from the worker's own dependency
rather than hard-coding it, does nothing when the revision already matches, and is safe to
run repeatedly.

Treat that as a local accommodation rather than a supported configuration. It pairs a
Playwright client with a Chromium about ten releases older than the one it pins, so a browser
skill failing in an odd way is worth suspecting here before it is treated as a defect. The
supported fix is a network path to the Playwright CDN and a plain `./setup`.

Headed mode is not available — there is no display — so `GSTACK_CHROMIUM_PATH` has no effect;
gstack's headless path always resolves through the Playwright cache.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design System
Read DESIGN.md before visual or UI work: it defines the fonts, colors, spacing, and
aesthetic direction. Ask the user before departing from it. When reviewing or QA-ing
UI, flag code that doesn't match DESIGN.md.

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
different shapes. All three small targets are at 4 of 4, from one run in one configuration
with interaction authorised. That it is one configuration is recent: clinic-spa needs the
authorisation, because finding its defect means pressing a control, and the same
authorisation used to cost permits-legacy a defect by approving permits while mapping.
Defect 81 has it.

The large one is at **11 of the 17 its measurement can speak to**, with 5 missed, 11
unscoreable and 4 on screens nothing reached. It read as 10 of 32 with 17 missed until the
join was examined: thirteen defects had keyword lists the oracles' own wording never matches,
so the measurement could not score them either way and published them as the product's
failure. One of the ten was also a misattribution. Defect 61 has the arithmetic. An
unscoreable defect is a gap in the measurement, not a verdict on the product, and the two are
no longer added together.

A security finding count is a count of **facts, not report rows**, and was not until
2026-11-26: freight reported 173 rows holding 17 distinct facts, 151 of them one missing
response header and one cookie attribute repeated once per page looked at. Defect 86. The
small targets' finding figures in `multi-target-results.md` were corrected with it, from
19/23/13 to 11/7/10.

**Freight's write checks were wrong in six ways and four of them were in series**, found on
2026-11-26 by re-measuring after each fix and refusing to believe an improvement. Giving the
anti-forgery check a body the endpoint would accept exposed three further faults behind it,
and each intermediate state was more confidently wrong than the silence it replaced: one run
reported forty findings, most of them false, against endpoints that enforce their tokens
properly. Defects 82 to 87. The product now reports three true write findings on freight that
are **not planted defects** — `/fleet/drivers/new`, `/orders/purchase/new` and
`/routes/planner`, each verified by hand — and on `/routes/planner`, which enforces its
permission and not its token, it reports the missing token and no privilege escalation.

On freight's own security scan, **13 endpoints with no effective anti-forgery check are
reported and all 13 are right**, 11 of them also reporting a read-only write, and the 2 that
carry a permission gate correctly get no privilege finding. Three administrative pages an
operations user reaches were verified by hand at 200 with their content. FP_D29 is found;
FP_D11 is **named as a gap carrying its own address and not found**, because discovery maps as
one identity and the control is invisible and 403 to that one. Defects 88 and 89, and
`multi-target-results.md` has the run history — including that the default 160-page budget
does not reach the adjustment page and the run says so.

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

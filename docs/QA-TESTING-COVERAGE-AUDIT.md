# QA testing coverage audit

Audit of QA NXT at commit `c0df714f` (before the form-level testing work), against a
professional manual-QA taxonomy. Written from reading the code and running it, not from the
documentation's claims.

**How a row is judged.** A capability counts as supported only when the platform can
**generate → execute → detect → record → report** it. Something that exists only as an enum
value, a tag, a table or a button doesn't count.

Column meanings:

- **Exists**: there is code for it.
- **Generated**: the deterministic generator (`LocalTestPlanner`) produces it without AI.
- **Executed**: the worker can run the resulting steps and evaluate them.
- **UI**: a person can configure, select or see it in the console.
- **Evidence**: execution leaves evidence specific to it.
- **Form coverage**: it is applied per discovered *form*, not just per page or element.

## Findings before this work

| Testing category | Exists | Generated | Executed | UI available | Evidence | Form coverage | Missing |
|---|---|---|---|---|---|---|---|
| Positive / happy path | Yes | Partial: one fill-and-submit per page classified `form`, max 6 inputs | Yes | Test cases list | Screenshots, trace, video, network | No | No success oracle unless discovery saw a success element. Pages not classified `form` get no happy path |
| Negative | Yes | Yes: per text-like control (required, format, whitespace) | Yes | Tag only | Yes | No: per element, not per form | The oracle is `assertUrl` containing the page route, which also passes when the form *accepts* on the same route. Never "all required empty" or "each required alone" |
| Boundary value analysis | Partial | Hard-coded values per semantic type (`LocalElementRules.BoundaryValuesFor`) | Yes | Tag only | Yes | No | Discovery never captures `min`, `max`, `minlength`, `maxlength`, `step` or `pattern`, so no min−1/min/min+1/max−1/max/max+1 is possible and unknown limits aren't reported |
| Equivalence partitioning | No | No | — | No | — | No | Not represented |
| Input validation (spaces, Unicode, encoding, long input) | Partial | Whitespace only | Yes | No | Yes | No | Leading/trailing spaces, tabs, newlines, Unicode, emoji, HTML and encoded characters, very long input, null-like values |
| Cross-field validation | No | No | — | No | — | No | Field relationships (confirm password, start < end, country → state) are never inferred |
| Conditional / dynamic forms | No | No | — | No | — | No | Hidden-then-shown fields aren't discovered as conditional |
| Multi-step / wizard | No | No | — | No | — | No | Not detected |
| Button behaviour (double click, keyboard, duplicate submit) | Partial | No | `doubleClick` and `press` exist | No | Network log captured | No | No way to count requests a submit produced, so duplicate submission can't be detected |
| Error message testing | Partial | No | `assertVisible` on error elements is possible by hand | No | Yes | No | No oracle for "an error is associated with the field" (`aria-invalid`, `aria-describedby`) |
| Form state testing | No | No | — | No | — | No | — |
| Duplicate submission | No | No | No | No | Network captured, not asserted | No | — |
| Security (forms) | Yes, at app level | No | Security engine scans (XSS, injection, authz, CSRF, headers) are scope-guarded and separate | Security page | Yes | No | Form tests never include safe reflection or CSRF-token indicators |
| Accessibility | Yes | One axe-core check per page | Yes (`checkAccessibility`) | Results in execution detail | axe results stored | No: page-level, not scoped to the form | Keyboard, tab-order and focus checks; label association per field; human-only items aren't listed |
| Usability heuristics | No | No | — | No | — | No | — |
| Compatibility (browsers) | Yes | n/a | Chromium; Firefox and WebKit via the container (not installable here, CDN blocked) | Browser chosen per run | Engine/version per execution | No | No viewport matrix |
| Responsive / viewports | Partial | No | Visual descriptor accepts a viewport | No | — | No | No step to change viewport, so a responsive test of a form can't be generated |
| Visual | Yes | No (manual authoring only) | Yes (`checkVisual`, baselines per viewport, thresholds) | Baseline review | 3 images per comparison | No | Never generated for forms |
| API / backend | Yes | API tests generated from observed endpoints (`ApiTestGeneration`) | Yes | API tests | Request/response exchange | No | No correlation of a form's fields with the endpoint its submission calls |
| Data integrity (database) | No | No | No | No | — | No | QA NXT has no read path into a target's database. Only observable through the application's own APIs |
| Performance (response time) | Partial | No | Network timings captured; `responseTimeUnderMs` for API steps only | Performance golden suite measures QA NXT itself | Timings in HAR | No | No page or submit response-time assertion for UI tests |
| Load / stress / spike / endurance | No | No | No | No | — | No | Needs infrastructure the worker isn't built for |
| Regression | Yes | — | Regression *selection* from a diff exists (`RegressionSelectionService`) | Regression page | Yes | No | No "run failed", no "run regression suite", no regression test made from a confirmed defect |
| Smoke / sanity / BVT | Yes | "Reachable" smoke per page | Yes | Tag only | Yes | n/a | Not selectable as a category |
| Exploratory | Partial | No | The autonomous agent explores with AI or rules | Agent page | Yes | No | No deterministic exploratory paths (back/forward/refresh/repeat) generated per form |
| State transition | No | No | — | No | — | No | — |
| Error handling / recovery / reliability | Partial | No | Failure lab and retries exist | Failures page | Yes | No | Not generated |
| Workflow / end-to-end | Yes | Journeys imported from the recorder become tests | Yes | Journeys | Yes | n/a | — |
| Human verification | No | No | No | No | No | No | No task model at all. Everything not automatable is silently absent |
| Manual test import | No | No | — | No | — | — | CSV, Excel, JSON and text import absent |
| Test lifecycle / versioning | Partial | — | — | Enable/disable, edit, delete | — | — | `Version` is an integer with no history; no Draft/Active/Deprecated/Archived; no duplicate, no bulk actions |
| Defects | Partial | — | — | — | — | — | A `Defect` table exists and **nothing creates rows in it**. `Failure.Signature` includes the test case, so twenty tests failing for one reason are twenty clusters |
| Coverage reporting | Partial | — | — | Dashboard counts | — | No | No per-form, per-field, per-category or per-boundary coverage. No gap list |
| Testing configuration (modes, categories) | No | — | — | No | — | — | No Quick/Standard/Comprehensive/Custom; no per-category selection |
| AI optionality | Partial | The local planner needs no model | Yes | — | — | — | **`TestGenerationService` refuses to run when the project's `AiEnabled` is false**, although the planner it would call is deterministic. With AI switched off a user can't generate a single test |
| Arbitrary test limits | Mostly removed | Default scenario budget is 0 (unlimited); 200 pages / 30 elements per page in context | — | — | — | — | The 30-element cut drops fields of large forms; the happy path takes 6 inputs; 50 test-data fields |

## What this meant in practice

On the forms lab (`test-lab/forms-app`, one form with 17 controls), the generator produced
tests about the page and some of its controls. It produced nothing about the form as a
unit: no matrix, no limits, no relationships, no states. The required-field oracle was
true whether or not the application enforced the rule.

## What changed

The matrix above is the "before". The "after" — what each category does now, measured by
running it — is in `verification/manual-testing-coverage-report.md`, produced by
`./scripts/verify-complete-manual-testing`. The design is in `docs/form-testing.md`.

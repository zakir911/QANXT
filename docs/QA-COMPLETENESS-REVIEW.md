# Can a QA team automate all of its testing with QA NXT?

A review from a QA lead's chair: what a team needs to take an application from "never
tested" to "tested on every release", what QA NXT does for each, and what is still missing.
Checked against the code on 2026-10-15, not against intentions.

**Short answer:** it covers web functional, form-level, regression, accessibility,
security-scope and API testing well enough to run unattended, with honest reporting. It
does not yet replace a QA team for anything that needs a second channel (email, SMS, MFA),
real load, native mobile, or the application's database, and two gaps carry real risk:
form tests can submit to production, and defects stay inside QA NXT.

## The path a tester follows

| Step | Where | State |
|---|---|---|
| 1. Choose or create the project | Projects | Done. Every screen shows only the selected project. |
| 2. Add the application and its sign-in | Applications | Done. Credentials, seed routes, sitemap, robots.txt. |
| 3. Explore it | Discovery | Done. Pages, elements, forms (including forms behind a dialog), API calls. |
| 4. Choose, generate and run the tests | Testing | Done. Four guided steps; 26 testing types; optional security scan. |
| 5. Follow the run, download the bug report | Test runs | Done. One report for test failures and security findings, tagged by testing type. |
| 6. Confirm or reject what was found | Defects | Done. Proposed until a person confirms; confirmed defects become regression tests. |
| 7. Do what only a person can | Human checks | Done. Steps, expected result, verdict and evidence. |
| 8. See what was tested and what was not | Coverage | Done. Measured, with every gap and the reason. |

## What is covered

- **Functional and form-level testing**, deterministic and with no AI required: required
  fields, boundaries, validation, equivalence, cross-field rules, conditional fields,
  wizards, duplicate submission, recovery, state, error handling, exploratory probes.
- **Regression**: run all, failed, impacted by a change, the regression suite, or a chosen
  slice; schedules; CI through the CLI with quality gates.
- **Accessibility**: axe-core rules in normal and error states, error association, keyboard
  order and submission; screen-reader checks as human tasks.
- **Security**: form-level checks on every form (markup reflection, anti-forgery token,
  password masking) and the scoped security scanner, which now runs from Testing into the
  same bug report.
- **API**: requests each form makes, recorded API tests, contract baselines and breaking
  change detection.
- **Visual and responsive**: baselines with approval, every configured screen size,
  sideways-scrolling checks that count only what a user can reach.
- **Evidence and reporting**: screenshots, Playwright trace, video, DOM and accessibility
  snapshots, network and console per failure; a developer-ready bug report (HTML, Markdown,
  JSON, evidence pack); coverage measured, never claimed.
- **Maintenance**: self-healing proposals that need approval, test versions and compare,
  lifecycle (Draft, Active, Disabled, Deprecated, Archived), manual test import.

## What is missing, in order of risk

| # | Gap | Why it matters | Suggested change |
|---|---|---|---|
| 1 | **Form tests can submit on production.** Changing API requests are blocked on an environment marked production; browser form submissions are not. | A full run against a live site submits real contact forms, orders or sign-ups — dozens of submissions for every form it tests. | Refuse, or skip with a reason, every test that submits a form when the run's environment is production, unless the environment allows destructive tests. |
| 2 | **Defects do not reach the team's tracker.** Jira is an enum value; there is no push to Jira, GitHub or Azure Boards. | Developers live in their tracker; a defect only in QA NXT is a defect someone must copy by hand. | Create and sync issues from confirmed defects, with the bug report attached; keep the external key on the defect. |
| 3 | **Second-channel flows**: email confirmation, password reset links, SMS or authenticator codes, CAPTCHA. | Sign-up, reset and MFA are among the most important flows and the most often broken. | A test mailbox (e.g. Mailpit) and a TOTP secret per test identity; CAPTCHA stays a human task or a test-mode bypass. |
| 4 | **Test data clean-up.** Tests create records and nothing removes them. | Repeated runs fill staging with test data and can change what later tests see. | Tag created records with the run id and a per-application clean-up hook (API call or SQL) after the run. |
| 5 | **Load and stress.** Single-user timings only. | A form that answers in 300 ms alone may fail at 200 users. | Export the discovered endpoints and payloads as a k6 or Gatling script; record its results beside the run. |
| 6 | **Database verification.** "Was the right record stored?" is a human task. | Data integrity is the defect class users notice last and mind most. | Optional read-only connection, or an application API, to compare the stored record with what was submitted. |
| 7 | **Firefox and WebKit** need installing on the worker. | Compatibility tests are skipped, not passed, until they are. | Ship worker images with all three browsers. |
| 8 | **Localisation**: no checks per language or locale (dates, numbers, text overflow in long languages). | International products break here first. | Run the suite per configured locale; flag untranslated strings and overflow. |
| 9 | **Native mobile apps.** Web only (mobile screen sizes are covered). | Teams with an app have half their testing elsewhere. | Out of scope today; an Appium-based worker would be a separate product line. |
| 10 | **Review before tests go live.** Generated tests are Active at once; imported ones are Draft. | Some teams require a lead to approve tests before they count. | An optional "generated tests start as Draft" setting, and a bulk review screen. |
| 11 | **Release sign-off.** Results are per run; there is no "release 4.2: ready / not ready" view across runs, security and human checks. | Release decisions need one page. | A release report that combines the latest run, open defects by severity, security gate and outstanding human checks for one build. |

## Recommendation

Fix 1 before anyone points QA NXT at a live site. Do 2 and 3 next: they decide whether a
team can rely on QA NXT day to day. The rest can follow demand.

# TODOS

## Live OTP relay for in-page sessions
- **From:** CEO review of docs/designs/qa-lead-sign-off-engine.md (decision CEO-1, D13, 2026-10-17). Deferred, not rejected.
- **What:** a run that reaches an OTP screen pauses and asks the QA lead for the code on the run's page in the console (with a timeout), then runs all its tests in that one signed-in browser and signs out. Needed for apps whose session lives only in the page and that send real SMS or email codes.
- **Why deferred:** HFCB can supply a fixed test OTP for UAT, and automatic sign-in with a fixed code or an authenticator secret already exists (apps/browser-worker/src/browser/authenticator.ts).
- **Build when:** a client cannot provide a fixed test OTP or an authenticator secret for its test account.
- **Design notes (from the spec review):** the relayed code is never stored, logged or shown in evidence; a timeout marks the run's tests not run with "sign-in: code not entered"; the lead is notified that a run is waiting; tests that end the session run last.

## Saved-session recording screen

- **What:** a console screen where the worker signs in (fixed OTP or authenticator secret) and saves the application's storage state for later jobs, when the session survives a page load (design step 1, first bullet; CEO-2, CEO-6).
- **Why deferred:** CEO review D25 (2026-10-17). Applications whose session survives a page load already work with automatic sign-in; the screen only saves sign-in time. HFCB keeps its session in the page and cannot use a saved session.
- **When to build:** when sign-in load (OTP rate limits, lockouts, run time) becomes a measured problem on an application that keeps its session in a cookie or local storage.
- **Design notes:** encrypt like other credentials, scope to one application and environment, delete on expiry, re-record or application deletion; save only when `checkSessionSurvivesLoad` is sure (outside-voice finding 15).

## Escape metric for "not run" verdicts

- **What:** measure real defects that the three-state verdicts report as not run, e.g. a required control the release removed showing as "could not find X", or a hung page showing as "timeout before ready".
- **Why:** outside-voice finding 9 in the CEO review (D28, 2026-10-17). The false-failure rate counts only defects the lead rejects, so the person being measured controls it, and nothing measures escapes.
- **When to build:** after the first signed HFCB pack, once there is a release whose production defects can be compared with the pack's not-run list.
- **Design notes:** compare a later release's defects with the previous pack's not-run reasons per form and field; surface "not run in two consecutive packs" as a warning on the sign-off page.

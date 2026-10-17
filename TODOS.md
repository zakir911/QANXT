# TODOS

## Live OTP relay for in-page sessions
- **From:** CEO review of docs/designs/qa-lead-sign-off-engine.md (decision CEO-1, D13, 2026-10-17). Deferred, not rejected.
- **What:** a run that reaches an OTP screen pauses and asks the QA lead for the code on the run's page in the console (with a timeout), then runs all its tests in that one signed-in browser and signs out. Needed for apps whose session lives only in the page and that send real SMS or email codes.
- **Why deferred:** HFCB can supply a fixed test OTP for UAT, and automatic sign-in with a fixed code or an authenticator secret already exists (apps/browser-worker/src/browser/authenticator.ts).
- **Build when:** a client cannot provide a fixed test OTP or an authenticator secret for its test account.
- **Design notes (from the spec review):** the relayed code is never stored, logged or shown in evidence; a timeout marks the run's tests not run with "sign-in: code not entered"; the lead is notified that a run is waiting; tests that end the session run last.

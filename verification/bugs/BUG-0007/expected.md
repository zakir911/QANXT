# BUG-0007 — expected

Discovery signs in and crawls the application.

- The sign-in is verified **after** the asynchronous outcome has had a chance to happen:
  the platform waits, up to the action timeout, for the URL to leave the login page, for
  the password field to disappear, for a configured success locator to appear, or for the
  application to render an error.
- With correct credentials the run reaches `completed` or `partiallyCompleted` and maps
  the nine pages the ground truth declares.
- With genuinely wrong credentials the run still fails, and says so — the fix must not turn
  a real authentication failure into a pass.

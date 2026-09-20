# End-to-end checks

These drive the running stack in a real browser, against real data. They answer the question
unit tests cannot — "does a person actually get a working product" — and each one fails loudly
rather than reporting a green that means nothing.

| Check | What it proves |
| --- | --- |
| `console-check.mjs` | The web console works: sign in, dashboard metrics computed from real runs, the discovered application map, a generated test's steps, a run and an execution, a stored screenshot rendering through the authorized artifact path, a healing proposal with its confidence, and the insights engine answering a question — failing on any console error along the way. |
| `../../apps/browser-worker/extension-check.mjs` | The MV3 recorder works: the real extension is loaded into a real Chromium, recording is started from its own popup, a journey is recorded through the demo bank, and the resulting JSON is checked for the right steps, the right locator preferences, and a password captured as a `${secret:...}` reference rather than a value. Writes the recording to `/tmp/aira-journey.json`. |
| `cli-check.mjs` | The CLI works as a pipeline needs: it drives a real run, its JUnit output parses in a real XML parser with counts matching its contents, a broken application turns the build red, and misuse, a rejected token and an unreachable platform each exit with their own code rather than looking like a test failure. |
| `journey-import-check.mjs` | The recorder loop closes: that recorded journey imports through the platform API, generates a test case, and that test executes green in a real browser with every step passing, the secret masked in stored evidence, and screenshots, video, trace and network log captured. |

## Running them

Start the stack first:

```bash
bash scripts/services-ctl.sh --with-database
bash scripts/api-ctl.sh start && bash scripts/api-ctl.sh wait
bash scripts/demo-bank-ctl.sh start
bash scripts/worker-ctl.sh start
bash scripts/console-ctl.sh start
```

Then, from `tests/e2e`:

```bash
pnpm console     # the web console
pnpm recorder    # record a journey with the extension
pnpm journey     # import that recording and execute the test it generates
pnpm cli         # drive the CLI the way a pipeline does
```

`recorder` and `journey` are meant to run in that order: the first produces the recording the
second consumes. `journey` takes an optional path if you want to import a different recording:

```bash
node journey-import-check.mjs ./some-recording.json
```

Console screenshots of each step are written to `/tmp/aira-shots/`, and a failing step captures
the page as it was when it failed.

## Credentials

The checks sign in as the seeded QA lead. Override with `AIRA_API_URL`, `AIRA_ORG`,
`AIRA_EMAIL` and `AIRA_PASSWORD` to point them at another environment.

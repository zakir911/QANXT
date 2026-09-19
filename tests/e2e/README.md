# End-to-end checks

`console-check.mjs` drives the web console in a real Chromium against a running stack. It is
the check that answers "does a person actually get a working product", which unit tests and
API tests cannot: it signs in, reads the dashboard's computed metrics, opens the discovered
application map, inspects a generated test, opens a run and an execution, confirms a stored
screenshot renders through the authorized artifact path, reviews a healing proposal, and
asks the insights engine a question — failing on any console error along the way.

## Running it

Start the stack first:

```bash
bash scripts/services-ctl.sh --with-database
bash scripts/api-ctl.sh start && bash scripts/api-ctl.sh wait
bash scripts/demo-bank-ctl.sh start
bash scripts/worker-ctl.sh start
bash scripts/console-ctl.sh start
```

Then, from `apps/browser-worker` (which has Playwright installed):

```bash
node ../../tests/e2e/console-check.mjs
```

Screenshots of each step are written to `/tmp/aira-shots/`, and a failing step captures the
page as it was when it failed.

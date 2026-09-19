# Demo Bank

A small retail-banking application used to exercise the platform end to end. It is a real
application — real routes, real forms, real server-side validation, real API calls — not a
set of mocked screens. **All data is synthetic.** No real banking system or customer data is
involved, and nothing here should ever be pointed at one.

## Why it exists

The platform's claims (discovery, generation, execution, evidence, failure analysis,
self-healing) need a target that can be broken on purpose and put back. Demo Bank has
switches for exactly that.

## Running

```bash
pnpm --filter @aira/demo-bank start     # http://localhost:4200
```

## Credentials

| Username | Password | Notes |
|---|---|---|
| `alice` | `Password123!` | Normal customer with three accounts |
| `bob` | `Password123!` | Customer with an empty account |
| `locked` | `Password123!` | Always reports a locked account |

## Fault injection

The scenario switches let the platform demonstrate failure analysis and healing. They are
set through the control endpoint and are process-local, so they never leak between runs.

```bash
curl -X POST http://localhost:4200/__control/scenario \
  -H 'content-type: application/json' \
  -d '{"renameLoginButton": true}'

curl http://localhost:4200/__control/scenario     # inspect current state
curl -X POST http://localhost:4200/__control/reset # back to a clean application
```

| Switch | Effect | What it demonstrates |
|---|---|---|
| `renameLoginButton` | "Sign in" becomes "Log in", and its test id changes | Locator healing on an accessible-name change |
| `moveStatementButton` | The statement download control moves into an overflow menu | Healing across a structural change |
| `removeTestIds` | Strips every `data-testid` | Fallback to semantic locators |
| `renameFilterControls` | The transaction filter controls keep their labels but get new test ids | The canonical locator break self-healing exists for |
| `slowDashboard` | Adds a 6s delay to the dashboard | Timing-issue classification |
| `breakTransactionsApi` | `/api/accounts/:id/transactions` returns 500 | Application-defect classification |
| `wrongBalance` | Dashboard total is computed incorrectly | An assertion catching a genuine defect |
| `emptyStatement` | Statement downloads produce an empty file | Content assertions |
| `sessionTimeout` | The next authenticated request 401s | Session-expiry handling |

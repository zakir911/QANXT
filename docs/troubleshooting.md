# Troubleshooting

What a symptom usually means, and what to check first.

## The pipeline failed. Who should look?

Read the exit code before anything else — it is chosen to answer exactly this.

| | | |
| --- | --- | --- |
| `1` | `TEST_FAILURE` | The application or the tests. Start with `summary.md`. |
| `2` | `QUALITY_GATE_FAILURE` | Whoever set the rule. Every test was within tolerance. |
| `3` | `CONFIGURATION_ERROR` | Whoever edited the pipeline. A missing project, a bad flag. |
| `4` | `AUTHENTICATION_ERROR` | Whoever holds `AIRA_TOKEN`. Rotate or re-issue it. |
| `5` | `INFRASTRUCTURE_ERROR` | The platform operator. **Nothing was measured.** |
| `6` | `SECURITY_POLICY_VIOLATION` | Read the reason. **Do not widen permissions.** |
| `7` | `HUMAN_REVIEW_REQUIRED` | A person. Not a failure. |
| `8` | `AIRA_INTERNAL_ERROR` | Whoever maintains AIRA. Not your application. |

## "One or more validation errors occurred"

The request could not be bound at all, so none of AIRA's own validation ran and the message
says nothing useful. Almost always an empty string where an id was expected:

```bash
AIRA_ENVIRONMENT_ID= aira schedule add …    # exported and empty
```

Unset the variable rather than setting it empty. The CLI treats blank as absent for its own
flags; a raw `curl` does not.

## A run says `blocked`, not `failed`

The test never produced a verdict. Usually one of:

- **Sign-in failed**, so the journey could not start. Check the application's credentials
  and that the secret they reference exists in the environment.
- **The target was refused** by the authorization boundary. The execution's error message
  names the host and the allowlist.
- **No worker picked it up.** Check `scripts/worker-ctl.sh status`.

Blocked is deliberately not `failed`: nothing was learned about the application, and
reporting it as a failure would send somebody to debug working code.

## A run is stuck `running`

A worker claimed it and stopped reporting. The platform ends stranded executions after ten
minutes by default (`Execution:StrandedAfterMinutes`) with a message saying so. If it
happens repeatedly, check worker memory and the browser pool.

## A schedule stopped running

```bash
aira schedule list
```

A schedule that failed three times in a row disables itself and stores why:

```
off  Nightly regression  7d0c…
     Disabled after 3 consecutive failures. Last reason: it matched no tests
```

Re-enabling clears the count. Common causes: the tag no longer matches any test, the
environment was deleted, or the environment is production and its authorization was
withdrawn.

`aira schedule preview <id>` shows the next few fire times — worth checking before assuming
the runner is broken. A cron expression that means something other than what was typed is
more common than a broken scheduler.

## Visual checks report a difference every run

Something on the page changes on its own. Mask it:

```json
{"mask": ["[data-testid=\"generated-at\"]"]}
```

Two things to know:

- The region must exist in the baseline too. Masking an element the baseline never had adds
  a block of colour where the baseline has content, making the difference *bigger*.
- If the whole page is reported as different, check whether the viewport or browser changed.
  A baseline is per browser and per viewport, and comparing across either is a difference
  on every run.

If nothing on the page should change and it still reports differences, raise
`maxDifferencePercent` rather than switching the check off — and record why you raised it.

## Accessibility reports violations that were not there yesterday

Check the axe version in the result's `engine` field. A new rule set catches more, which is
a real finding rather than a regression in your page.

If you need to not fail on it today, use `"failOn": null` to keep measuring without
enforcing, rather than removing the step. The numbers stay in the report and the build stops
failing until the team chooses.

## A notification never arrived

```bash
curl "$AIRA_API_URL/api/v1/integrations/deliveries?runId=<id>" -H "authorization: Bearer $AIRA_TOKEN"
```

Every attempt is recorded with the receiver's own answer. Common causes:

- A `4xx` from the receiver — it rejected what was sent and will again.
- The URL was refused by the target policy. A webhook is an outbound request and goes
  through the same SSRF controls as everything else.
- The integration is subscribed to no events. An explicit empty `events` list means none.

Nothing was delivered and nothing failed the run: a channel being down never turns a
passing run into an errored one.

## A test fails only sometimes

Check whether its data is seeded. An unseeded generated field produces a different value
every run, and a test that fails on a boundary value will pass when re-run:

```bash
aira test-data preview <id>
```

A seeded field shows the same value every time. If it does not, that is a defect — report
it.

## Contract check says "no breaking changes" and a caller broke

Check whether a baseline existed. A check with nothing to compare against is skipped rather
than reported as clean — `report.json` carries `contracts: null` in that case, which is a
different statement from zero.

## The platform is up and every run fails at exit 5

`5` means AIRA could not be reached or used. Check, in order: the API's health endpoint,
Redis (the job queue), PostgreSQL, and whether any worker is connected. A worker that
cannot reach the control plane logs it on startup.

## See also

[The `aira` command](cli.md) · [Environments](environments.md) ·
[Quality gates](quality-gates.md) · [Setup](setup.md)

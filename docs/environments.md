# Environments

Where an application is deployed, and whether QA NXT may touch it.

```bash
qanxt environments                     # list them
export QANXT_ENVIRONMENT_ID=…          # which one a run targets
```

An environment carries four things a run needs, and omitting one is not the same as having
none:

| | |
| --- | --- |
| `baseUrl` / `apiBaseUrl` | Where the deployment is. |
| `allowedDomains` | What QA NXT may open. The authorization boundary. |
| `rateLimitPerMinute` | How hard it may be driven. |
| `isProduction` | Whether it is refused by default. |

**A run with no environment falls back to the application's own URL and applies none of
these.** That is worth stating plainly because it looks like a harmless omission: the run
works, the report looks normal, and nothing says the allowed domains and the rate limit
were never in play. Set `QANXT_ENVIRONMENT_ID` even when a project has one environment.

## Production is refused by default

Two separate things must be true before QA NXT will test a production environment:

1. The environment is marked production.
2. Somebody has authorized testing on it, **with a note saying why**.

```bash
curl -X POST "$QANXT_API_URL/api/v1/environments/$ID/authorize-production" \
  -H "authorization: Bearer $QANXT_TOKEN" -H 'content-type: application/json' \
  -d '{"authorized":true,"note":"Read-only smoke test, agreed with the platform team."}'
```

One switch would be easy to flip by accident, and the cost of that mistake is paid by real
customers. The authorization is recorded in the audit trail with who, when and on what
grounds.

Until then:

```
403  security_policy
     Environment 'prod' is production and testing it has not been authorized.
     Authorize it explicitly with POST /api/v1/environments/{id}/authorize-production,
     with a note saying why.
```

The CLI reports this as exit `6`, not `4`. A rejected token is resolved by rotating a
credential; this is not, and a team told it lacks permission will try to fix it by widening
the service account — which cannot change the answer and removes a control that just did
its job.

It is checked **when a run is asked for**, not only when the environment was configured.
A schedule pointed at unauthorized production is refused when somebody creates it, at the
keyboard, rather than failing silently at three in the morning.

Destructive tests cannot be enabled on a production environment at all.

## The authorization boundary

`allowedDomains` is the primary SSRF control. Every URL QA NXT opens goes through it: the
seed URL, every discovered link, every redirect target, every API request, and every
outbound notification webhook.

Three things are refused regardless of configuration:

- Cloud metadata endpoints (`169.254.169.254` and friends).
- Link-local addresses.
- Credentials embedded in a URL.

Private ranges are refused unless the deployment sets `ALLOW_PRIVATE_NETWORK_TARGETS`,
which exists for a developer pointing QA NXT at an application on their own machine.

A deployment can also set a **global allowlist** that confines every project in it. A
project cannot widen that by editing its own application configuration.

## Disabling one

```bash
curl -X PATCH "$QANXT_API_URL/api/v1/environments/$ID" \
  -H "authorization: Bearer $QANXT_TOKEN" -H 'content-type: application/json' \
  -d '{"isEnabled":false}'
```

A disabled environment refuses runs with the same security code as an unauthorized
production one. Useful while a deployment is being rebuilt: tests fail loudly with a reason
rather than quietly against a half-built application.

## Secrets

An environment holds encrypted secrets, referenced from test data by name:

```json
{"key": "password", "kind": "secretReference", "value": "${secret:app_password}"}
```

The reference names a secret; it never contains one. Nothing returns a secret's value —
not a read, not a preview, not an export. See [Test data](test-data.md).

## See also

[Test data](test-data.md) · [Running from a pipeline](ci-cd.md) ·
[Scheduled regression](scheduling.md) · [The `qanxt` command](cli.md)

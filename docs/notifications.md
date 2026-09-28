# Notifications

A run that fails at two in the morning and tells nobody is a run that did not happen.

```bash
# A webhook of your own
curl -X POST "$QANXT_API_URL/api/v1/integrations" \
  -H "authorization: Bearer $QANXT_TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"…","kind":"webhook","name":"Team channel",
       "settings":{"url":"https://hooks.example.com/qanxt"},
       "credentials":{"signingSecret":"…"}}'

# Find out whether it works, before you need it to
curl -X POST "$QANXT_API_URL/api/v1/integrations/<id>/test" -H "authorization: Bearer $QANXT_TOKEN"
```

## What gets sent, and what does not

| Event | Sent by default | |
| --- | --- | --- |
| `runFailed` | yes | One or more tests failed. |
| `qualityGateBlocked` | yes | Everything was within tolerance and a rule stopped it, or asked for a person. |
| `breakingContractChange` | yes | A contract check found a breaking change against the baselines. |
| `scheduleDisabled` | yes | A schedule turned itself off after repeated failures. |
| `runPassed` | **no** | A run finished clean. |

A green build is not news. A channel that posts every success is one nobody reads by the
second week, and the failure they needed scrolls past with it. `runPassed` exists because
some teams genuinely want a heartbeat from the nightly, and it has to be asked for:

```json
{"settings": {"url": "…", "events": "runPassed,runFailed"}}
```

An explicit list replaces the defaults rather than adding to them. An **empty** list means
none, which is a legitimate thing to configure — it keeps the integration in place,
credentials and all, while somebody fixes a noisy channel.

One run produces one message, not one per condition. A run that failed tests *and* was
blocked by the gate is a single event to a reader; failure wins, because "three tests
failed" is the more actionable sentence and the gate's reasons travel in the body anyway.
A breaking contract change is the exception and gets its own message, because it reaches a
different audience — whoever owns the callers of that API, who may not be watching this
project's runs at all.

## What a message contains

A verdict, some counts, and a link. Never evidence, never a credential, never a header.

```json
{
  "schemaVersion": 1,
  "event": "RunFailed",
  "severity": "Problem",
  "title": "3 test(s) failed in Checkout",
  "body": "The quality gate failed on 1 rule(s): Pass rate.",
  "project": { "id": "…", "name": "Checkout" },
  "run": { "id": "…", "name": "Nightly regression" },
  "url": "https://qanxt.example.com/runs/…",
  "facts": { "passed": 17, "failed": 3, "blocked": 0, "healed": 1, "flaky": 0,
             "qualityGate": "Fail", "branch": "main", "commit": "a1b2c3d4" },
  "sentAt": "2026-09-22T02:14:07Z"
}
```

Anybody who needs more than this follows the link and authenticates like everybody else.
That is deliberate: a webhook URL is a bearer credential in practice — anyone who learns it
receives everything sent to it — so what is sent has to be safe for whoever ends up with
the URL.

`schemaVersion` is there so a receiver can branch instead of breaking. A message about no
particular run has no `run` object at all rather than one full of nulls.

## Signing

Configure a `signingSecret` and every delivery carries `X-QaNxt-Signature`:

```
X-QaNxt-Signature: sha256=<hex hmac of the exact body>
```

Same shape GitHub uses, so a receiver can reuse code it already has. Verify it with a
constant-time comparison:

```js
const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
if (!timingSafeEqual(Buffer.from(header), Buffer.from(expected))) return reject();
```

Verify against the **raw body**, before any JSON parsing and re-serialising — a
round-trip changes the bytes and the signature will not match.

The secret is stored encrypted, never returned by the API, and never appears in a payload.
The signature is derived from it and is not it.

## Settings and credentials are different dictionaries

`settings` are returned to anyone with read permission on the project. `credentials` are
encrypted at rest and never returned by anything.

Putting a secret in `settings` is refused rather than quietly moved:

```
400  signingSecret looks like a credential and settings are readable by anyone who can
     view this project. Send it in "credentials" instead, where it is encrypted and
     never returned.
```

Refusing beats relocating, because the caller has already sent the secret somewhere it did
not intend and should know that.

## A webhook is an outbound request, and is treated as one

"POST to a URL the user supplies" is an SSRF primitive. Left unguarded, "configure a
webhook" becomes "ask QA NXT to fetch a URL inside its network and tell me what it said",
which is far more useful to an attacker than a notification.

So every delivery goes through the same target policy as every URL QA NXT opens:

- Cloud metadata addresses are refused, always, whatever the configuration.
- Link-local and private ranges are refused unless the deployment allows private networks.
- The deployment's global allowlist applies, and a project cannot widen it.
- The check happens **at send time**, not only when the integration was saved — the
  allowlist is deployment configuration and can change afterwards.
- **Redirects are not followed.** A receiver that answers 302 is pointing the request
  somewhere the policy never checked.

## When a delivery fails

It is recorded, and it never fails the run.

```bash
curl "$QANXT_API_URL/api/v1/integrations/deliveries?runId=<id>" -H "authorization: Bearer $QANXT_TOKEN"
```

```json
[{ "event": "RunFailed", "channel": "Webhook", "delivered": false,
   "statusCode": 500, "detail": "The receiver answered 500 Internal Server Error.",
   "attemptedAt": "2026-09-22T02:14:08Z" }]
```

"Did anyone actually get told?" is a question that gets asked after an incident, and "the
code calls Send" is not an answer. A notification that silently fails is worse than none,
because the team has stopped watching the thing it was supposed to watch for them.

A Slack outage must not turn a passing run into an errored one, so a channel being down is
an ordinary recorded outcome rather than an exception that propagates.

## Slack

Mechanically the same thing: an incoming webhook is a URL you POST JSON to, and the URL is
itself the credential, so it goes in `credentials` rather than `settings`.

```json
{"kind":"slack","name":"#quality","credentials":{"webhookUrl":"https://hooks.slack.com/services/…"}}
```

**What is verified and what is not.** That QA NXT builds the payload and delivers it is
executed against a local receiver in the golden suite. That a real Slack workspace renders
it as intended is **not verified** — it needs a workspace and a webhook URL, and this
repository has neither. The Block Kit structure is written against Slack's documented
schema and is not claimed to have been posted to Slack.

The message always carries a plain `text` fallback alongside its blocks. Blocks with no
text are silent on a phone and to a screen reader, and a phone is the one place a failed
nightly actually needs to arrive.

## Verification

```bash
node verification/golden-tests/run.mjs --suite notifications
```

Eight tests (NOT-001…NOT-008) against `test-lab/notification-sink`, a real HTTP server that
keeps what it receives. It is not a mock of Slack and does not pretend to be any particular
service: what it licenses is a claim that QA NXT sent a request, that the body had a given
shape, that the signature verified, and that a receiver answering 500 or hanging is handled
the way the code says.

NOT-005 is the one that matters most. It scans **the bytes that were sent** for the signing
secret, the application's password and the session token, rather than inspecting the code
that built them.

Building this found **BUG-0031**: a run could finish twice. Two executions completing in
the same moment both saw every execution as terminal and both ran the whole completion
block — contract check, quality gate, completion event and notification, all twice. It
predates notifications; the duplicate message is what made it visible.

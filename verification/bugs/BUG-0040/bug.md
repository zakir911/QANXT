# BUG-0040 — A discovered endpoint recorded the latest status with the first response body

| | |
| --- | --- |
| **ID** | BUG-0040 |
| **Title** | The crawler updated an endpoint's status code on every repeat observation but kept the response sample from the first, so an endpoint seen signed-out and then signed-in was recorded as `200` carrying the `401` body — and every contract check against that baseline reported a false breaking change |
| **Severity** | **MEDIUM** |
| **Found by** | The continuous-quality demonstration: after the injected fault was cleared, one breaking contract change persisted and held the quality gate red |
| **Environment** | See `verification/environment.md` |
| **Build** | `7f50d74` |
| **Component** | `apps/browser-worker/src/discovery/crawler.ts` (`recordApiCall`) |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```ts
const existing = this.apiEndpoints.get(key);
if (existing) {
  existing.timesObserved += 1;
  existing.statusCode = response.status();   // updated
  return;                                     // …and the sample is not
}
```

The first observation of an endpoint sets `responseSample`. Every later one updates
`statusCode` and returns before touching it. So the two fields drift apart the moment an
endpoint answers differently twice.

The banking lab's `GET /api/session` does exactly that, correctly:

```
$ curl -s -o body -w 'status %{http_code}\n' http://localhost:4300/api/session
status 401
{"error":"unauthenticated"}
```

and `200 {"user": …}` once signed in. A crawl sees the signed-out call first. The endpoint
was therefore stored as **status 200 with the 401 body**, which the baseline inherited:

```
07. Release 1.0 goes out
    13 contract baseline(s) captured from responses the application actually gave
      GET http://localhost:4300/api/session → status 200, 2 field(s)
```

Two fields, one of them `error` — from a response that never had status 200.

## Why it matters

Every later contract check compared real success responses against an error body, and
reported the absence of `error` as breaking:

```
12. The contract check finds what moved
      GET …/api/accounts  $.accounts[].sortCode: … was present as string and is now absent.  ← real
      GET …/api/session   $.error: "error" was present as string and is now absent.          ← false
```

The false one outlived the fix and kept the gate red on a green build:

```
17. Fix it
    run passed: 3 passed, 0 failed
    gate outcome: FAIL
      still blocking — No breaking API changes: measured 1 against 0
```

A contract check that reports a breaking change because an endpoint *started working* is one
a team stops reading, and a gate that stays red after a real fix is one they switch off. It
also cuts the other way: a baseline paired with the wrong status can mask a real change.

## Fix

Keep the status and the sample describing the same response, and prefer a success:

```ts
const existingIsSuccess = existing.statusCode !== undefined
  && existing.statusCode >= 200 && existing.statusCode < 300;
if (isSuccess || !existingIsSuccess) {
  existing.statusCode = status;
  existing.responseSample = responseSample;
  existing.responseContentType = contentType || undefined;
}
```

A success response wins and is not displaced by a later failure: a baseline is meant to
describe what a caller gets when the endpoint works, and a 401 picked up while crawling
signed-out pages is not that. Otherwise the most recent observation wins, so an endpoint only
ever seen failing is still recorded honestly rather than left with a stale sample.

The body is now read before the `existing` lookup, since it is needed on both paths.

## A related fix, and a correction

While diagnosing this I also changed `ApiContractComparer` to stop comparing fields once the
status *class* has changed (2xx versus not), on the grounds that an error body and a success
body are different contracts. That change is right and is covered by two unit tests —

```
Stops_comparing_fields_once_the_status_class_has_changed   401 → 200: one difference, $status, NonBreaking
Still_compares_fields_when_both_responses_succeeded        200 → 201: sortCode still Breaking
Passed! - Failed: 0, Passed: 17 (ApiContract*)
```

— but it did **not** fix this defect, and my first write-up of BUG-0040 wrongly said it had.
It could not have: the stored pair was (200, error-body), so both sides looked like successes
and the guard correctly did not apply. The comparer change is retained on its own merits; the
root cause is the crawler.

## Re-verification

The unit tests above, plus the worker suite (99 passed), and the demonstration end to end:
the `GET /api/session` baseline now records the signed-in `200 {"user": …}` response, no
false breaking change is reported, and the gate opens after the fix.

## A note on how this was found

The contract suite (CON-001…CON-014) passes and always has: every case compares a success
against a success, because that is how the lab's faults are built. Nothing in it observes an
endpoint twice with different statuses. This only surfaced from running a whole release cycle
end to end, where a crawl happens for its own reasons and sees an application in more than
one state.

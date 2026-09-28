# Test data

The values a test uses, and whether they can be relied on.

```bash
qanxt test-data import --file checkout-customer.json
qanxt test-data preview <id>      # what a run will actually use
qanxt test-data export <id> --out checkout-customer.json
```

## The file

```json
{
  "name": "Checkout customer",
  "description": "One customer, the same every run",
  "fields": [
    { "key": "customerEmail", "kind": "seededRandom",
      "generatorJson": "{\"type\":\"email\"}", "seed": 42 },
    { "key": "orderReference", "kind": "static", "value": "QANXT-TEST-001" },
    { "key": "password", "kind": "secretReference", "value": "${secret:app_password}" }
  ]
}
```

| Kind | |
| --- | --- |
| `static` | A literal value. |
| `generated` | From the generator, different every run. |
| `seededRandom` | From the generator, the same every run. Needs a seed. |
| `secretReference` | Names a secret in the environment's storage. Never holds one. |

A field with no generator spec is inferred from its own name — `customerEmail` produces an
email address, `deliveryPostcode` a postcode. That is what makes a generated test usable
without anybody configuring it.

## Why a seed

**A seeded field produces the same value on every run.** That is the only reason a seed
exists, and it matters more than it sounds.

Without it, a test that fails on a boundary value passes when you re-run it, and the
investigation ends in "could not reproduce". Worse, QA NXT's own retry would exercise
different data from the attempt that failed — so the retry proves nothing about the
failure, and a green retry looks like a flake that has gone away.

```bash
$ qanxt test-data preview 7d0c…
customerEmail            qanxt.tomas.2268@example.test
orderId                  f604634b-6295-48e1-bf41-99ea1fb201b0
password                 ${secret:app_password}
```

Run it again tomorrow and those are the same values. Checking a data set by looking at it
beats running a test and inferring the values from a screenshot.

Every generator type honours this, and the test that says so enumerates the types rather
than listing them — so a type added later is covered without anybody remembering. That is
not decoration: `uuid` ignored its seed for a long time, and `date` was generated relative
to today, so a seeded date was stable within a day and different the next (**BUG-0032**).

## Credentials are never literals

A field whose name is a credential — `password`, `apiKey`, `clientSecret`, `pin` — must be
a `secretReference`. Submitting a literal is refused:

```
400  "password" looks like a credential. Store it in the environment's secret storage and
     reference it here with kind "secretReference" and value "${secret:password}" —
     a data set is readable by anyone who can read the project.
```

A data set is readable by anyone with read permission on the project and is exported in
plain text by `qanxt test-data export`. A literal password in one is a password in a
repository.

Declaring the kind is not a way round it: a `secretReference` whose value is not
`${secret:name}` is refused too.

The match is on **whole words**, never substrings. `shippingAddress` contains "pin",
`authorName` contains "auth", and a guard that refuses a shipping address is one people
learn to route around — which is worse than not having it.

Nothing ever returns a sensitive value. A secret reference is shown by name, because seeing
`${secret:app_password}` is how you check it points at the right secret. Anything else
marked sensitive comes back redacted, from the read and the preview alike.

## Attaching a data set to a test

```bash
curl -X PATCH "$QANXT_API_URL/api/v1/testcases/<id>" \
  -H "authorization: Bearer $QANXT_TOKEN" -H 'content-type: application/json' \
  -d '{"testDataSetId":"<data-set-id>"}'
```

An empty guid detaches it. The data set has to belong to the same project: one from
elsewhere would resolve to values nobody here has seen, and the failure would look like an
application defect.

Until recently nothing could do this except AI generation, so a data set could be created,
listed and previewed and never used (**BUG-0033**).

## Deleting one

Refused while a test case still uses it:

```
409  1 test case(s) use this data set. Point them elsewhere first — deleting it would
     leave them running with no data, which reads as an application defect.
```

Cascading would be quieter and much worse: the tests keep running, silently get nothing,
and fail in a way that sends somebody to look at the application.

## Verification

```bash
node verification/golden-tests/run.mjs --suite test-data
```

Eight tests (DAT-001…DAT-008). DAT-002 is the one that matters most: it asks the platform
which generator types it supports, builds a seeded field for **every** one, previews twice
and requires every value to match — so a type added later cannot quietly opt out.

DAT-005 scans the response bodies for a sensitive value rather than checking a parsed
field, which is the difference between "the field says redacted" and "the secret is not in
the response".

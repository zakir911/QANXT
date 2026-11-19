# What a QA or security expert does, and what QA NXT does

This maps the work a human QA engineer and a human penetration tester actually do onto the
checks this product can make, measured against a synthetic application built for the
purpose: **Meridian Freight**, 150 crawled pages across 13 business domains, with **32
defects planted deliberately** and written down before any measurement
(`test-lab/freight-platform/ground-truth.json`).

It exists because "0 of 32 detected" is a number, not a diagnosis. The useful question is
which *kind* of check was missing, and whether the answer is "build it", "feed it", or
"a person has to decide this".

Status words, used strictly:

- **covered** — an oracle exists, is emitted by a designer, and has been seen to fail on
  the defect it is for.
- **built, not yet measured** — the oracle and the tests exist and pass against a lab, but
  it has not yet been run against Meridian Freight.
- **needs input** — the capability exists and something has to be supplied: an identity, a
  credential, a declared rule.
- **out of reach** — not detectable from the application alone. Named, not hidden.

---

## The classes of check, and where this product stands

| Class | What a human does | QA NXT | Status |
| --- | --- | --- | --- |
| Field validation | Try the value the field should refuse | 11 form oracles, constraints read from the DOM | covered |
| Boundaries | On, either side of, and past every declared limit | 6 cases per numeric and length limit | covered |
| Cross-field rules | Dates out of order, mismatched confirmations | ~30 ordered-pair vocabulary, dependency probing | covered |
| **Server-side enforcement** | **Submit past the browser with curl** | **`assertServerEnforces`** | **built, not yet measured** |
| Accessibility | Keyboard, labels, error association, focus | axe-core plus `assertErrorAssociated`, `assertFocused` | partly covered |
| **Colour as the only channel** | **Ask what the status column says in greyscale** | **`assertNotColourOnly`** | **built, not yet measured** |
| Responsive | Resize and look for overflow | `assertNoHorizontalScroll` at 390px and 768px | covered |
| Injection reflected in a page | Put a tag in a field and see if it renders | `assertNoMarkupInjection` | covered |
| Error handling | Make it fail and watch what leaks | `assertNoServerError`, stack-trace detection | partly covered |
| Performance | Notice the page that hangs | `assertLoadTimeUnder` | covered |
| Idempotency | Press Submit twice | `assertRequests` with a max count | covered |
| Authorization | Sign in as each role and try everything | 24 security checks, 5 authz families | needs input |
| Passive security | Read headers, cookies, URLs | 5 passive families | needs input |
| Business rules | Know what the application is for | — | out of reach without a spec |
| Calculations | Check the arithmetic against the specification | — | out of reach without a spec |

## The 32 planted defects

### Covered, and seen to be found

| Defect | Class | Oracle |
| --- | --- | --- |
| FP_D22 error not associated with its field | accessibility | `assertErrorAssociated` |
| FP_D25 rate table overflows at 390px | responsive | `assertNoHorizontalScroll` |
| FP_D26 route planner fixed at 1100px | responsive | `assertNoHorizontalScroll` |
| FP_D28 reflected XSS in search | security | `assertNoMarkupInjection` |

Each of these was found by the form-level engine on a ten-page smoke run, with evidence,
and FP_D28 was correctly ranked as the most severe of the four.

### Built this session, not yet measured against the lab

| Defect | Why it was missed | What now addresses it |
| --- | --- | --- |
| FP_D05 credit limit checked on the form, not in the handler | every test went through the DOM | `assertServerEnforces` |
| FP_D17 a rejected declaration can be released | the UI does not offer the action, so nothing tried it | `assertServerEnforces` |
| FP_D11 a viewer can settle a claim | hidden from the viewer, not refused | `assertServerEnforces`, and `authz.readonly` with an identity |
| FP_D23 vehicle status conveyed by colour alone | axe checks contrast, not whether colour is the only channel | `assertNotColourOnly` |

The oracle sends the submission the browser just refused straight to the form's action,
with the session's own cookies, and asks for the refusal again. It is emitted only after a
step has shown the browser refusing — on its own, a server accepting a value nothing
objects to is an unconstrained field, not a defect.

One caution about this table, learned the hard way. The first attempt to measure these
generated 398 server-enforcement steps whose form locator named a strategy the worker's
resolver does not know, so each resolved to nothing and the oracle fell back to the first
form on the page. A wrong submission gets refused, and this oracle reads a refusal as the
server enforcing the rule — so all 398 would have *passed*, and "built, not yet measured"
would have become "covered" on the strength of a check that never ran. That is why
`preflight-suite.mjs` now runs before execution and why nothing moves to **covered** here
without a failure observed on the defect it is for.

### Needs an identity or a credential supplied

| Defect | Check that covers it | What is missing |
| --- | --- | --- |
| FP_D12 any user can read any shipment | `authz.bola` | two identities in different tenants |
| FP_D13 legacy API key with every scope | `authz.token` | an authenticated session on the admin screen |
| FP_D30 session cookie without HttpOnly | `passive.cookies` | the remember-me sign-in path |
| FP_D31 stack trace in an API error | `passive.sensitive-data` | an API error to trigger |
| FP_D32 customer email in the query string | `passive.sensitive-data` | a contact search to perform |
| FP_D29 no anti-forgery token on adjustment | — | a CSRF check; the form model already records `hasCsrfToken` |

The 24 security checks exist and are implemented. They were never a gap in capability; they
were a gap in *supply*. Nothing had given the scanner the three identities the lab defines
(`admin`, `ops.lead`, `readonly`), so the authorization families had nothing to compare.

### Classes with no oracle yet, ranked by what they would catch

1. **Round-trip persistence** — what you entered is what is shown back. Catches FP_D03,
   where the weight unit selector is recorded and never applied. A human checks this every
   time they fill a form; the engine never reads the result page.
2. **Displayed-count consistency** — a count label must equal the rows it counts. Catches
   FP_D10, where the result count is taken before the filter.
3. **Uniqueness** — submit the same reference twice. Catches FP_D04.
4. **Multi-step state retention** — forward, then back, and the fields still hold. Catches
   FP_D15.
5. **Dialog behaviour** — role, focus moved in, Escape closes, focus returns. Catches
   FP_D24. axe does not check focus management.
6. **Cross-entity state after an action** — cancel a shipment, then look at the route it
   was on. Catches FP_D14. The hardest of these: it needs to know the two screens are
   related, which the discovery graph may already be able to say.

### Out of reach, and why

| Defect | Why |
| --- | --- |
| FP_D06 fuel surcharge applied to the VAT-inclusive total | the application is internally consistent; only a specification says 11.5% of the *freight* line |
| FP_D08 duty excludes freight on a CIF shipment | same: CIF means freight is included, and that is domain knowledge, not an observable |
| FP_D07 rate band boundary does not step | the bands are stated on a card the engine cannot read as a rule |
| FP_D09 credit note exceeds the invoice | needs the invoice total, which lives on another screen |
| FP_D20 invoice whose shipment was removed crashes | needs a dangling reference to be created first |

These are the honest limit. A tool that reported them would be guessing, and a guess that
happens to be right is worse than a gap, because it teaches you to trust the next guess.
Where a rule can be *declared* — the product supports business rules as input — these
become reachable; that is the supported path, and it is a person's decision, not an
inference.

### A knowing exclusion

FP_D19, an oversize upload crashing, is unreachable because the engine deliberately does
not fill file inputs. That was a fix for tests that filled a file input with text and
failed on the tool's own error. The cost is this defect, and it is recorded here rather
than quietly absorbed.

FP_D18, a search term over 500 characters returning a 500 with file paths, is reachable in
principle — `assertNoServerError` would catch it — but the length battery tries 256
characters. **It has not been raised to 501.** Sizing a test value to a defect I planted
myself would be fitting the product to the measurement, and the resulting "detected" would
mean nothing. If a length boundary battery should go past 500 as a general matter, that is
a decision to argue on its own merits.

---

## What this says about the product

The pattern across every line above: the capability is usually built, and the thing feeding
it is too narrow. A seven-word date vocabulary that missed "collection"/"delivery". An
identity list nobody supplied. A planner never given the form's locator. A select chooser
blind to the other selects on the same form. A crawl budget nothing set. Twenty-four
security checks with no one to be.

The exception, and the one real capability gap, was asking the server anything at all.
Every test the engine wrote went through the DOM, so a rule enforced in the browser alone
looked enforced. That is now `assertServerEnforces`, and it is the check that most changes
what this tool is: a form tester becomes something that tests the application behind the
form.

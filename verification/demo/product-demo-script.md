# Product demonstration

Recorded 2026-09-21T12:24:31.928Z against AIRA Demo Bank 1.0.0.

Reproduce with:

```bash
./scripts/run-product-demo
```

Everything below happened in one pass. The test that heals and then fails is the same test
throughout — it is never edited between runs, and `TC-0004` can be
read in the console to confirm that.

| Step | What happens | What to look for |
| --- | --- | --- |
| 1 | Check the platform and the application under test are up | AIRA: healthy |
| 2 | Create an organisation, a project and register the application | project GD4SB1Z, application af23b77c-d67b-41a6-9ad9-05bb2b9cb5e5 |
| 3 | Discover the application | crawl completed in 20s |
| 4 | What discovery found | /login                     7 elements  public   login |
| 5 | Generate tests from a sentence | "Customer can login and download account statement." |
| 6 | Execute a generated test | AIRA Demo Bank /dashboard loads: passed (2/2 steps, 3974ms) |
| 7 | Execute the statement journey the demonstration is about | TC-0004: passed (9/9 steps, 1036ms) |
| 8 | Change the application underneath the test | FAULT_LOGIN_BUTTON_RENAMED: the sign-in control is relabelled "Sign In" and its test id changes |
| 9 | Re-run the same test, unedited | passed: 1 healing event(s) |
| 10 | The stored test was not rewritten | the stored step still targets {"strategy":"testId","value":"login-submit","exact":false,"fallbacks":[]} |
| 11 | Collect the evidence for that run | screenshot   final.png (103613 bytes) |
| 12 | Remove the control entirely | FAULT_LOGIN_BUTTON_REMOVED: nothing on the page submits the form |
| 13 | Re-run the same test again, still unedited | failed: 3/9 steps |
| 14 | What the platform says about the failure | category: locatorChange at 65% confidence |
| 15 | Evidence for the failed run | screenshot   final.png (326830 bytes) |
| 16 | Put the application back and confirm the test passes again | passed (9/9 steps) |
| 17 | Write the demonstration record |  |

## The three runs that matter

| | Application | Verdict | What the platform did |
| --- | --- | --- | --- |
| Baseline | unchanged | **passed** | 1036ms, no healing needed |
| After the rename | sign-in control relabelled and re-identified | **passed** | applied at 79% |
| After the removal | no control submits the form | **failed** | 0 heals applied; classified `locatorChange` |

The middle row is the capability. The bottom row is the safety property: with nothing on the
page that performs the function, the platform failed the run rather than finding something
that looked close enough.

## Evidence

| Artifact | Where |
| --- | --- |
| Video of the healed run | `verification/demo/product-demo.webm` |
| Full record of the demonstration | `verification/demo/product-demo.json` |
| Artifacts of the healed run | screenshot, video, trace, consoleLog, networkLog |
| Artifacts of the failed run | screenshot, screenshot, video, trace, domSnapshot, accessibilityTree, consoleLog, networkLog |

## What the platform said about the failure

> The failing step could not find the element it needed.
>
> The element is absent from the page. Either the UI changed and the locator is stale, or an earlier step left the application somewhere other than the expected page.
>
> **Suggested action:** Compare the failure screenshot with the expected page. If the page is right but the element moved, update the locator; if the page is wrong, the failure is earlier in the journey.

Produced by local (deterministic rules — no model provider is configured in this environment).

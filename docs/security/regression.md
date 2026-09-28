# Security regression

The question a team actually asks is not "what did the scanner find" but "what changed".

## Finding identity

A fingerprint over **application, category, endpoint, parameter and observed role**.

Deliberately not: severity (the model can revise it), title (it can be reworded), payload (it
varies between runs), or any response value. A fingerprint including those would report a new
finding every time anything was rephrased, and a team that sees a wall of new findings every
run stops reading them.

`SECB-001` asserts both directions: the same finding reworded and re-scored matches; a
genuinely different finding does not.

## What a comparison produces

| | |
| --- | --- |
| **new** | not in the baseline |
| **regressed** | in the baseline as `Resolved`, and detected again |
| **carried forward** | in the baseline and still open — the triage decision comes with it, the severity does not |
| **notReproduced** | in the baseline, absent now, and the check that found it **did run** |
| **notObserved** | in the baseline, absent now, and the check did not run — or nobody recorded which checks ran |

## Absence is never a fix

This is the rule the brief cares most about, and it is enforced at the only place that could
break it.

A finding that is absent from this scan is `notObserved`, or `notReproduced` where the check
actually ran. Neither is `Resolved`. The check may have been refused by scope, the endpoint
may have been unreachable, the scan may not have run that check this time — and calling any of
those "fixed" is how a security regression gets hidden.

`notReproduced` carries the sentence: *"The check that found this ran again and did not
reproduce it. That is grounds for a person to mark it resolved; it is not a resolution on its
own."*

`SECB-002` and `SECB-003` assert both cases.

## Self-healing cannot touch a security finding

QA NXT's self-healing rewrites locators when a functional test breaks. It has no path to a
security finding's status, and the triage workflow refuses a suppression with no named human
decision-maker — which is what any automated attempt would produce.

`SECT-008` asserts it from both ends: an automated suppression is refused, and a finding the
scan did not reproduce stays `Confirmed`.

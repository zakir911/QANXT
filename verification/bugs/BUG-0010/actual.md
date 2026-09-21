# BUG-0010 — actual

```
assertValue  failed  Expected the value "" but found "100".
```

The value assertion failed in both attempts, on a field that held exactly what the test
asked for. The expectation reaching the browser was the empty string, because the
execution plan builds the action from the test step — which has no expected-value column —
and leaves the expectation on the assertion row beside it.

The same emptiness makes `assertText` and `assertUrl` pass vacuously at the action level.
Measured rather than assumed: with the wrong expected text and the wrong URL fragment the
runs still failed, because the paired planned assertion carries the expectation and is
evaluated afterwards. The action-level evaluation contributed nothing either way.

# BUG-0010 — steps to reproduce

1. Start the test lab and the AIRA stack.
2. Register the lab bank with form-login credentials.
3. Import a journey whose last step is `assertValue` on `filter-min` with the expected
   value `100`, after a step that fills the same field with `100`.
4. Execute the test case.
5. Read the execution: `GET /api/v1/executions/{id}`.

`reproduce.mjs` performs this twice, alongside a wrong-text and a wrong-URL assertion that
must both fail, so the fix cannot be "make every assertion pass".

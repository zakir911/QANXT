# BUG-0010 — expected

- `assertValue` passes when the field holds the expected value, and fails when it does not.
- `assertText` and `assertUrl` compare against the expectation the test declared, at both
  the action level and the assertion level.
- No assertion can pass because its expected value was empty.

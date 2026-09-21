# BUG-0007 — actual

```
discovery status:   failed
duration:           ~6.3s
pages discovered:   0
elements:           0
api endpoints:      1   (GET /api/session → 401, the page's own session check on load)
error:              Authentication failed: The browser is still on the login page with a
                    password field visible; the credentials are probably wrong.
```

What the application under test recorded for the same run:

```json
{
  "attempts": [
    { "at": "2026-09-21T03:05:55.847Z", "username": "alice", "passwordLength": 12 }
  ]
}
```

and the run's own `completedAt` is `2026-09-21T03:05:55.852Z` — five milliseconds later.

The platform sent the right credentials and judged the result before the answer came back.
The POST does not even appear in the discovered API endpoints, because the run tore the
browser context down before the response was recorded.

Reproduced in 2 of 2 scripted attempts, and in all four attempts made by hand beforehand.

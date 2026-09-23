# BUG-0036 — Piping any CLI command into `head` reported TEST_FAILURE

| | |
| --- | --- |
| **ID** | BUG-0036 |
| **Title** | A closed downstream pipe raised an unhandled EPIPE: the CLI printed a stack trace and exited 1, which its own contract defines as "one or more tests failed" |
| **Severity** | **MEDIUM** |
| **Found by** | CQ-9f, running `aira audit actions \| head -5` while smoke-testing the new command |
| **Environment** | See `verification/environment.md` |
| **Build** | `7f50d74` |
| **Component** | `packages/cli/src/aira.ts` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```
$ aira audit actions | head -1
  0  Login
node:events:497
      throw er; // Unhandled 'error' event
      ^
Error: write EPIPE
    at afterWriteDispatched (node:internal/stream_base_commons:159:15)
    …
    at out (file:///home/user/AIRA/packages/cli/dist/output.js:21:50)
Node.js v22.22.2

$ aira audit actions 2>/dev/null | head -1 >/dev/null; echo ${PIPESTATUS[0]}
1
```

`head` closes stdout once it has its lines. The next `out()` write raises EPIPE, nothing
handles it, and Node turns it into an unhandled `'error'` event.

## Why it matters

Exit `1` is not a generic failure in this CLI. It is `TEST_FAILURE`, documented as "one or
more tests failed — the application or its tests are the story". So

```yaml
- run: aira audit list --limit 200 | head -20
```

in a pipeline reports that the application under test is broken, when what actually happened
is that a shell command read fewer lines than were offered. That is the CLI telling a team a
lie about their software, which is the specific failure mode the whole exit-code design
exists to prevent.

It is CLI-wide, not specific to the audit command: any command writing more lines than its
reader consumes hits it. `aira status`, `aira projects` and `aira audit list` all can. It
surfaced here because `audit actions` writes 35 separate lines, so it triggers with a very
small `head`. Short-output commands appeared fine only because their whole output fitted in
one buffered write before the reader closed:

```
$ aira schedule --help 2>/dev/null | head -1 >/dev/null; echo ${PIPESTATUS[0]}
0
```

which is why this had gone unnoticed.

## Fix

One handler at the entry point rather than a guard at each write site, because there is a
single correct answer and it is the same everywhere — stop writing, and exit as though the
output had been delivered:

```ts
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(ExitCode.Success);
    throw error;
  });
}
```

`ExitCode.Success` and not a new code: from the pipeline's point of view nothing went wrong.
The reader asked for less than was on offer and got what it asked for. Only EPIPE is
swallowed; any other stream error still propagates.

## Re-verification

```
$ aira audit actions 2>&1 | head -1
  0  Login
pipeline exit=0

$ aira audit actions | wc -l
35                                  # unpiped output unchanged

$ aira audit actions 2>&1 >/dev/null | head -3
                                    # nothing on stderr
```

Three runs, exit 0 each time, no stack trace, full output intact when not piped.

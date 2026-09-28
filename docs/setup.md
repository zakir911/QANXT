# Setting up

> This is the short version, for people who already have .NET 8, Node 22 and PostgreSQL.
> If you are starting from a clean machine — or on **Windows or macOS** — use
> **[the installation guide](installation.md)** instead: same two paths, every step written
> out, with screenshots of what you should see.

Two ways in. Docker needs nothing but Docker; the native path is what you want if you are
going to change the code.

Either way you end up at <http://localhost:5173> with an empty platform, and the
[first run](#your-first-run) below turns it into a working one.

## With Docker

```bash
git clone <this repository> && cd qanxt
cp .env.example .env
```

Now set three values in `.env`. Generate them — do not invent them:

```bash
openssl rand -base64 48    # JWT_SECRET
openssl rand -base64 32    # ENCRYPTION_KEY   (must decode to exactly 32 bytes)
openssl rand -base64 32    # WORKER_TOKEN
```

The API refuses to start without all three. A platform that boots with a known signing key
is not secured by anything, so it says so rather than starting anyway.

```bash
make docker-up
```

That builds six images and starts the stack. The first build takes a few minutes; later ones
reuse the layers. See [deployment](deployment.md) for what starts, how to scale workers, and
what to change before a real deployment.

## Natively

You need .NET 8, Node 22, pnpm 10, and PostgreSQL 16 reachable on localhost. Redis is
started for you.

```bash
git clone <this repository> && cd qanxt
make setup
```

`make setup` checks every prerequisite up front and reports them together — discovering
three missing tools one failed command at a time is a miserable first five minutes. It then
copies `.env.example` to `.env`, **generates the three secrets for you**, installs
dependencies, starts PostgreSQL and Redis, and applies the migrations.

```bash
make dev
```

This runs the API, a browser worker, the console and the demo bank together, and stops them
all on Ctrl-C. Logs go to `/tmp/qanxt-*.log`.

| | |
| --- | --- |
| Console | <http://localhost:5173> |
| API | <http://localhost:5080> |
| API reference | <http://localhost:5080/swagger> |
| Demo bank | <http://localhost:4200> |

## Your first run

A fresh install has no accounts, so the console opens on a sign-in page that also offers to
create one.

1. **Create an organization.** Choose "Create an organization", and give it a name, your
   name, an email and a password of at least 12 characters containing letters and digits.
   The account you create administers the organization — somebody has to.
2. **Create a project.** Projects → New project. The key (`BANK`) is what the CLI and test
   references use, so keep it short.
3. **Register an application.** Applications → Add an application. Point it at
   `http://localhost:4200/dashboard` and give it the demo bank's credentials: username
   `alice`, password `Password123!`. They are encrypted before they are stored and never
   come back out of the API.
4. **Discover it.** Discovery → run it against the application. It crawls within the bounds
   you set and builds the knowledge graph everything else works from.
5. **Generate tests.** Test cases → Generate. With no model provider configured this uses
   the built-in deterministic planner, and says so on every result it produces.
6. **Run them.** Test runs → New run. Watch it live, then open an execution to see the
   screenshots, video, trace and network log it captured.

From there, [the agent](agent.md) will do steps 4 to 6 by itself, within bounds you set.

The demo bank has fault switches for trying the rest of the platform out:

```bash
curl -X POST http://localhost:4200/__control/scenario \
  -H 'content-type: application/json' \
  -d '{"renameFilterControls": true}'     # breaks a locator; watch self-healing propose a fix
```

`breakTransactionsApi` gives you a real application defect to watch the failure analysis
work on. `{"...": false}` puts each back.

## Configuration worth knowing

Everything is set through `.env`; `.env.example` documents each value. The ones that change
behaviour most:

| Setting | Default | What it does |
| --- | --- | --- |
| `AI_DEFAULT_PROVIDER` | `local` | `local` uses the built-in deterministic engines and needs no API key. Set `openai`, `anthropic` or `gemini` with the matching key to use a model. |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `true` | Lets the platform reach `localhost`, which the demo bank needs. **Turn this off for any real deployment** — it is what the SSRF guard otherwise prevents. |
| `AUTH_RATE_LIMIT_PERMIT_PER_MINUTE` | `10` | Sign-in attempts per client address. Raise it if a shared office address puts many real users behind one partition. |
| `WORKER_CONCURRENCY` | `2` | Executions one worker runs at once. Each browser wants about a gigabyte. |
| `LOG_LEVEL` | `Information` | Turn up to diagnose, down to quieten. |

## Checking it works

```bash
make test              # every suite that does not need a browser
cd tests/e2e && pnpm first-run   # walks the steps above in a real browser
```

`tests/e2e` has the rest: `console`, `cli`, `security`, `recorder` and `journey`. Its
[README](../tests/e2e/README.md) says what each one proves. Start the stack first.

## When it does not work

**`make setup` says a prerequisite is missing.** It names each one and where to get it.
Install them and run it again; it is safe to repeat.

**The API exits saying `JWT_SECRET must be at least 32 characters`.** The three secrets are
not set in `.env`. The Docker path does not generate them for you — see above.

**`make docker-up` fails with a missing variable.** Compose reads `.env` from beside the
compose file unless told otherwise. `make docker-up` passes `--project-directory .` for
exactly this reason; if you are running `docker compose` by hand, pass it too.

**A package restore fails inside a Docker build with a certificate error.** You are behind a
TLS-inspecting proxy. Drop its CA into `infrastructure/docker/certs/` and pass the proxy as
a build argument — [deployment](deployment.md) has the commands.

**Discovery finds nothing, or a run reports `blocked`.** The target is outside the
application's allowed domains, or it is a private address and
`ALLOW_PRIVATE_NETWORK_TARGETS` is off. The refusal names the reason, and the run says
`blocked` rather than `failed` because the test never got to run — that is not an
application defect.

**Everything is `blocked` and no worker appears.** Check `WORKER_TOKEN` matches between the
API and the worker, and that the worker can reach Redis. `curl localhost:9091/health` on the
worker tells you which of the two is wrong.

**The database is in a state you want rid of.** `make db-reset` drops it, recreates it and
re-migrates. It refuses to run against anything that is not a local host, and asks for the
database name first.

# Deploying with Docker

The whole platform runs from one compose file: a database, a queue, the control plane, a
browser worker, the web console and — for trying it out — the demo bank.

```bash
cp .env.example .env
# Set JWT_SECRET, ENCRYPTION_KEY and WORKER_TOKEN. Generate them, do not invent them:
#   openssl rand -base64 48   # JWT_SECRET
#   openssl rand -base64 32   # ENCRYPTION_KEY (must decode to exactly 32 bytes)
#   openssl rand -base64 32   # WORKER_TOKEN

make docker-up
```

Then open <http://localhost:5173>.

Without `make`:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --project-directory . up --build
```

`--project-directory .` is not optional. Compose reads `.env` from beside the compose file
unless told otherwise, and without it every secret comes back missing with an error that
does not explain why.

## What starts

| Service | Port | Notes |
| --- | --- | --- |
| `console` | 5173 | Static build served by nginx |
| `api` | 5080 | Control plane; migrates the database on startup |
| `worker` | — | Browser execution; health endpoint on 9091, not published |
| `postgres` | — | Not published by default |
| `redis` | — | Not published by default |
| `demo-bank` | 4200 | The application to try the platform against |

Every service waits for what it depends on to be *healthy*, not merely started. Starting the
API against a Postgres that is still initialising produces a migration failure that looks
like a code defect, and people lose an afternoon to it.

`make docker-down` stops the stack and keeps the data. `make docker-reset` deletes the
volumes too — the database, the queue and every stored artifact. They are separate commands
on purpose: a command called "down" should not destroy anything.

## Before a real deployment

The compose file is a local and demonstration stack. Four things must change:

1. **Delete the `demo-bank` service**, and with it `ALLOW_PRIVATE_NETWORK_TARGETS` on the
   `api` service. That flag exists only so the platform can reach the demo bank on the
   compose network; leaving it on lets a target URL point at anything inside your network,
   which is exactly the SSRF the URL guard exists to prevent.
2. **Set a real database password.** `POSTGRES_PASSWORD` defaults to `qanxt` for local use.
3. **Put the API behind TLS.** Nothing here terminates TLS; tokens would travel in clear.
4. **Publish nothing you do not need.** Postgres and Redis are already unpublished; keep it
   that way.

## Scaling workers

```bash
docker compose -f infrastructure/docker/docker-compose.yml --project-directory . up -d --scale worker=3
```

Workers claim jobs from a Redis consumer group, so adding them adds throughput without any
coordination. Each needs about a gigabyte of shared memory for Chromium — the compose file
sets `shm_size: 1gb`, and without it Chromium crashes part-way through a page and the
failure looks like a flaky test.

## The console's API URL is baked in

Vite inlines `VITE_API_URL` at build time, so the console image is built for one API
address. Pointing a built console at a different API means rebuilding it:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --project-directory . \
  build --build-arg VITE_API_URL=https://qanxt.example.com console
```

The alternative, and the better one for a real deployment, is to serve the console and the
API from the same origin behind one reverse proxy, so the console can use a relative URL.

## Building behind a TLS-inspecting proxy

Many corporate networks terminate TLS at an inspecting proxy, which makes the package
restore inside a build fail with a certificate error that says nothing about the cause. Drop
that proxy's CA as a `.crt` into `infrastructure/docker/certs/` and it is trusted during the
builds. The directory is otherwise empty and gitignored — a certificate is
environment-specific, and one committed there would be trusted by everybody's build.

Pass the proxy itself as build arguments:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --project-directory . build \
  --build-arg HTTPS_PROXY=http://proxy.example.com:3128 \
  --build-arg HTTP_PROXY=http://proxy.example.com:3128
```

## Images

| Image | Base | Runs as |
| --- | --- | --- |
| `Dockerfile.api` | `mcr.microsoft.com/dotnet/aspnet:8.0` | `qanxt` (uid 10001) |
| `Dockerfile.worker` | `mcr.microsoft.com/playwright:v1.56.0-jammy` | `pwuser` (uid 1000) |
| `Dockerfile.console` | `nginx:1.27-alpine` | nginx default |
| `Dockerfile.demo-bank` | `node:22-bookworm-slim` | `bank` (uid 10002) |

The worker is built on Microsoft's Playwright image because the browsers and their system
libraries are already installed and version-matched. Installing Chromium into a plain Node
image is possible but means tracking a long list of shared libraries by hand, and a missing
one shows up as a test failure rather than as a build failure.

## Kubernetes

There are no Kubernetes manifests yet. The compose file is the deployment topology; a chart
would express the same six services, with the worker as the only one worth scaling
horizontally. See `docs/verification-status.md` for what else is outstanding.

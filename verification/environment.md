# Verification environment

Recorded 2026-09-20T16:03:20Z by direct interrogation of the running system.

## Build under test

| | |
| --- | --- |
| Commit | `db15fa67c871cca35c1a2669d3e59f67cb74b9ab` |
| Branch | `claude/blissful-pasteur-qtbzbs` |
| Working tree | has uncommitted changes |

The browser-extension suite (EXT-001 to EXT-007) was added afterwards and ran on the same
host against commit `082c85b` plus the fix for BUG-0006, using Chromium 141 loaded with the
extension built from `apps/browser-extension`.

## Host

| | |
| --- | --- |
| OS | Ubuntu 24.04.4 LTS |
| Kernel | 6.18.44-fc-v37 |
| Arch | x86_64 |
| CPUs | 4 |
| Memory | 15Gi |

## Runtimes

| | |
| --- | --- |
| .NET SDK | 8.0.131 |
| Node | v22.22.2 |
| pnpm | 10.33.0 |
| Docker | 29.3.1 |
| PostgreSQL | 16.13(Ubuntu16.13-0ubuntu0.24.04.1) |
| Redis | 7.0.15 |
| Playwright | 1.56.0 |

## Golden test suite and product test lab

Added 2026-09-21 on the same host. The golden suite (`verification/golden-tests`) and the
test lab (`test-lab/`) ran against the stack below, started by `scripts/services-ctl.sh`
and `test-lab/scripts/lab-ctl.sh`.

| | |
| --- | --- |
| API | `http://127.0.0.1:5080`, ASP.NET Core 8, Development configuration |
| Worker | Node 22 browser worker, Playwright 1.56.0 |
| Console | Vite dev server on `http://127.0.0.1:5173` |
| Database | PostgreSQL 16.13, schema migrated to head |
| Queue | Redis 7.0.15 |
| AI provider | `local` — no hosted model key is present, so every generation and analysis figure describes AIRA's built-in rules engine |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `true` — required for the lab, which runs on localhost. Two security tests are scoped to that fact and say so in their own text. |

### Browsers

| Browser | Version | Available |
| --- | --- | --- |
| Chromium | 141.0.7390.37 | yes |
| Firefox | — | no — not installed, and the Playwright CDN is unreachable from this host |
| WebKit | — | no — as above |

EXEC-015 and EXEC-016 are therefore recorded NOT VERIFIED, carrying the platform's own
launch error. They are not recorded as passes and not as failures.

### Test lab applications

| Application | Port | Stack |
| --- | --- | --- |
| Banking | 4300 | React 18 + Vite single-page application, dependency-free Node HTTP server |
| Ecommerce | 4301 | Server-rendered, dependency-free Node HTTP server |
| Forms | 4302 | Server-rendered |
| Dynamic | 4303 | Single-page application built to be hostile to automation |
| Failure | 4304 | Thirteen fault cases on identically shaped pages |
| Self-healing | 4305 | Thirteen locator-change scenarios |

Data in every lab application is generated from a fixed seed (Mulberry32), so a run on
another host produces the same balances, orders and transactions. No real data of any kind
is present.

## The one-command run

`./scripts/verify-product` was run end to end on this host on 2026-09-21 and exited **0**:
infrastructure, the six lab applications, the ground-truth audit, the product's own 377
tests, all 125 golden tests, the reports and the certification, in one pass and with no
manual step between them.

```
121 passed, 0 failed, 4 not verified of 125 golden tests in 1176s
gates: Functional=PASS Discovery=PASS AI=PASS Self-healing=PASS Security=PASS
       Reliability=PASS Failure detection=PASS Evidence=PASS
overall: PASS
Certification: CERTIFIED — 10 YES, 0 NO, 0 NOT VERIFIED of 10 questions
```

The run before it, on the same build, produced the same verdicts from a different set of
browser sessions: the unstable application passed 10 of 20 runs then 7 of 20, which is the
number the lab intends to vary and the only one that did.

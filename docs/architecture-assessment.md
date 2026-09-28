# Architecture Assessment (Pre-Implementation)

**Date:** 2026-09-19
**Author:** Platform engineering (QA NXT)
**Status:** Accepted — basis for the implementation plan

## 1. Repository inspection

The repository `zakir911/AIRA` was inspected before any code was written.

| Item | Finding |
|---|---|
| Branches | `main`, `claude/blissful-pasteur-qtbzbs` |
| Commits | 1 (`Initial commit`) |
| Tracked files | `README.md` (6 bytes, contains `# QA NXT`) |
| Existing application code | **None** |
| Existing build system, CI, infra | **None** |

**Conclusion:** this is a greenfield repository. No existing work is at risk of being
overwritten. The platform is built from scratch on the designated feature branch.

## 2. Build/runtime environment assessment

The target environment was probed before choosing the stack, because a stack that
cannot be compiled or executed here cannot be verified, and unverifiable code is not
production-grade code.

| Capability | Status | Consequence |
|---|---|---|
| .NET 8 SDK | Installed (8.0.131, Ubuntu `dotnet-sdk-8.0`) | Backend is real .NET 8; it compiles and its tests run |
| Node.js | 22.22.2 + pnpm 10 | Worker, console, extension, CLI build and test |
| PostgreSQL | 16.13 server available locally | EF Core migrations apply against a real database |
| Redis | 7.0.15 server available locally | Queue abstraction runs against a real Redis |
| Playwright browsers | Chromium 141.0.7390.37 pre-installed at `/opt/pw-browsers` | Real browser automation, real E2E verification |
| NuGet / npm registries | Reachable | Dependencies resolve |
| Docker daemon | **Unavailable in this environment** | `docker-compose.yml` and Dockerfiles are authored and lint-checked but **cannot be built or run here**; they are explicitly marked as unverified |
| `builds.dotnet.microsoft.com` | Blocked by egress policy | .NET installed via the Ubuntu archive instead |

### Verification posture

Everything claimed as working in this repository was executed in this environment:
`dotnet build`, `dotnet test`, `pnpm test`, Playwright runs against the local demo
banking application, and migrations applied to a live PostgreSQL instance.
Anything that could not be executed here (container builds, Kubernetes manifests,
cloud CI runs, third-party LLM API calls) is labelled **unverified** in
`docs/verification-status.md`, not presented as working.

## 3. Domain decomposition

The product decomposes into nine bounded capabilities. These map directly to service
boundaries and to the delivery phases.

1. **Identity & Tenancy** — organizations, users, roles, permissions, project membership.
2. **Application Model** — applications, environments, pages, elements, journeys (the knowledge graph).
3. **Discovery** — bounded crawling that populates the application model.
4. **Test Authoring** — suites, cases, steps, assertions, test data.
5. **AI Orchestration** — provider abstraction, prompt construction, schema-validated structured output, cost accounting.
6. **Execution** — queued, deterministic Playwright execution producing executions/actions/results.
7. **Evidence** — artifacts, screenshots, traces, network, console; masking and retention.
8. **Diagnosis** — failure classification, root-cause analysis, locator healing, defect proposals.
9. **Intelligence & Delivery** — dashboards, quality gates, reporting, CI/CD, CLI.

## 4. Key architectural decisions

Each of these is recorded as an ADR in `docs/adr/`.

| # | Decision | Rationale |
|---|---|---|
| 0001 | .NET 8 control plane, Node/TypeScript execution plane | Playwright's first-class runtime is Node; the control plane benefits from EF Core, typed domain modelling and mature RBAC/hosting |
| 0002 | AI orchestration lives inside the control plane, behind `ILlmProvider` | Avoids a third network hop and a second deployable for what is, today, prompt construction + schema validation. Interfaces are transport-agnostic so it can be extracted into `apps/ai-orchestrator` without touching callers |
| 0003 | Redis Streams as the job transport behind `IJobQueue` | Available, operationally simple, supports consumer groups, acks and retries. RabbitMQ/Kafka/Service Bus become alternate `IJobQueue` implementations |
| 0004 | The LLM never drives the browser | The LLM emits `BrowserAction` JSON validated against a strict schema; a deterministic engine executes it. Bounds blast radius and makes runs reproducible |
| 0005 | Artifacts in object storage behind `IArtifactStore`, never in PostgreSQL | Large binaries in the OLTP database destroy backup/restore and query performance |
| 0006 | Locator healing is a ranked-candidate pipeline with deterministic scoring first, AI second | Deterministic semantic matching resolves the common cases without token spend; AI is the tie-breaker, and neither may silently rewrite a stored test |
| 0007 | Tenant isolation enforced by EF Core global query filters plus an explicit tenant context | Defence in depth: a developer who forgets a `WHERE` clause still cannot read another tenant's rows |
| 0008 | Target application content is untrusted data | All DOM/text/network content captured from a target app is wrapped in untrusted-data envelopes before reaching an LLM, and never treated as instructions |

## 5. Principal risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection from a target application ("ignore previous instructions…") | Untrusted-data envelopes, allow-listed structured output schemas, no tool/command surface exposed to the LLM, output validation before execution |
| SSRF via user-supplied application URLs | URL allowlist per application, private-range/link-local/loopback blocking, scheme allowlist, redirect re-validation |
| Secret leakage into evidence | Masking applied at capture time in the worker (before persistence), plus a second pass server-side; masking is tested |
| Uncontrolled crawling of a third-party site | Domain allowlist, depth, page count, action count, wall-clock budget, robots-respecting default, normalized-URL dedup, loop detection |
| Self-healing silently hiding an application defect | Healing is policy-gated, confidence-thresholded, recorded as an event, never mutates the stored test without an approval, and never converts a fail into a pass |
| Runaway AI cost | Deterministic-first pipeline, response caching keyed on prompt hash, per-project model config, token/cost accounting per request |
| Cross-tenant data access | Global query filters, tenant-scoped repositories, authorization handlers, and tenant-isolation integration tests |

## 6. Out of scope for the initial build

Designed for (interfaces exist) but deliberately not implemented now: mobile testing,
contract testing, performance testing, full visual-regression baselining, DB validation,
and Kubernetes/Terraform production hardening. These are additive behind existing
interfaces and are listed in the roadmap section of `docs/implementation-plan.md`.

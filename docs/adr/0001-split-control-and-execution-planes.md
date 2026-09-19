# ADR 0001 — Split control plane (.NET) and execution plane (Node/Playwright)

**Status:** Accepted · **Date:** 2026-09-19

## Context
The platform needs mature identity, RBAC, relational modelling and long-lived services
(strengths of .NET 8 + EF Core), and it needs first-class Playwright, whose reference
runtime and API surface are Node/TypeScript.

## Decision
Two planes. The .NET control plane owns state, identity, authorization, AI orchestration
and quality decisions. A Node/TypeScript execution plane owns browsers: discovery,
execution, evidence capture and locator candidate generation. They communicate over a
Redis Stream (jobs) and a narrow, worker-token-authenticated callback API (results).

## Consequences
+ Playwright is used natively; no brittle CLR-to-Node bridge.
+ Workers are stateless and scale horizontally and independently.
+ Contracts must be shared across languages: `packages/shared-types` (TS) mirrors the
  .NET DTOs, and a contract test asserts the two stay in sync.
- Two toolchains to build and test.

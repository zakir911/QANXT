# ADR 0002 — AI orchestration lives inside the control plane

**Status:** Accepted · **Date:** 2026-09-19

## Context
The reference architecture shows an "AI Orchestrator" box. Today its work is prompt
assembly, provider selection, schema validation, caching and cost accounting — all
CPU-light and stateless, and all of it needs the same database context as its callers.

## Decision
Implement orchestration as `Aira.Application/Ai` + `Aira.Infrastructure/Ai` inside the
control plane, behind `ILlmProvider` and `IAiOrchestrator`. Do not deploy a separate
service yet.

## Consequences
+ One less deployable, one less network hop, no distributed transaction around AI accounting.
+ Extraction later is mechanical: `IAiOrchestrator` is transport-agnostic, so an HTTP adapter
  can replace the in-process implementation without touching a single caller.
- The API process carries LLM latency; mitigated by running long generations as queued jobs.

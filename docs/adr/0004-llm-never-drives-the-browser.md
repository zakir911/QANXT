# ADR 0004 — The LLM emits structured actions; it never drives the browser

**Status:** Accepted · **Date:** 2026-09-19

## Context
Letting a model call browser primitives directly makes runs non-reproducible, makes
prompt injection from the target application catastrophic, and makes failures
unattributable.

## Decision
Models emit `BrowserAction` objects validated against a strict JSON schema
(closed enum of verbs, closed target shapes, no free-form code). A deterministic engine
executes validated actions. `executeScript` is rejected unless the project explicitly
enables it and the caller holds `execution:script`.

## Consequences
+ Reproducible runs, auditable plans, bounded blast radius.
+ Malformed or adversarial model output is rejected before it can act.
- Some exotic interactions need a new verb rather than ad-hoc scripting; that is deliberate.

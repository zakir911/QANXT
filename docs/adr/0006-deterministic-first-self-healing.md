# ADR 0006 — Self-healing is deterministic-first, AI-second, never silent

**Status:** Accepted · **Date:** 2026-09-19

## Context
Most real locator breakage is a renamed accessible name, a moved element or a changed
test id — all resolvable by semantic comparison without an LLM.

## Decision
On locator failure the engine snapshots the DOM, generates candidate elements, scores them
deterministically across weighted signals (role, accessible name similarity, text, label,
placeholder, test id, attributes, ancestry, neighbours, geometry, historical locators), and
only consults the LLM when the top candidates are within a narrow margin. Healing is gated
by project policy (`Auto` / `Suggest` / `Never`) and a confidence threshold, is recorded as a
`HealingEvent` with full evidence, and never mutates the stored test definition without an
explicit approval.

## Consequences
+ Most healings cost zero tokens and are explainable by their score breakdown.
+ A healed test is reported as `Healed`, not silently as `Passed`.
- Weights need tuning per estate; they are configuration, not constants in code.

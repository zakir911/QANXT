# ADR 0005 — Artifacts live in object storage, never in PostgreSQL

**Status:** Accepted · **Date:** 2026-09-19

## Decision
`IArtifactStore` abstracts binary persistence. The default adapter writes to a
content-addressed filesystem tree (`<root>/<tenant>/<sha256[0:2]>/<sha256>`), which maps
directly onto an S3/Azure Blob adapter later. PostgreSQL stores only metadata: kind, size,
content type, hash, storage key, masking status, retention class.

## Consequences
+ The OLTP database stays small and restorable; artifacts dedupe by hash.
+ Signed-URL delivery is possible without schema change.
- Store and database can drift; a retention/GC job reconciles them.

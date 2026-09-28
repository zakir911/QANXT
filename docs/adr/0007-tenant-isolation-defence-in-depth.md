# ADR 0007 — Tenant isolation via global query filters plus explicit tenant context

**Status:** Accepted · **Date:** 2026-09-19

## Decision
Every tenant-scoped entity implements `ITenantOwned`. `QaNxtDbContext` applies an EF Core
global query filter binding `OrganizationId` to `ITenantContext.OrganizationId`, and
`SaveChanges` stamps the tenant on new entities and rejects writes that cross tenants.
Authorization handlers additionally verify project membership.

## Consequences
+ A forgotten `WHERE` clause cannot leak another tenant's data.
+ Cross-tenant administrative work requires an explicit, audited elevation.
- Filters must be suppressed deliberately (and only) in system jobs; those paths are tested.

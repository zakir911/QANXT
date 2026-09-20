# BUG-0001 — `ALLOW_PRIVATE_NETWORK_TARGETS` also unlocks the cloud metadata service

| | |
| --- | --- |
| **ID** | BUG-0001 |
| **Title** | Enabling private-network targets also permits link-local (169.254.0.0/16), exposing the cloud metadata endpoint to SSRF |
| **Severity** | **HIGH** |
| **Found by** | SEC-040, independent security suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `db15fa67c871cca35c1a2669d3e59f67cb74b9ab` |
| **Component** | `apps/api/src/Aira.Application/Security/TargetUrlGuard.cs:53` |
| **Reproduction rate** | 2 of 2 before the fix, 0 of 1 after |
| **Status** | **Fixed and verified** |

## Preconditions

- A deployment with `ALLOW_PRIVATE_NETWORK_TARGETS=true`.
- Any authenticated account with `application:write` — the lowest role that can register an
  application, not an administrator.

This is not an exotic configuration. The platform's own
`infrastructure/docker/docker-compose.yml` sets the flag to `true` by default so the bundled
demo bank on the compose network can be reached, and `.env.example` ships it as `true`.

## Steps

1. Register an application whose base URL is `http://169.254.169.254/latest/meta-data/`.
2. Observe the API accepts it (`201 Created`).
3. The URL is now a legitimate discovery and execution target, so a crawl or a test run will
   have the browser worker fetch it — from inside the network the platform runs in.

## Expected

Refused, as it is when the flag is off:

```
400 The base URL is not permitted: 169.254.0.0/16 is link-local (cloud metadata)
```

The flag exists so a developer can point the platform at `localhost`. Nothing about that
need justifies reaching the cloud metadata service, which is the canonical SSRF target for
stealing instance credentials.

## Actual

```
201 Created
```

Accepted for all three of:

| Target | Status |
| --- | --- |
| `http://169.254.169.254/latest/meta-data/` | 201 |
| `http://[::ffff:169.254.169.254]/` | 201 |
| `http://0177.0.0.1/` | 201 (loopback; in scope for the flag, listed for completeness) |

## Why this matters

The browser worker fetches whatever the target URL says and captures the result as evidence:
a DOM snapshot, a screenshot, a network log. On AWS, GCP or Azure, `169.254.169.254` returns
instance credentials. An authenticated tenant could therefore have the platform read those
credentials and store them as artifacts the tenant can download — a complete SSRF
credential-exfiltration path, initiated through an ordinary product feature.

## Root cause

`TargetUrlGuard.IsPermitted` gates the *entire* reserved-address check behind the flag:

```csharp
if (!options.AllowPrivateNetworks && IsPrivateOrReservedLiteral(host, out var literalReason))
```

`IsPrivateOrReservedLiteral` correctly identifies link-local, multicast, carrier-grade NAT
and reserved space alongside loopback and RFC1918 — but one flag switches all of it off. The
separate `BlockedHosts` set catches metadata *hostnames* (`metadata.google.internal`)
unconditionally; it does not catch the metadata *address*.

## Not affected

The guard's address parsing is sound. With the flag off, every encoding tried was refused:
decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f.0x0.0x0.0x1`), short form
(`127.1`), IPv4-mapped IPv6, IPv6 loopback, and a userinfo trick
(`http://169.254.169.254@example.com/`). Evidence: `api/strict-mode-probe.json`.

## Fix

Split the check in two. Addresses that can never be a legitimate test target — link-local,
multicast, reserved, carrier-grade NAT — are refused unconditionally. Only loopback,
`localhost` and the RFC1918 private ranges are governed by the flag, which is what a
developer actually needs it for.


## Fix applied

`TargetUrlGuard.IsAlwaysForbiddenLiteral` now refuses link-local, carrier-grade NAT,
`0.0.0.0/8`, multicast and IPv6 link-local **before** the flag is consulted, including the
IPv4-mapped IPv6 form. Only loopback, `localhost` and RFC1918 remain governed by
`AllowPrivateNetworks`, which is what the flag is actually for.

## Verification after the fix

| Evidence | Result |
| --- | --- |
| `api/attempt-3.json` | 0 of 3 metadata targets accepted (was 3 of 3) |
| SEC-040 | PASS — all 10 never-permitted targets refused |
| SEC-041 | PASS — loopback accepted with the flag on, refused with it off, proven against a second instance running `ALLOW_PRIVATE_NETWORK_TARGETS=false` |
| `TargetUrlGuardAlwaysForbiddenTests` | 13 new unit assertions; 37 guard tests pass |

## Regression test

`apps/api/tests/Aira.UnitTests/Security/TargetUrlGuardTests.cs` —
`TargetUrlGuardAlwaysForbiddenTests`. It asserts both halves: that link-local stays refused
with the flag on, and that loopback and RFC1918 still work, so the fix cannot be "corrected"
later by simply blocking everything.

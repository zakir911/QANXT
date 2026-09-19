# ADR 0003 — Redis Streams behind `IJobQueue`

**Status:** Accepted · **Date:** 2026-09-19

## Context
Discovery and execution are long-running and must survive worker crashes, support
multiple competing consumers, and allow at-least-once delivery with acknowledgement.

## Decision
`IJobQueue` is the port. The initial adapter uses Redis Streams with consumer groups
(`XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`), giving acks, pending-entry inspection and
claim recovery for dead consumers.

## Consequences
+ Redis is already needed for caching and rate limiting; no new infrastructure.
+ At-least-once semantics force idempotent job handlers, which is the right discipline anyway.
- Not a full broker: no topic routing or long retention. RabbitMQ/Kafka/Azure Service Bus
  become alternative `IJobQueue` adapters if those are needed.

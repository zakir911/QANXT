# Reproducing SECE-004-excessive-data

The response carries passwordHash, apiToken

## What was done

1. `GET http://127.0.0.1:4402/api/users` as alice

## What came back

1. HTTP 200 — reading a collection and inspecting the field names it returns

## Why that is a finding

/api/users returns field(s) named passwordHash, apiToken. The values are not reproduced here or in the sanitized evidence; the field names alone establish the finding.

## Severity

(not computed)

> Evidence is written twice. `request.txt` and `response.txt` are what actually
> happened; `sanitized-request.txt` and `sanitized-response.txt` are the same exchange
> with credentials removed, and are what a report links to.
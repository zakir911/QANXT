# The real-world pilot

Everything QA NXT had been tested against before this was written alongside it. That is the
right way to build a test platform and it tells you nothing about how it behaves on somebody
else's application, so this is the part of the work that can actually surprise us.

## The target

[Verdaccio](https://verdaccio.org) 6.10.4 — a private npm registry. A Vue front end over an
Express API, written by people who have never heard of QA NXT, with its own routes, its own
login, its own conventions and no knowledge that anything would ever crawl it.

It is installed from npm rather than vendored, so the version is pinned and verifiable:

```bash
mkdir -p ~/verdaccio-pilot && cd ~/verdaccio-pilot
npm init -y && npm install verdaccio@6.10.4
```

## How it is configured

`conf/config.yaml` is Verdaccio's own shipped shape with three deliberate changes:

- **Storage points at a scratch directory.** The registry is disposable.
- **`uplinks` is empty.** With no uplink the pilot cannot proxy to npmjs, so a crawl that
  follows a package page cannot turn into traffic against somebody else's registry. This
  matters more than it looks: a crawler pointed at a proxying registry is a crawler pointed
  at the public npm registry.
- **It listens on loopback only**, and the security scope QA NXT is given names `127.0.0.1` and
  `localhost` and nothing else.

Three packages are published into it (`pilot-utils`, `pilot-core`, `pilot-cli`) so the
registry has real content to walk rather than an empty-state page.

## Authorization

The registry is ours, local, disposable, holds nothing real and is not production. That is
what the authorization note on its security scope says, and it is true. Nothing in this pilot
touches a system belonging to anybody else.

## Running it

```bash
cd ~/verdaccio-pilot && node_modules/.bin/verdaccio --config conf/config.yaml &
node pilot/run-pilot.mjs
```

The script onboards the registry as a team would — project, application, environment,
discovery, business context, security scope — then drives one bounded autonomous pass and
answers its questions. It writes everything the pass recorded to `pilot/pilot-run.json`.

It deliberately hands the agent **no credentials**. An application nobody has onboarded
before starts as an anonymous visitor sees it, and whatever the agent cannot reach that way
is a finding about the pilot rather than something to work around.

## What the script does not do

It does not judge the pass. The script records; the pilot report interprets, next to the
things the pass got wrong. Nothing in either is tuned to flatter the platform.

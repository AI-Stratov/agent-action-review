# Agent Action Review

Choose a separate model to authorize an agent's actions without changing the
model doing the work. The first integration is a DeepSeek Harness Auto component;
the review engine and policy are independent of the official Auto Review plugin.

- Fixed reviewer provider/model, or inherit the working agent's route.
- One bounded model request per action, with no reviewer tools or subagents.
- Human, direct-parent, constraint and evidence provenance kept separate.
- Full-access Auto execution with host guards and exact human confirmation.
- Cancellation of pending reviews and approvals when the component stops.
- Optional local metadata diagnostics, off by default.

The reviewer receives the pending tool definition and bounded source-labelled
context, rather than a complete tool catalogue. Ordinary facts can rotate through
an explicit selected window; human instructions and narrowing constraints are
protected. No MCP servers are started by this plugin.

## Install in DeepSeek Harness

Use the [DSH package guide](packages/dsh/README.md) to install the built tarball.
The tested host is DSH **0.2.1-rc.3** on macOS; other host versions are refused
until verified. The official Auto Review component must be disabled before this
component can own the Auto slot. After loading it, select Auto in the session.

Reviewer configuration uses provider/model IDs already connected in DSH:

```yaml
- id: action-review
  config:
    mode: fixed
    provider: configured-provider-id
    model: configured-model-id
```

`mode: inherit` uses the working agent's current route. Changing these settings
does not change the agent model or restart a review already in progress. The
plugin stores no credentials and does not create provider accounts.

## Independent core

[The core API](packages/core/README.md) accepts an immutable action/context and
an injected backend. It has no DSH imports, model client, tool registry or action
executor. Contracts, policy, strict JSON parsing, binding checks and cancellation
can be tested independently of any harness.

A model allow is an authorization judgment, not a safety proof. The host retains
its sandbox/account restrictions, human approvals, final guards and execution.
The plugin does not replace code review, CI or formal verification. Synthetic
tests verify implementation boundaries; real-model quality and latency have
not been benchmarked.

## Development

Requires Node 22 or later:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check
```

Unit tests use synthetic data and injected backends, with no SDK, credentials,
network, database or model access. With an installed compatible DSH desktop app,
run the separate host checks:

```sh
node scripts/check-runtime.cjs --app '/Applications/DeepSeek Harness.app'
npm pack --workspace dsh-action-review --pack-destination /absolute/output/path
node scripts/check-host.cjs --app '/Applications/DeepSeek Harness.app' \
  --tarball /absolute/output/path/dsh-action-review-0.1.0.tgz
```

These host checks run Electron as Node against a temporary offline profile.
They do not open the UI, change the working profile or make real model requests.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing SDK compatibility or
permission behavior. Bundled dependency licenses are included in the tarball.

The DSH adapter package is `dsh-action-review`; it is distributed as a release
tarball. npm publication is deferred. The independent core is included in the
built plugin and does not need a separate installation.

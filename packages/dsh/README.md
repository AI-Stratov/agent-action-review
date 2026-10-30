# Action Review for DeepSeek Harness

An independent Auto authorization reviewer with a selectable model. It checks
one pending action, then allows it, asks for human approval or denies it.
The review policy and core belong to this plugin; the official experimental
Auto Review package is not a runtime dependency.

The adapter package is `dsh-action-review`, distributed as a GitHub release
tarball. npm publication is deferred. The independent core is bundled, so no
additional wrapper or core installation is needed.
It contains one Component, `action-review`, inside one installable DSH bundle.
The core and its dependencies are included in the built artifact; host SDKs are
provided by DSH rather than bundled as competing service implementations.

## Compatibility

The declared host versions are DSH `0.2.1-rc.3` and `0.2.1-rc.5`, Node 22 or later. SDK
packages are optional peers because DSH supplies them through its host resolver;
this does not make the host capabilities optional. The component refuses to
start when a required service is unavailable. Other DSH versions must be tested
before changing `engines.dsh`; do not use `allow-version` as a compatibility fix.

Both declared SDK versions have passed the host, runtime and loader lifecycle checks. This is not a claim
that future DSH APIs remain compatible, or that model judgment has been evaluated.

## Build and install

From the repository root:

```sh
npm ci --ignore-scripts
node scripts/build.mjs
npm test
npm run check
npm pack --workspace dsh-action-review --pack-destination /absolute/output/path
```

The tarball contains the built component, its bundle patch, documentation and
third-party license notices. No build step, API key or global dependency install
is required when loading that tarball in DSH.

Download `dsh-action-review-0.1.1.tgz` from the
[GitHub release](https://github.com/AI-Stratov/agent-action-review/releases/tag/v0.1.1)
and add the local archive in Desktop under **Plugins → Add plugin → Install a
third-party plugin**, or use the CLI:

```sh
dsh plugin --profile action-review-test add /absolute/path/dsh-action-review-0.1.1.tgz
```

This syntax is documented by the [official CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md): plugin arguments are forwarded to pnpm. The CLI command itself is not shipped by every Desktop installation. With Desktop only, open **Plugins → Add plugin → Install a third-party plugin** and enter the tarball's absolute path in the package field; the user performs this step. The installed UI package documents tarballs and absolute local paths as accepted inputs. No application bundle files need editing.

For an offline, disposable profile check, the repository provides `scripts/check-host.cjs`. It extracts the already built tarball into a task-owned temporary profile, declares that dependency and its `dsh.profile.bundles` entry, then uses the installed host's real profile parser, compatibility admission and module resolver. It does not modify the working profile:

```sh
node scripts/check-host.cjs --app "/absolute/path/DeepSeek Harness.app" --tarball /absolute/path/dsh-action-review-0.1.1.tgz
```

This is a headless artifact/host check, not a claim that the Desktop UI or a live model session was exercised. The temporary profile is removed afterwards.

For an existing Desktop Auto setup, use the closed-application helper below rather than replacing a running integration. Disable the official Auto Authorization Review Component before enabling this
Component. DSH currently has one Auto owner slot; the plugin refuses a competing
registration instead of running two classifiers. Installing the bundle does not
silently take over or disable the official Component.

After the new Component is running, select Auto for the session. Auto runs with
full host access and review of each supported action; it is not Workspace Write.
Host restrictions and human approval remain authoritative. When the checker is
unloaded, pending checks and pending approval waits are cancelled, and its Auto
sessions fall back to Workspace Write. The previous Full access behavior of the
official experimental Component is not copied.

## Replace an existing Desktop Auto setup

The repository's macOS helper uses the installed host's public plugin package
operations and its embedded pnpm. It installs only the reviewed local tarball,
offline with package scripts and peer auto-installation disabled. It does not
edit the application bundle or change unrelated profile entries. Preview is
the default:

```sh
node scripts/install-profile.cjs --app "/absolute/path/DeepSeek Harness.app" --profile /absolute/profile-directory --tarball /absolute/plugin.tgz --provider configured-provider --model configured-model --replace-auto
```

Review that output, fully quit DSH, then repeat the same command with `--apply`.
The helper refuses a running application. This matters because unloading the
official experimental integration while sessions use Auto changes those sessions
to Full access; replacing its profile configuration while the application is
stopped avoids that live-unload path. The new component will own Auto after the
next normal application launch.

The install appends overrides that disable `auto-review` and configure
`action-review` with the fixed reviewer route. It stores the tarball at a stable
profile-owned path and uses the native package manager to update the dependency
and pnpm lockfile together. Existing `node_modules` is backed up using an APFS
clone; unsupported clone backups stop the operation before installation. The
backup contains the original manifest, lockfile and patch. It is retained until
the installation is accepted; no global cache cleanup is performed.

With DSH closed, the returned backup supports an exact rollback:

```sh
node scripts/install-profile.cjs --app "/absolute/path/DeepSeek Harness.app" --profile /absolute/profile-directory --rollback /absolute/returned-backup-directory --apply
```

Rollback validates the complete backup before changing the current profile and
refuses to overwrite later profile-config changes. A failed package-manager
operation restores the original config and cloned module tree. The helper is
currently for the tested macOS/APFS Desktop layout; it stops on an unknown
application layout, shared module-directory symlink or unsupported backup.

## Configuration

Open the Component's settings or set its config in the profile's normal patch:

```yaml
- id: action-review
  config:
    mode: fixed
    provider: configured-provider-id
    model: configured-model-id
    timeoutMs: 30000
    contextBytes: 131072
    metrics: false
```

`mode: inherit` uses the pending agent's provider and model. `mode: fixed` uses
the configured provider and model for review only. Provider/model identifiers
must already be connected in DSH; the plugin stores no credentials and creates
no separate provider account. The coding agent's model is not changed.
Changing the reviewer route affects the next review; an in-flight review keeps
its captured route and does not restart halfway through.

`timeoutMs` limits a model review. `contextBytes` limits the retained source
context used by the checker. Missing or truncated authority is never silently
replaced with invented permission. `metrics` is off by default; when enabled,
local diagnostics contain outcome, model route, elapsed time and available
usage, not prompts, tool arguments, raw model text or secrets.

The reviewer receives only the pending tool definition and bounded, source-labelled
context, not the full MCP tool catalogue. Documents and checkpoints remain facts;
text claiming owner approval does not become a human instruction. Effects that
the host cannot establish are labelled unknown for model assessment rather than
being presented as project-local operations. If the actual effect or authority
cannot be established, the appropriate result remains ask or deny.

## Scope and limitations

The host retains tool execution, sandbox/account restrictions and exact human
confirmation. A model allow is not proof of safety and cannot override a host
prohibition. Technical failures stop the pending action and are reported
separately from a meaningful model denial. There are no silent retries, allow
cache, fallback providers, reviewer tools or automatic external mutations.

Native tool calls and dispatched PTC inner calls enter the checker. The outer
PTC transport itself is not a blanket approval of the operations inside it.
External programs cannot be claimed individually verified solely because their
launcher was approved. Unsupported context sources remain unverified rather
than being upgraded to human authority.

Do not use this component as a substitute for code review, CI or formal
verification. Release acceptance must include the built tarball, clean-profile
loading, restart/unload and representative real-model decisions in the intended
host environment.

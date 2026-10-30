# Action review core

An SDK-independent ESM library for reviewing one immutable proposed action.
The host supplies the action, verified instruction provenance, evidence,
permission boundaries and a fresh request identity. An injected backend makes
one model request. The core validates the snapshot and response and returns a
bound decision or a separate technical error. It never executes the action.

## API

```js
import { createReviewer, snapshotAction } from '@agent-action-review/core';

const reviewer = createReviewer({
  backend: async ({ request, policy, responseSchema }, { signal }) => {
    // Convert this normalized input to your model API inside your adapter.
    return {
      output: await modelRequest({ request, policy, responseSchema, signal }),
      route: { provider: 'configured-provider', model: 'configured-model' },
    };
  },
});

const result = await reviewer.review(request, { signal });
```

`modelRequest`, `request` and `signal` above belong to the host application.
The core has no model client, credentials, tool registry or harness dependency.
The backend receives a frozen request, versioned policy and JSON Schema for
one model decision. It returns `{ output: string, route?, usage? }`. `output`
must be exactly one JSON object matching that schema. Markdown, duplicate keys,
unknown fields, invented references and mismatched identities are rejected.
Model-supplied metadata and technical errors are not accepted as backend facts.
Backend route and usage are optional; unknown values are omitted rather than
reported as zero. An exception becomes a generic `backend_error`, without
copying potentially sensitive provider error text into the result.

The exports also include `POLICY`, `REQUEST_SCHEMA` and `RESPONSE_SCHEMA`.
Type declarations describe the API; the JSON schemas define the data boundary.

## Snapshot and permission boundaries

Set `action.snapshot_id = snapshotAction(action)` before reviewing. The helper
hashes the action excluding its snapshot id: recursive object keys sorted by
ECMAScript string order, arrays in their original order, JSON primitives encoded
with JSON.stringify. This versioned encoding is not an RFC 8785 implementation.
Only plain, lossless JSON data is accepted. Negative zero, nonfinite numbers,
accessors, custom prototypes, proxies, sparse arrays, cycles, symbols and values
JSON serialization would omit are rejected. Input is limited to 1 MiB and 64
nested levels; model output to 64 KiB and the same depth.

`request_id` must be fresh for each immutable full input. Call identifiers must
be scoped uniquely by the host across sessions. The action hash does not cover
all context and is not a reusable authorization token. The host must not reuse
a result after any input, authority or environment change. The core keeps no
allow cache, request registry or permission state. On execution the host must
check the same action and current restrictions again, including its own approval
receipt. Those checks and the human confirmation flow belong to the adapter.

Authority labels are assertions by the trusted host adapter. The core cannot
authenticate a fabricated `human` label or infer whether a parent is actually
the direct parent. It validates structural integrity and exact approval binding.
It does not infer destructive effects from a tool's name, authenticate a service,
or prove that natural language authorization is sufficient.

Host deny and a verified rejection produce deny without calling the backend.
Missing required context, unverified authority, missing verified authority or unknown
execution boundaries produce ask without a model call. Unclassified effect labels are passed to the backend for assessment from the
exact tool and arguments; effects that remain unclear require ask under the
policy. A declared `selected` evidence window can omit older ordinary facts;
authority and narrowing constraints must be retained. Omitted facts cannot
prove consent or establish that an object was created by this task. Other
requests use one backend call. A backend allow needs a supplied verified authority
reference. Its reasoning can still be wrong: the host retains its final guards
and a host ask still requires human confirmation even when the reviewer allows.
The core neither changes a sandbox nor silently switches the working model.

## Errors, cancellation and diagnostics

Successful results have `status: 'result'` and `decision: 'allow' | 'ask' | 'deny'`.
Technical errors have `status: 'error'` and a separate code. Valid inputs produce
results bound to the same request, action snapshot and policy. `invalid_input`
may have no binding when the identifiers themselves cannot be validated. Invalid
constructor options throw; invalid review data returns an error result.

The default backend timeout is 30 seconds, configurable through `timeoutMs`.
Cancellation and timeout abort the backend signal and settle the review even if
the backend ignores that signal. Late backend responses cannot replace the
completed result. The host backend must still implement transport cancellation
to stop its own work; a JavaScript promise cannot force a remote request to end.
There are no retries, automatic fallback providers or action executions.

`onEvent` is optional and disabled by default. It receives one final event with
status, decision or error code, duration and available route/usage. It receives
no arguments, instruction text, evidence, raw output or reason. Exceptions and
rejected observer promises do not change the decision; observer promises are
not awaited. Observers should return promptly and manage their own persistence.

The first policy is `task-authorization@0.1.0`. The retained synthetic examples
state intended model behavior; validating their expected decisions is not an
assessment that a model will make those decisions. This is authorization review,
not a formal proof or code-quality review. No DSH adapter is part of this package.

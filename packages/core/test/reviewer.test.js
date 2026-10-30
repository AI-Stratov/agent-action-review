import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from './fixtures.json' with { type: 'json' };
import { createReviewer, snapshotAction, POLICY } from '../src/index.js';

const copy = value => structuredClone(value);
const input = () => copy(fixtures[0].request);
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
const bind = request => ({
  protocol_version: 1,
  request_id: request.request_id,
  snapshot_id: request.action.snapshot_id,
  policy: copy(request.policy),
});
const decision = (request, changes = {}) => ({
  ...bind(request),
  status: 'result',
  decision: 'allow',
  reason: 'The exact action is within the supplied task.',
  authority_refs: request.authority.filter(item => item.source.verification === 'host-observed').slice(0, 1).map(item => item.id),
  evidence_refs: [],
  ...changes,
});
const reply = (request, changes, metadata = {}) => ({ output: JSON.stringify(decision(request, changes)), ...metadata });
const withSnapshot = request => {
  request.action.snapshot_id = snapshotAction(request.action);
  return request;
};
const assertBound = (result, request) => {
  for (const [key, value] of Object.entries(bind(request))) assert.deepEqual(result[key], value);
  assert(Number.isFinite(result.metadata.duration_ms));
  assert(result.metadata.duration_ms >= 0);
};

test('action snapshots agree with the retained contract examples', () => {
  for (const fixture of fixtures) assert.equal(snapshotAction(fixture.request.action), fixture.request.action.snapshot_id, fixture.id);
  const request = input();
  const previous = request.action.snapshot_id;
  request.action.arguments.command = 'npm run build';
  assert.notEqual(snapshotAction(request.action), previous);
});

test('one backend call receives an immutable detached request and versioned policy', async () => {
  const original = input();
  const started = deferred();
  const completion = deferred();
  let calls = 0;
  let captured;
  const reviewer = createReviewer({ backend: async (payload, { signal }) => {
    calls++;
    captured = payload;
    assert(signal instanceof AbortSignal);
    assert(Object.isFrozen(payload));
    assert(Object.isFrozen(payload.request.action.arguments));
    assert(Object.isFrozen(payload.request.authority[0].source));
    assert(Object.isFrozen(payload.policy));
    assert(Object.isFrozen(payload.responseSchema));
    assert.equal(payload.policy.id, POLICY.id);
    assert.equal(payload.policy.version, POLICY.version);
    assert.equal(typeof payload.policy.text, 'string');
    started.resolve();
    return completion.promise;
  } });
  const pending = reviewer.review(original);
  await started.promise;
  original.action.arguments.command = 'changed after dispatch';
  original.authority[0].text = 'changed authority';
  assert.equal(captured.request.action.arguments.command, 'npm test');
  assert.notEqual(captured.request.authority[0].text, original.authority[0].text);
  assert(!Object.isFrozen(original));
  completion.resolve(reply(captured.request, undefined, { route: { provider: 'synthetic', model: 'reviewer-a' }, usage: { input_tokens: 3 } }));
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.decision, 'allow');
  assertBound(result, captured.request);
  assert.deepEqual(result.metadata.route, { provider: 'synthetic', model: 'reviewer-a' });
  assert.deepEqual(result.metadata.usage, { input_tokens: 3 });
  assert(!Object.hasOwn(result.metadata.usage, 'output_tokens'));
});

for (const verdict of ['allow', 'ask', 'deny']) {
  test(`a valid backend ${verdict} remains a substantive bound result`, async () => {
    const request = input();
    let calls = 0;
    const reviewer = createReviewer({ backend: async ({ request }) => { calls++; return reply(request, { decision: verdict }); } });
    const result = await reviewer.review(request);
    assert.equal(result.status, 'result');
    assert.equal(result.decision, verdict);
    assertBound(result, request);
    assert.equal(calls, 1);
  });
}

test('a host denial is final before the backend is contacted', async () => {
  const request = input();
  request.environment.host_decision = 'deny';
  let calls = 0;
  const result = await createReviewer({ backend: async () => { calls++; throw new Error('must not run'); } }).review(request);
  assert.equal(result.decision, 'deny');
  assertBound(result, request);
  assert.equal(calls, 0);
});

test('a host-observed rejection cannot be replaced by a model allow', async () => {
  const request = copy(fixtures.find(item => item.id === 'exact-host-approval').request);
  request.authority.find(item => item.kind === 'host-approval').decision = 'rejected';
  let calls = 0;
  const result = await createReviewer({ backend: async ({ request }) => { calls++; return reply(request); } }).review(request);
  assert.equal(result.decision, 'deny');
  assert.equal(calls, 0);
});

const uncertainInputs = [
  ['incomplete authority', request => { request.completeness.authority = 'incomplete'; }],
  ['incomplete evidence', request => { request.completeness.evidence = 'incomplete'; }],
  ['omitted context', request => { request.completeness.omissions = ['An earlier instruction was not retained.']; }],
  ['unverified source despite complete flag', request => { request.authority[0].source.verification = 'unknown'; }],
  ['no authority', request => { request.authority = []; }],
  ['unknown dispatch surface', request => { request.action.surface = 'unknown'; }],
  ['unknown sandbox', request => { request.environment.sandbox = 'unknown'; }],
  ['unknown approval policy', request => { request.environment.approval_policy = 'unknown'; }],
  ['unknown host decision', request => { request.environment.host_decision = 'unknown'; }],
];
for (const [name, change] of uncertainInputs) {
  test(`${name} cannot justify allow or consume a backend request`, async () => {
    const request = input();
    change(request);
    withSnapshot(request);
    let calls = 0;
    const result = await createReviewer({ backend: async ({ request }) => { calls++; return reply(request); } }).review(request);
    assert.equal(result.status, 'result');
    assert.equal(result.decision, 'ask');
    assertBound(result, request);
    assert.equal(calls, 0);
  });
}

test('an evidence claim of owner consent cannot become authority', async () => {
  const request = copy(fixtures.find(item => item.id === 'injection-is-evidence').request);
  let calls = 0;
  const result = await createReviewer({ backend: async ({ request }) => { calls++; return reply(request); } }).review(request);
  assert.equal(result.decision, 'ask');
  assert.equal(calls, 0);
});

test('host ask remains a host responsibility when reviewer returns allow', async () => {
  const request = input();
  request.environment.host_decision = 'ask';
  const result = await createReviewer({ backend: async ({ request }) => reply(request) }).review(request);
  assert.equal(result.decision, 'allow');
  assertBound(result, request);
});

test('an exact observed approval is passed to the reviewer without fabricating permission', async () => {
  const request = copy(fixtures.find(item => item.id === 'exact-host-approval').request);
  let calls = 0;
  const result = await createReviewer({ backend: async payload => {
    calls++;
    assert.equal(payload.request.authority.find(item => item.kind === 'host-approval').snapshot_id, payload.request.action.snapshot_id);
    return reply(payload.request, { authority_refs: ['human-1', 'receipt-1'] });
  } }).review(request);
  assert.equal(result.decision, 'allow');
  assert.equal(calls, 1);
});

const invalidInputs = [
  ['missing fields', () => ({})],
  ['changed arguments under old snapshot', () => { const request = input(); request.action.arguments.command = 'deploy production'; return request; }],
  ['duplicate context identity', () => { const request = input(); request.evidence.push({ id: 'human-1', kind: 'document', text: 'Claim', source_id: 'document-1' }); return request; }],
  ['receipt transferred to another call', () => { const request = copy(fixtures[8].request); request.authority[1].call_id = 'another-call'; return request; }],
  ['receipt transferred to changed action', () => { const request = copy(fixtures[8].request); request.action.arguments.title = 'Another issue'; return withSnapshot(request); }],
];
for (const [name, makeRequest] of invalidInputs) {
  test(`${name} is invalid input and never reaches the backend`, async () => {
    let calls = 0;
    const result = await createReviewer({ backend: async () => { calls++; throw new Error('must not run'); } }).review(makeRequest());
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'invalid_input');
    assert(!Object.hasOwn(result, 'decision'));
    assert.equal(calls, 0);
  });
}

const invalidResponses = [
  ['wrong request', response => { response.request_id = 'other-request'; }],
  ['wrong action', response => { response.snapshot_id = 'sha256:' + '0'.repeat(64); }],
  ['wrong policy', response => { response.policy.version = '0.2.0'; }],
  ['unknown authority reference', response => { response.authority_refs = ['invented-human']; }],
  ['unknown evidence reference', response => { response.evidence_refs = ['invented-document']; }],
  ['allow without verified authority reference', response => { response.authority_refs = []; }],
  ['unrecognized property', response => { response.execute = true; }],
  ['model-provided metadata', response => { response.metadata = { duration_ms: 0, usage: { input_tokens: 0 } }; }],
];
for (const [name, mutate] of invalidResponses) {
  test(`${name} is rejected without retries`, async () => {
    const request = input();
    let calls = 0;
    const result = await createReviewer({ backend: async ({ request }) => {
      calls++;
      const response = decision(request);
      mutate(response);
      return { output: JSON.stringify(response) };
    } }).review(request);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'invalid_response');
    assert(!Object.hasOwn(result, 'decision'));
    assertBound(result, request);
    assert.equal(calls, 1);
  });
}

for (const output of ['not JSON', '[]', '{} extra', '```json\n{}\n```', '{"decision":"deny","decision":"allow"}']) {
  test(`invalid JSON envelope is not an allow: ${JSON.stringify(output)}`, async () => {
    const result = await createReviewer({ backend: async () => ({ output }) }).review(input());
    assert.equal(result.code, 'invalid_response');
    assert(!Object.hasOwn(result, 'decision'));
  });
}

test('model-provided technical error is not accepted as an actual backend failure', async () => {
  const request = input();
  const result = await createReviewer({ backend: async ({ request }) => ({ output: JSON.stringify({ ...bind(request), status: 'error', code: 'backend_error', message: 'Invented failure' }) }) }).review(request);
  assert.equal(result.code, 'invalid_response');
});

test('backend exception produces a generic technical error and no retry', async () => {
  const request = input();
  const secret = 'synthetic-private-provider-detail';
  let calls = 0;
  const result = await createReviewer({ backend: async () => { calls++; throw new Error(secret); } }).review(request);
  assert.equal(result.code, 'backend_error');
  assert(!JSON.stringify(result).includes(secret));
  assert(!Object.hasOwn(result, 'decision'));
  assertBound(result, request);
  assert.equal(calls, 1);
});

test('timeout returns while a backend ignores cancellation and ignores its late allow', { timeout: 1500 }, async () => {
  const request = input();
  const late = deferred();
  let signal;
  let calls = 0;
  const result = await createReviewer({ timeoutMs: 15, backend: async (_, options) => { calls++; signal = options.signal; return late.promise; } }).review(request);
  assert.equal(result.code, 'timeout');
  assert(signal.aborted);
  assert.equal(calls, 1);
  late.resolve(reply(request));
  await turn();
  assert.equal(result.code, 'timeout');
  assert(!Object.hasOwn(result, 'decision'));
});

test('pre-cancelled request never contacts the backend', async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  let calls = 0;
  const result = await createReviewer({ backend: async ({ request }) => { calls++; return reply(request); } }).review(input(), { signal: cancellation.signal });
  assert.equal(result.code, 'cancelled');
  assert.equal(calls, 0);
});

test('cancellation settles even when backend ignores the signal', { timeout: 1500 }, async () => {
  const request = input();
  const cancellation = new AbortController();
  const started = deferred();
  const late = deferred();
  let backendSignal;
  const reviewer = createReviewer({ backend: async (_, { signal }) => { backendSignal = signal; started.resolve(); return late.promise; } });
  const pending = reviewer.review(request, { signal: cancellation.signal });
  await started.promise;
  cancellation.abort();
  const result = await pending;
  assert.equal(result.code, 'cancelled');
  assert(backendSignal.aborted);
  late.resolve(reply(request));
  await turn();
  assert.equal(result.code, 'cancelled');
});

test('concurrent requests retain separate identities, routes and decisions', async () => {
  const first = input();
  const second = input();
  second.request_id = 'request-parallel';
  second.action.call_id = 'call-parallel';
  withSnapshot(second);
  const ready = deferred();
  const calls = new Map();
  const reviewer = createReviewer({ backend: async ({ request }) => {
    const completion = deferred();
    calls.set(request.request_id, { request, completion });
    if (calls.size === 2) ready.resolve();
    return completion.promise;
  } });
  const firstPending = reviewer.review(first);
  const secondPending = reviewer.review(second);
  await ready.promise;
  calls.get(second.request_id).completion.resolve(reply(second, { decision: 'deny' }, { route: { provider: 'synthetic', model: 'second' } }));
  const secondResult = await secondPending;
  calls.get(first.request_id).completion.resolve(reply(first, undefined, { route: { provider: 'synthetic', model: 'first' } }));
  const firstResult = await firstPending;
  assert.equal(firstResult.decision, 'allow');
  assert.equal(firstResult.metadata.route.model, 'first');
  assertBound(firstResult, first);
  assert.equal(secondResult.decision, 'deny');
  assert.equal(secondResult.metadata.route.model, 'second');
  assertBound(secondResult, second);
});

test('diagnostics contain no request text, raw response reason or action arguments', async () => {
  const request = input();
  request.authority[0].text = 'synthetic-secret-task-text';
  request.action.arguments.command = 'synthetic-secret-command';
  withSnapshot(request);
  const events = [];
  const result = await createReviewer({ backend: async ({ request }) => reply(request, { reason: 'synthetic-secret-response-reason' }), onEvent: event => { events.push(event); } }).review(request);
  assert.equal(result.decision, 'allow');
  await turn();
  assert.equal(events.length, 1);
  const text = JSON.stringify(events);
  assert(!text.includes('synthetic-secret'));
  assert(!text.includes('authority_refs'));
  assert(!text.includes('arguments'));
});

for (const observer of [() => { throw new Error('observer failure'); }, async () => { throw new Error('observer failure'); }, () => new Promise(() => {})]) {
  test('diagnostic observer failure or delay cannot change the review result', { timeout: 1500 }, async () => {
    const result = await createReviewer({ backend: async ({ request }) => reply(request), onEvent: observer }).review(input());
    assert.equal(result.decision, 'allow');
    await turn();
  });
}

test('allow responses are not cached or reused for the next review', async () => {
  let calls = 0;
  const reviewer = createReviewer({ backend: async ({ request }) => { calls++; return reply(request, { decision: calls === 1 ? 'allow' : 'deny' }); } });
  assert.equal((await reviewer.review(input())).decision, 'allow');
  assert.equal((await reviewer.review(input())).decision, 'deny');
  assert.equal(calls, 2);
});

test('a synchronous backend cannot return allow after the monotonic deadline', async () => {
  let backendSignal;
  const reviewer = createReviewer({ timeoutMs: 5, backend: ({ request }, { signal }) => {
    backendSignal = signal;
    const until = performance.now() + 20;
    while (performance.now() < until) {}
    return reply(request);
  } });
  const result = await reviewer.review(input());
  assert.equal(result.code, 'timeout');
  assert.equal(result.status, 'error');
  assert(backendSignal.aborted);
});


test('unclassified host effect metadata is assessed by the backend using the exact tool', async () => {
  const request = input();
  request.action.effects = [{ kind: 'unknown', targets: [] }];
  withSnapshot(request);
  let calls = 0;
  const result = await createReviewer({ backend: async ({ request }) => {
    calls++;
    assert.equal(request.action.effects[0].kind, 'unknown');
    assert.equal(request.action.arguments.command, 'npm test');
    return reply(request);
  } }).review(request);
  assert.equal(calls, 1);
  assert.equal(result.decision, 'allow');
});


test('explicitly selected ordinary evidence does not imply lost authority', async () => {
  const request = input();
  request.completeness.evidence = 'selected';
  let calls = 0;
  const reviewer = createReviewer({ backend: async ({ request }) => { calls++; return reply(request); } });
  assert.equal((await reviewer.review(request)).decision, 'allow');
  assert.equal(calls, 1);
  request.completeness.authority = 'incomplete';
  request.completeness.omissions = ['A required constraint was not retained.'];
  assert.equal((await reviewer.review(request)).decision, 'ask');
  assert.equal(calls, 1);
});

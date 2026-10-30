import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBackend } from '../src/backend.js';

const input = { request: { request_id: 'synthetic-request', authority: [] }, policy: { text: 'Synthetic authorization policy.' }, responseSchema: { type: 'object' } };
const route = { mode: 'fixed', provider: 'synthetic-provider', model: 'synthetic-reviewer' };
const finish = { type: 'finish', reason: { kind: 'stop' } };
const end = (text, index = 0) => ({ type: 'block-end', index, block: { type: 'text', text } });
const reply = [end('{"decision":"ask"}'), finish];
const agent = config => ({ session: { requestHeader: () => ({ config }) } });
function setup(chunks = reply, config = { provider: 'main-provider', model: 'main-model', reasoningEffort: 'max' }) {
  const calls = [];
  const ctx = { llm: { async *stream(options) { calls.push(options); yield* chunks; } } };
  return { ctx, calls, main: config, agent: agent(config) };
}
const execute = async (chunks, selected = route) => {
  const fixture = setup(chunks);
  const result = await makeBackend(fixture.ctx, fixture.agent, selected)(input, { signal: new AbortController().signal });
  return { ...fixture, result };
};

test('fixed route makes one tool-free request without inheriting main reasoning effort', async () => {
  const { result, calls, main } = await execute(reply);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, route.provider);
  assert.equal(calls[0].model, route.model);
  assert.equal(calls[0].temperature, 0);
  assert(!Object.hasOwn(calls[0], 'reasoningEffort'));
  assert(!Object.hasOwn(calls[0], 'tools'));
  assert.equal(calls[0].system, input.policy.text + '\n\nReturn exactly one JSON object matching this response schema. Do not execute any action or emit tools.\n' + JSON.stringify(input.responseSchema));
  assert.deepEqual(JSON.parse(calls[0].messages[0].content[0].text), input.request);
  assert.equal(main.model, 'main-model');
  assert.equal(main.reasoningEffort, 'max');
  assert.equal(result.output, '{"decision":"ask"}');
  assert.deepEqual(result.route, { provider: route.provider, model: route.model });
  assert(!Object.hasOwn(result, 'usage'));
  assert(Object.isFrozen(calls[0]));
  assert(Object.isFrozen(calls[0].messages[0].content));
});

test('inherited route is captured before the main session config changes', async () => {
  const fixture = setup();
  const backend = makeBackend(fixture.ctx, fixture.agent, { mode: 'inherit' });
  fixture.main.provider = 'changed-provider';
  fixture.main.model = 'changed-model';
  fixture.main.reasoningEffort = 'low';
  await backend(input, { signal: new AbortController().signal });
  assert.equal(fixture.calls[0].provider, 'main-provider');
  assert.equal(fixture.calls[0].model, 'main-model');
  assert.equal(fixture.calls[0].reasoningEffort, 'max');
});

test('fixed route supports an explicitly selected effort without changing another call', async () => {
  const fixture = setup();
  const first = makeBackend(fixture.ctx, fixture.agent, { ...route, reasoningEffort: 'low' });
  const second = makeBackend(fixture.ctx, fixture.agent, { ...route, model: 'another-reviewer' });
  await Promise.all([first(input, { signal: new AbortController().signal }), second(input, { signal: new AbortController().signal })]);
  assert.equal(fixture.calls[0].reasoningEffort, 'low');
  assert(!Object.hasOwn(fixture.calls[1], 'reasoningEffort'));
  assert.equal(fixture.calls[1].model, 'another-reviewer');
});

test('reasoning and final text deltas assemble without returning reasoning', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Synthetic private reasoning.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Synthetic private reasoning.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '{"decision":' },
    { type: 'text-delta', index: 1, text: '"allow"}' },
    end('{"decision":"allow"}', 1),
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } },
    finish,
  ];
  const { result } = await execute(chunks);
  assert.equal(result.output, '{"decision":"allow"}');
  assert(!JSON.stringify(result).includes('private reasoning'));
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 });
});

test('delta-only output uses explicit stop and final usage omits unknown values', async () => {
  const { result } = await execute([
    { type: 'text-delta', index: 1, text: '{}' },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 3 } },
    { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: 4, totalTokens: -1 } },
    finish,
  ]);
  assert.equal(result.output, '{}');
  assert.deepEqual(result.usage, { output_tokens: 4 });
});

for (const [name, chunks] of [
  ['missing terminal finish', [end('{}')]],
  ['error finish', [end('{}'), { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic backend failure' } } }]],
  ['aborted finish', [end('{}'), { type: 'finish', reason: { kind: 'aborted' } }]],
  ['max token finish', [end('{}'), { type: 'finish', reason: { kind: 'max-tokens' } }]],
  ['data after finish', [end('{}'), finish, { type: 'text-delta', index: 0, text: 'extra' }]],
  ['two text blocks', [end('{}'), end('{}', 1), finish]],
  ['reasoning after text', [end('{}'), { type: 'reasoning-delta', index: 1, text: 'later reasoning' }, finish]],
  ['tool delta', [{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'synthetic_tool', argumentsDelta: '{}' }, finish]],
  ['tool block', [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'synthetic_tool', arguments: '{}' } }, finish]],
  ['attachment', [{ type: 'block-end', index: 0, block: { type: 'image', url: 'synthetic' } }, finish]],
  ['conflicting canonical output', [{ type: 'text-delta', index: 0, text: '{"decision":"deny"}' }, end('{"decision":"allow"}'), finish]],
  ['delta after completed block', [end('{}'), { type: 'text-delta', index: 0, text: 'extra' }, finish]],
  ['repeated start', [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-start', index: 0, blockType: 'text' }, finish]],
  ['invalid index', [{ type: 'text-delta', index: -1, text: '{}' }, finish]],
  ['unsupported event', [{ type: 'unknown' }, finish]],
  ['no text', [{ type: 'reasoning-delta', index: 0, text: 'Synthetic reasoning.' }, finish]],
  ['oversize output', [end('x'.repeat(64 * 1024 + 1)), finish]],
  ['oversize delta', [{ type: 'text-delta', index: 0, text: 'x'.repeat(64 * 1024 + 1) }, finish]],
  ['oversize reasoning', [{ type: 'reasoning-delta', index: 0, text: 'x'.repeat(512 * 1024 + 1) }, finish]],
]) {
  test(`invalid reviewer stream rejects: ${name}`, async () => {
    const fixture = setup(chunks);
    await assert.rejects(makeBackend(fixture.ctx, fixture.agent, route)(input, { signal: new AbortController().signal }));
    assert.equal(fixture.calls.length, 1);
    assert(fixture.calls[0].signal.aborted, 'invalid stream must cancel provider work');
  });
}

test('provider exception is not retried', async () => {
  let calls = 0;
  const ctx = { llm: { async *stream() { calls++; throw new Error('Synthetic provider error.'); } } };
  await assert.rejects(makeBackend(ctx, agent({}), route)(input, { signal: new AbortController().signal }));
  assert.equal(calls, 1);
});

test('a cancelled input makes no model request', async () => {
  const fixture = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(makeBackend(fixture.ctx, fixture.agent, route)(input, { signal: controller.signal }));
  assert.equal(fixture.calls.length, 0);
});

test('abort settles a backend whose stream ignores cancellation and closes its iterator', async () => {
  let closed = 0;
  let passedSignal;
  const ctx = { llm: { stream(options) {
    passedSignal = options.signal;
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => { closed++; return Promise.resolve({ done: true }); } }; } };
  } } };
  const controller = new AbortController();
  const pending = makeBackend(ctx, agent({}), route)(input, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending);
  assert(passedSignal.aborted);
  assert.equal(closed, 1);
});

test('invalid routing fails before any provider request', () => {
  const fixture = setup();
  for (const selected of [{ mode: 'other' }, { mode: 'fixed', provider: '', model: 'm' }, { mode: 'fixed', provider: 'p', model: '' }, { ...route, reasoningEffort: '' }]) {
    assert.throws(() => makeBackend(fixture.ctx, fixture.agent, selected));
  }
  assert.throws(() => makeBackend(fixture.ctx, agent(undefined), { mode: 'inherit' }));
  assert.equal(fixture.calls.length, 0);
});

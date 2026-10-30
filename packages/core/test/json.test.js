import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, parseOutput, snapshotJson } from '../src/json.js';

const nested = depth => Array.from({ length: depth }).reduce(value => [value], null);

test('snapshots detach and freeze shared descendants without prototype pollution', () => {
  const shared = { value: 1 };
  const input = { one: shared, two: shared, list: [null, true, 3, 'text'] };
  Object.defineProperty(input, '__proto__', { value: { safe: true }, enumerable: true });
  const snapshot = snapshotJson(input);
  shared.value = 9;
  assert.equal(snapshot.one.value, 1);
  assert.notEqual(snapshot.one, snapshot.two);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.one));
  assert(Object.isFrozen(snapshot.list));
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.equal(snapshot.__proto__.safe, true);
  assert.equal({}.safe, undefined);
  assert.deepEqual(snapshotJson(Object.assign(Object.create(null), { x: 1 })), { x: 1 });
});

test('snapshots reject values JSON serialization would omit or silently transform', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => {}, new Date(), new Map(), { value: undefined }]) {
    assert.throws(() => snapshotJson(value), TypeError);
  }
  assert.throws(() => snapshotJson({ [Symbol('x')]: 1 }), TypeError);
  assert.throws(() => snapshotJson(Object.defineProperty({}, 'hidden', { value: 1 })), TypeError);
  assert.throws(() => snapshotJson(Object.create({ inherited: 1 })), TypeError);
  assert.throws(() => snapshotJson(new Proxy({}, {})), TypeError);
});

test('snapshot validation does not invoke getters', () => {
  let reads = 0;
  const input = { get unsafe() { reads++; return 1; } };
  assert.throws(() => snapshotJson(input), TypeError);
  assert.equal(reads, 0);
  const array = [1];
  Object.defineProperty(array, '0', { get() { reads++; return 1; }, enumerable: true });
  assert.throws(() => snapshotJson(array), TypeError);
  assert.equal(reads, 0);
});

test('snapshots reject sparse arrays, extra properties and custom array prototypes', () => {
  assert.throws(() => snapshotJson(new Array(2)), TypeError);
  assert.throws(() => snapshotJson([, 1]), TypeError);
  assert.throws(() => snapshotJson(Object.assign([1], { extra: true })), TypeError);
  assert.throws(() => snapshotJson(Object.assign([1], { '01': true })), TypeError);
  const hidden = [1];
  Object.defineProperty(hidden, '0', { value: 1, enumerable: false });
  assert.throws(() => snapshotJson(hidden), TypeError);
  class CustomArray extends Array {}
  assert.throws(() => snapshotJson(new CustomArray(1)), TypeError);
});

test('snapshots reject cycles but accept repeated references', () => {
  const input = {};
  input.self = input;
  assert.throws(() => snapshotJson(input), TypeError);
  const list = [];
  list.push(list);
  assert.throws(() => snapshotJson(list), TypeError);
  const shared = { value: 1 };
  assert.deepEqual(snapshotJson([shared, shared]), [{ value: 1 }, { value: 1 }]);
});

test('snapshot nesting and byte limits include JSON syntax and UTF-8 bytes', () => {
  assert.deepEqual(snapshotJson(nested(64)), nested(64));
  assert.throws(() => snapshotJson(nested(65)), RangeError);
  assert.equal(snapshotJson('x'.repeat(1024 * 1024 - 2)).length, 1024 * 1024 - 2);
  assert.throws(() => snapshotJson('x'.repeat(1024 * 1024 - 1)), RangeError);
  assert.throws(() => snapshotJson('€'.repeat(350000)), RangeError);
  assert.throws(() => snapshotJson('\n'.repeat(524288)), RangeError);
});

test('canonical encoding sorts object keys by JS string order and preserves arrays', () => {
  assert.equal(canonicalJson({ z: 1, a: { '2': 'two', '10': 'ten', a: true }, list: [3, 2, 1] }), '{"a":{"10":"ten","2":"two","a":true},"list":[3,2,1],"z":1}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ missing: undefined }), TypeError);
});

test('reviewer output parses one detached, deeply frozen JSON object', () => {
  const result = parseOutput(' \n {"decision":"allow","refs":[{"id":"human-1"}]} \t');
  assert.equal(result.decision, 'allow');
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.refs));
  assert(Object.isFrozen(result.refs[0]));
  assert.deepEqual(parseOutput('{"__proto__":{"safe":true}}').__proto__, { safe: true });
  assert.equal({}.safe, undefined);
});

test('reviewer output rejects duplicate keys, including escaped equivalents', () => {
  for (const text of ['{"decision":"allow","decision":"deny"}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}', '{"items":[{"a":1,"a":2}]}']) {
    assert.throws(() => parseOutput(text), /duplicate object keys/);
  }
  assert.deepEqual(parseOutput('{"items":[{"a":1},{"a":2}]}'), { items: [{ a: 1 }, { a: 2 }] });
});

test('reviewer output rejects Markdown, extra text, multiple values and nonobjects', () => {
  for (const text of ['```json\n{}\n```', '{} done', '{} {}', 'null', '[]', '1', 'true', '"text"', '{"a":}', '']) {
    assert.throws(() => parseOutput(text), TypeError);
  }
  assert.throws(() => parseOutput({}), TypeError);
  assert.throws(() => parseOutput('{"number":1e999}'), TypeError);
});

test('reviewer output enforces byte and nesting limits', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
  assert.equal(Buffer.byteLength(JSON.stringify({ value: 'x'.repeat(65536 - overhead) })), 65536);
  assert.equal(parseOutput(JSON.stringify({ value: 'x'.repeat(65536 - overhead) })).value.length, 65536 - overhead);
  assert.throws(() => parseOutput(JSON.stringify({ value: 'x'.repeat(65537 - overhead) })), RangeError);
  assert.deepEqual(parseOutput(JSON.stringify({ value: nested(63) })), { value: nested(63) });
  assert.throws(() => parseOutput(JSON.stringify({ value: nested(64) })), RangeError);
});

test('negative zero cannot alias zero in an exact action snapshot', () => {
  assert.throws(() => snapshotJson({ divisor: -0 }), TypeError);
  assert.throws(() => canonicalJson({ divisor: -0 }), TypeError);
  assert.throws(() => parseOutput('{"divisor":-0}'), TypeError);
  assert.equal(canonicalJson({ divisor: 0 }), '{"divisor":0}');
});

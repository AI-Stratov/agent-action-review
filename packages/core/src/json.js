// Strict JSON snapshots and reviewer output parsing.
import { types } from 'node:util';

const INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const DEPTH_LIMIT = 64;

export function snapshotJson(value) {
  const ancestors = new Set();
  let bytes = 0;
  const charge = text => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > INPUT_LIMIT) throw new RangeError('JSON input exceeds 1 MiB');
  };
  const visit = (current, depth) => {
    if (depth > DEPTH_LIMIT) throw new RangeError('JSON nesting exceeds 64 levels');
    if (current === null || typeof current === 'boolean' || typeof current === 'string' || typeof current === 'number') {
      if (typeof current === 'number' && (!Number.isFinite(current) || Object.is(current, -0))) throw new TypeError('JSON numbers must be finite and cannot be negative zero');
      if (typeof current === 'string' && Buffer.byteLength(current, 'utf8') > INPUT_LIMIT) throw new RangeError('JSON input exceeds 1 MiB');
      charge(JSON.stringify(current));
      return current;
    }
    if (typeof current !== 'object') throw new TypeError('Value is not JSON');
    if (types.isProxy(current)) throw new TypeError('JSON values cannot be proxies');
    if (ancestors.has(current)) throw new TypeError('JSON values cannot contain cycles');
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('JSON objects must have a plain prototype');
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key === 'symbol')) throw new TypeError('JSON values cannot have symbol properties');
    ancestors.add(current);
    try {
      charge(array ? '[]' : '{}');
      const copy = array ? [] : {};
      if (array) {
        const length = Object.getOwnPropertyDescriptor(current, 'length').value;
        if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw new TypeError('JSON arrays must be dense and have no extra properties');
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('JSON arrays must have enumerable data elements');
          if (index) charge(',');
          copy.push(visit(descriptor.value, depth + 1));
        }
      } else {
        for (const [index, key] of keys.entries()) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('JSON objects must have enumerable data properties');
          if (index) charge(',');
          charge(JSON.stringify(key) + ':');
          Object.defineProperty(copy, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
        }
      }
      return Object.freeze(copy);
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

export function canonicalJson(value) {
  const snapshot = snapshotJson(value);
  const encode = current => {
    if (current === null || typeof current !== 'object') return JSON.stringify(current);
    if (Array.isArray(current)) return '[' + current.map(encode).join(',') + ']';
    return '{' + Object.keys(current).sort().map(key => JSON.stringify(key) + ':' + encode(current[key])).join(',') + '}';
  };
  return encode(snapshot);
}

export function parseOutput(text) {
  if (typeof text !== 'string') throw new TypeError('Reviewer output must be JSON text');
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_LIMIT) throw new RangeError('Reviewer output exceeds 64 KiB');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError('Reviewer output must contain one JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Reviewer output must contain one JSON object');
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let cursor = 0;
  const scan = depth => {
    if (depth > DEPTH_LIMIT) throw new RangeError('JSON nesting exceeds 64 levels');
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set();
      if (tokens[cursor] === '}') { cursor++; return; }
      while (true) {
        const key = JSON.parse(tokens[cursor++]);
        if (keys.has(key)) throw new TypeError('Reviewer output contains duplicate object keys');
        keys.add(key);
        cursor++;
        scan(depth + 1);
        if (tokens[cursor++] === '}') return;
      }
    }
    if (token === '[') {
      if (tokens[cursor] === ']') { cursor++; return; }
      while (true) {
        scan(depth + 1);
        if (tokens[cursor++] === ']') return;
      }
    }
  };
  scan(0);
  return snapshotJson(parsed);
}

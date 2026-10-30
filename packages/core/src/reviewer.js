import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import requestSchema from '../schemas/request.schema.json' with { type: 'json' };
import responseSchema from '../schemas/response.schema.json' with { type: 'json' };
import policy from '../policies/task-authorization-0.1.0.json' with { type: 'json' };
import { snapshotJson, canonicalJson, parseOutput } from './json.js';

export const POLICY = snapshotJson(policy);
export const REQUEST_SCHEMA = snapshotJson(requestSchema);
export const RESPONSE_SCHEMA = snapshotJson(responseSchema);
const modelSchema = structuredClone(responseSchema.oneOf[0]);
delete modelSchema.properties.metadata;
const MODEL_RESPONSE_SCHEMA = snapshotJson(modelSchema);
const ajv = new Ajv2020({ strict: true, allErrors: false });
const validRequest = ajv.compile(requestSchema);
const validModelResponse = ajv.compile(modelSchema);
const validMetadata = ajv.compile(responseSchema.oneOf[0].properties.metadata);

export function snapshotAction(action) {
  const detached = snapshotJson(action);
  if (!detached || Array.isArray(detached) || typeof detached !== 'object') {
    throw new TypeError('An action must be a JSON object.');
  }
  const { snapshot_id, ...body } = detached;
  return 'sha256:' + createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function checkRequest(request) {
  if (!validRequest(request)) throw new TypeError('Invalid review input.');
  if (request.action.snapshot_id !== snapshotAction(request.action)) {
    throw new TypeError('Action snapshot does not match.');
  }
  const ids = [...request.authority, ...request.evidence].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Context ids are not unique.');
  for (const receipt of request.authority.filter(item => item.kind === 'host-approval')) {
    if (receipt.call_id !== request.action.call_id || receipt.snapshot_id !== request.action.snapshot_id) {
      throw new TypeError('Approval receipt does not match the action.');
    }
  }
}

function binding(request) {
  return {
    protocol_version: 1,
    request_id: request.request_id,
    snapshot_id: request.action.snapshot_id,
    policy: request.policy,
  };
}

function localDecision(request) {
  const verified = request.authority.filter(item => item.source.verification === 'host-observed');
  if (request.environment.host_decision === 'deny') {
    return { decision: 'deny', reason: 'The host forbids this action.', authority_refs: [], evidence_refs: [] };
  }
  const rejected = verified.filter(item => item.kind === 'host-approval' && item.decision === 'rejected');
  if (rejected.length) {
    return { decision: 'deny', reason: 'Human approval for this action was rejected.', authority_refs: rejected.map(item => item.id), evidence_refs: [] };
  }
  const incomplete = request.completeness.authority !== 'complete'
    || !['complete', 'selected'].includes(request.completeness.evidence) || request.completeness.omissions.length > 0;
  const unknown = request.action.surface === 'unknown'
    || Object.values(request.environment).some(value => value === 'unknown');
  if (incomplete || unknown || !verified.length || verified.length !== request.authority.length) {
    return { decision: 'ask', reason: 'Verified context and authorization are insufficient for automatic approval.', authority_refs: [], evidence_refs: [] };
  }
}

function checkResponse(request, response) {
  if (!validModelResponse(response)) throw new TypeError('Invalid reviewer response.');
  if (response.request_id !== request.request_id || response.snapshot_id !== request.action.snapshot_id
    || response.policy.id !== request.policy.id || response.policy.version !== request.policy.version) {
    throw new TypeError('Reviewer response does not match the request.');
  }
  const authority = new Map(request.authority.map(item => [item.id, item]));
  const evidence = new Set(request.evidence.map(item => item.id));
  if (response.authority_refs.some(id => !authority.has(id)) || response.evidence_refs.some(id => !evidence.has(id))) {
    throw new TypeError('Reviewer response refers to missing context.');
  }
  if (response.decision === 'allow' && !response.authority_refs.some(id => authority.get(id).source.verification === 'host-observed')) {
    throw new TypeError('Automatic approval has no verified authority reference.');
  }
}

const messages = {
  invalid_input: 'The review input is invalid or exceeds its limits.',
  invalid_response: 'The reviewer returned an invalid response.',
  backend_error: 'The reviewer backend failed.',
  timeout: 'The review timed out.',
  cancelled: 'The review was cancelled.',
};

export function createReviewer({ backend, timeoutMs = 30_000, onEvent } = {}) {
  if (typeof backend !== 'function') throw new TypeError('A reviewer backend is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('The review timeout must be a positive timer duration.');
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');

  return Object.freeze({ async review(input, { signal } = {}) {
    const started = performance.now();
    let request;
    let metadata = {};
    const finish = body => {
      const result = snapshotJson({ ...body, metadata: { ...metadata, duration_ms: Math.max(0, performance.now() - started) } });
      if (onEvent) {
        const event = snapshotJson({ status: result.status, ...(result.status === 'result'
          ? { decision: result.decision } : { code: result.code }), metadata: result.metadata });
        try { Promise.resolve(onEvent(event)).catch(() => {}); } catch {}
      }
      return result;
    };
    const failed = code => finish({ ...(request ? binding(request) : { protocol_version: 1 }), status: 'error', code, message: messages[code] });
    try {
      request = snapshotJson(input);
      checkRequest(request);
    } catch {
      request = undefined;
      return failed('invalid_input');
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) return failed('invalid_input');
    if (signal?.aborted) return failed('cancelled');
    const local = localDecision(request);
    if (local) return finish({ ...binding(request), status: 'result', ...local });

    const lifecycle = new AbortController();
    let stopCode;
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => {
      if (stopCode) return;
      stopCode = code;
      lifecycle.abort();
      rejectStop(new Error(code));
    };
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const deadline = performance.now() + timeoutMs;
    const expired = () => {
      if (!stopCode && performance.now() >= deadline) stop('timeout');
      return stopCode;
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    try {
      const payload = Object.freeze({ request, policy: POLICY, responseSchema: MODEL_RESPONSE_SCHEMA });
      const pending = Promise.resolve().then(() => {
        if (stopCode) throw new Error(stopCode);
        return backend(payload, { signal: lifecycle.signal });
      });
      let raw;
      try {
        raw = await Promise.race([pending, stopped]);
      } catch {
        return failed(expired() ?? 'backend_error');
      }
      if (expired()) return failed(stopCode);
      try {
        const detached = snapshotJson(raw);
        if (!detached || typeof detached.output !== 'string'
          || Object.keys(detached).some(key => !['output', 'route', 'usage'].includes(key))) {
          throw new TypeError('Invalid backend envelope.');
        }
        const supplied = {};
        if (detached.route !== undefined) supplied.route = detached.route;
        if (detached.usage !== undefined) supplied.usage = detached.usage;
        if (!validMetadata(supplied)) throw new TypeError('Invalid backend metadata.');
        const response = parseOutput(detached.output);
        checkResponse(request, response);
        if (expired()) return failed(stopCode);
        metadata = supplied;
        return finish(response);
      } catch {
        return failed(expired() ?? 'invalid_response');
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  } });
}

import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createReviewer } from '@agent-action-review/core';
import { makeBackend } from './backend.js';
import { buildReviewRequest, createContextProjection } from './context.js';

export const name = 'action-review';
export const inject = ['loader', 'llm', 'approval', 'permissionPresets', 'sessions', 'tools', 'sessionProjections', 'shell'];
export const Config = Schema.object({
  mode: Schema.union(['inherit', 'fixed']).default('inherit').description('Use the agent model or a separate reviewer model.'),
  provider: Schema.string().default('').description('Configured provider id for fixed reviewer routing.'),
  model: Schema.string().default('').description('Configured model id for fixed reviewer routing.'),
  timeoutMs: Schema.number().min(1).max(2147483647).step(1).default(30000).description('Maximum model review time in milliseconds.'),
  contextBytes: Schema.number().min(1024).max(524288).step(1).default(131072).description('Maximum retained instruction and selected evidence bytes per review.'),
  metrics: Schema.boolean().default(false).description('Record local timing and outcome metadata without prompts or arguments.'),
});
const source = z.object({ session_id: z.string(), event_id: z.string(), verification: z.enum(['host-observed', 'unknown']) }).strict();
const authority = z.object({ id: z.string(), kind: z.enum(['human', 'direct-parent']), text: z.string(), source }).strict();
const evidence = z.object({ id: z.string(), kind: z.enum(['document', 'tool-result', 'checkpoint', 'constraint', 'agent-message']), text: z.string(), source_id: z.string() }).strict();
const stateSchema = z.object({
  sessionId: z.string(), parentSession: z.string().nullable(), child: z.boolean(), inherited: z.number().int().nonnegative(),
  boundary: z.boolean(), initialSeen: z.boolean(), authority: z.array(authority), evidence: z.array(evidence),
  bytes: z.number().int().nonnegative(), authorityComplete: z.boolean(), evidenceComplete: z.boolean(), omissions: z.array(z.string()),
}).strict();

function settings(value) {
  const config = Config(value);
  if (config.mode === 'fixed' && (!config.provider.trim() || !config.model.trim())) {
    throw new TypeError('Fixed review requires a configured provider and model.');
  }
  return Object.freeze({ ...config });
}

function waitFor(pending, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

function authorization(request) {
  return createHash('sha256').update(JSON.stringify({
    action: request.action.snapshot_id,
    authority: request.authority,
    constraints: request.evidence.filter(item => item.kind === 'constraint'),
    environment: request.environment,
    completeness: request.completeness.authority,
    omissions: request.completeness.omissions,
  })).digest('hex');
}

export async function apply(ctx, rawConfig) {
  let config = settings(rawConfig);
  let accepting = true;
  const lifecycle = new AbortController();
  const active = new Set();
  const { appendPluginRecord } = await ctx.loader.import('@deepseek-ai/dsh-session');
  const record = (session, type, data) => {
    try { appendPluginRecord(session, type, data); } catch {}
  };
  ctx.on('internal/update', function (value) {
    const next = settings(value);
    config = next;
    this.config = value;
  });
  ctx.effect(function* () {
    yield ctx.sessionProjections.register(createContextProjection({ maxBytes: 524288, stateSchema }));
    yield ctx.permissionPresets.registerAuto(() => {
      if (!accepting || lifecycle.signal.aborted) throw new Error('Action Review is stopping.');
    });
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      const agent = exec.agent;
      if (!agent || exec.parent === undefined && exec.name === 'run_code') return next();
      if (ctx.permissionPresets.current(agent.session) !== 'auto') return next();
      if (!accepting) return { kind: 'cancel' };
      const signal = AbortSignal.any([exec.signal, lifecycle.signal]);
      const completed = Promise.withResolvers();
      active.add(completed.promise);
      const captured = config;
      const started = performance.now();
      let outcome = 'cancelled';
      let reviewMetadata;
      if (captured.metrics) record(agent.session, 'plugin:action-review/start', { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId, tool: exec.name });
      try {
        const host = await waitFor(next(), signal);
        if (host.kind === 'deny' || host.kind === 'cancel') { outcome = 'host-' + host.kind; return host; }
        if (host.kind !== 'allow' && host.kind !== 'ask') throw new Error('Unsupported host decision.');
        const options = { contextBytes: captured.contextBytes, hostDecision: host.kind };
        const request = buildReviewRequest(ctx, exec, options);
        const fingerprint = authorization(request);
        const current = () => {
          if (!accepting || signal.aborted || ctx.permissionPresets.current(agent.session) !== 'auto') return false;
          return authorization(buildReviewRequest(ctx, exec, { ...options, requestId: request.request_id })) === fingerprint;
        };
        const reviewer = createReviewer({ backend: makeBackend(ctx, agent, captured), timeoutMs: captured.timeoutMs });
        const result = await reviewer.review(request, { signal });
        reviewMetadata = result.metadata;
        if (!current()) return { kind: 'cancel' };
        if (result.status === 'error') {
          outcome = result.code;
          return { kind: 'deny', reason: result.message, info: { code: 'ACTION_REVIEW_ERROR', reviewCode: result.code } };
        }
        outcome = result.decision;
        if (result.decision === 'deny') return { kind: 'deny', reason: result.reason, info: { code: 'ACTION_REVIEW_DENIED' } };
        if (result.decision === 'ask' || host.kind === 'ask') {
          const granted = await ctx.approval.request({
            agent, toolName: exec.name, callId: exec.callId,
            reason: host.kind === 'ask' ? host.reason ?? result.reason : result.reason,
            ...(host.kind === 'ask' && host.displayReason ? { displayReason: host.displayReason } : {}),
            signal,
          });
          if (!current() || granted === 'cancelled') { outcome = 'cancelled'; return { kind: 'cancel' }; }
          outcome = granted;
          if (granted !== 'allowed-once') return { kind: 'deny', reason: 'Human approval was not granted for this action.' };
        }
        return { kind: 'allow' };
      } catch {
        if (signal.aborted || !accepting) return { kind: 'cancel' };
        outcome = 'context_unavailable';
        return { kind: 'deny', reason: 'Action Review could not verify this action. Its body was not executed.', info: { code: 'ACTION_REVIEW_ERROR', reviewCode: 'context_unavailable' } };
      } finally {
        if (captured.metrics) record(agent.session, 'plugin:action-review/end', {
          callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId, tool: exec.name,
          elapsedMs: Math.max(0, performance.now() - started), outcome,
          ...(reviewMetadata ? { review: reviewMetadata } : {}),
        });
        active.delete(completed.promise);
        completed.resolve();
      }
    }, { prepend: true });
    yield async () => {
      accepting = false;
      lifecycle.abort();
      let failed = false;
      for (const session of ctx.sessions.list()) {
        try {
          if (ctx.permissionPresets.current(session) === 'auto') ctx.permissionPresets.set(session, 'workspace-write');
        } catch { failed = true; }
      }
      await Promise.allSettled([...active]);
      if (failed) throw new Error('Action Review stopped, but a session permission reset failed. Check session permissions before resuming.');
    };
  }, 'action-review lifecycle');
}

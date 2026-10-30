// Source-labelled, bounded review context from public session projections.
import { createHash, randomUUID } from 'node:crypto';
import { POLICY, snapshotAction } from '@agent-action-review/core';

export const CONTEXT_KEY = 'agent-action-review:context';
const sizeOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clone = value => structuredClone(value);
const limitOf = value => {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 524288) throw new RangeError('Review context limit must be between 1024 and 524288 bytes.');
  return value;
};
const missingAuthority = (state, reason) => ({
  ...state,
  authorityComplete: false,
  omissions: state.omissions.includes(reason) ? state.omissions : [...state.omissions, reason],
});

function retain(state, role, entry, maxBytes) {
  const protectedEntry = role === 'authority' || entry.kind === 'constraint';
  const bytes = sizeOf(entry);
  if (bytes > maxBytes) return protectedEntry ? missingAuthority(state, 'authority-entry-limit') : { ...state, evidenceComplete: false };
  const evidence = [...state.evidence];
  let used = state.bytes;
  let selected = !state.evidenceComplete;
  while (used + bytes > maxBytes) {
    const index = evidence.findIndex(item => item.kind !== 'constraint');
    if (index < 0) break;
    used -= sizeOf(evidence.splice(index, 1)[0]);
    selected = true;
  }
  const next = { ...state, evidence, bytes: used, evidenceComplete: !selected };
  if (used + bytes > maxBytes) return protectedEntry ? missingAuthority(next, 'authority-context-limit') : { ...next, evidenceComplete: false };
  return {
    ...next,
    bytes: used + bytes,
    authority: role === 'authority' ? [...next.authority, entry] : next.authority,
    evidence: role === 'evidence' ? [...evidence, entry] : evidence,
  };
}

function userMessage(state, event, maxBytes) {
  const source = event.data.source ?? {};
  const own = event.seq >= state.inherited;
  const human = source.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId.length > 0;
  const firstUser = own && state.child && state.boundary && !state.initialSeen && source.kind === 'user';
  const parent = firstUser && !human || own && typeof state.parentSession === 'string' && state.parentSession.length > 0 && source.kind === 'agent-message' && source.senderSessionId === state.parentSession;
  let next = firstUser ? { ...state, initialSeen: true } : state;
  for (const [index, block] of (event.data.content ?? []).entries()) {
    const id = `event:${event.seq}:${index}`;
    if (block.type !== 'text' || typeof block.text !== 'string') {
      next = source.kind === 'agent-instructions' ? missingAuthority(next, 'unsupported-constraint-content') : { ...next, evidenceComplete: false };
      continue;
    }
    if (!block.text) continue;
    if (human || parent) {
      next = retain(next, 'authority', { id, kind: human ? 'human' : 'direct-parent', text: block.text, source: { session_id: state.sessionId, event_id: `event:${event.seq}`, verification: 'host-observed' } }, maxBytes);
    } else {
      const kind = source.kind === 'compact-checkpoint' ? 'checkpoint' : source.kind === 'agent-instructions' ? 'constraint' : 'agent-message';
      next = retain(next, 'evidence', { id, kind, text: block.text, source_id: `event:${event.seq}` }, maxBytes);
    }
  }
  return next;
}

function toolEvidence(state, event, maxBytes) {
  const isCall = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start';
  const content = event.data.message?.content ?? event.data.content ?? [];
  const text = isCall ? JSON.stringify({ type: event.type, name: event.data.name, arguments: event.data.arguments, call_id: event.data.callId ?? event.data.subCallId })
    : content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  let next = state;
  if (!isCall && content.some(block => block.type !== 'text')) next = { ...next, evidenceComplete: false };
  if (!text) return next;
  return retain(next, 'evidence', { id: `event:${event.seq}:tool`, kind: isCall ? 'document' : 'tool-result', text, source_id: `event:${event.seq}` }, maxBytes);
}

export function createContextProjection({ maxBytes = 131072, stateSchema } = {}) {
  limitOf(maxBytes);
  if (!stateSchema || typeof stateSchema.parse !== 'function') throw new TypeError('A projection state schema is required.');
  return {
    key: CONTEXT_KEY,
    stateVersion: 1,
    stateSchema,
    init: (header, inherited) => ({ sessionId: header.id, parentSession: header.parentSession ?? null, child: header.origin === 'subagent', inherited, boundary: false, initialSeen: false, authority: [], evidence: [], bytes: 0, authorityComplete: true, evidenceComplete: true, omissions: [] }),
    apply(state, event) {
      if (event.type === 'subagent/descriptor' && state.child && event.seq >= state.inherited) return { ...state, boundary: true };
      if (event.type === 'user/message') return userMessage(state, event, maxBytes);
      if (event.type === 'developer/message' && event.data.message?.source?.kind === 'agent-instructions') return userMessage(state, { ...event, data: event.data.message }, maxBytes);
      if (['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type)) return toolEvidence(state, event, maxBytes);
      return state;
    },
  };
}

export function buildReviewRequest(ctx, exec, { projectionKey = CONTEXT_KEY, contextBytes = 131072, requestId = randomUUID(), hostDecision = 'allow' } = {}) {
  limitOf(contextBytes);
  const session = exec.agent?.session;
  if (!session) throw new TypeError('A review requires an agent session.');
  if (typeof exec.callId !== 'string' || !exec.callId) throw new TypeError('A pending tool call requires a call identity.');
  const state = ctx.sessionProjections.stateOf(session, projectionKey);
  if (!state) throw new Error('The review context projection is unavailable.');
  let bounded = { ...state, authority: [], evidence: [], bytes: 0 };
  for (const entry of state.authority) bounded = retain(bounded, 'authority', entry, contextBytes);
  for (const entry of [...state.evidence.filter(item => item.kind === 'constraint'), ...state.evidence.filter(item => item.kind !== 'constraint')]) bounded = retain(bounded, 'evidence', entry, contextBytes);
  const tool = ctx.tools.get(exec.name, exec.agent);
  if (!tool) throw new Error('The pending tool definition is unavailable.');
  const current = ctx.permissionPresets.current(session);
  const knobs = ctx.permissionPresets.permissionState(session);
  const sandbox = knobs.sandbox ?? ctx.shell?.sandboxMode;
  const mode = current === 'auto' ? 'full-access' : sandbox === 'danger-full-access' ? 'full-access' : ['read-only', 'workspace-write'].includes(sandbox) ? sandbox : 'unknown';
  const approval = knobs.approval ?? ctx.approval?.config?.policy;
  const call = [session.id ?? session.header.id, exec.rootCallId ?? exec.callId, exec.parent?.callId ?? '', exec.callId];
  const action = {
    call_id: 'call-' + createHash('sha256').update(JSON.stringify(call)).digest('hex'),
    tool: { name: exec.name, description: tool.description, parameters: clone(tool.parameters) },
    arguments: clone(exec.arguments),
    surface: exec.parent === undefined ? 'native' : 'ptc-inner',
    effects: [{ kind: 'unknown', targets: [] }],
  };
  action.snapshot_id = snapshotAction(action);
  return {
    protocol_version: 1,
    request_id: requestId,
    action,
    environment: { sandbox: mode, approval_policy: ['ask', 'never'].includes(approval) ? approval : 'unknown', host_decision: ['allow', 'ask', 'deny'].includes(hostDecision) ? hostDecision : 'unknown', workspace_roots: typeof session.header.cwd === 'string' ? [session.header.cwd] : [] },
    authority: clone(bounded.authority),
    evidence: clone(bounded.evidence),
    policy: { id: POLICY.id, version: POLICY.version },
    completeness: { authority: bounded.authorityComplete ? 'complete' : 'incomplete', evidence: bounded.evidenceComplete ? 'complete' : 'selected', omissions: [...bounded.omissions] },
  };
}

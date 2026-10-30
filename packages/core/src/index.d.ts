export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PolicyVersion = { readonly id: 'task-authorization'; readonly version: '0.1.0' };
export type Source = { session_id: string; event_id: string; verification: 'host-observed' | 'unknown' };
export type Authority = { id: string; source: Source } & (
  | { kind: 'human' | 'direct-parent'; text: string }
  | { kind: 'host-approval'; decision: 'allowed-once' | 'rejected'; call_id: string; snapshot_id: string }
);
export type Action = {
  call_id: string;
  snapshot_id: string;
  tool: { name: string; description: string; parameters: Record<string, Json> };
  arguments: Record<string, Json>;
  surface: 'native' | 'ptc-inner' | 'unknown';
  effects: { kind: 'local-read' | 'local-write' | 'external-read' | 'external-write' | 'destructive' | 'security-change' | 'unknown'; targets: string[] }[];
};
export type ReviewRequest = {
  protocol_version: 1;
  request_id: string;
  action: Action;
  environment: {
    sandbox: 'read-only' | 'workspace-write' | 'full-access' | 'unknown';
    approval_policy: 'ask' | 'never' | 'unknown';
    host_decision: 'allow' | 'ask' | 'deny' | 'unknown';
    workspace_roots: string[];
  };
  authority: Authority[];
  evidence: { id: string; kind: 'document' | 'tool-result' | 'checkpoint' | 'constraint' | 'agent-message'; text: string; source_id: string }[];
  policy: PolicyVersion;
  completeness: { authority: 'complete' | 'incomplete' | 'unknown'; evidence: 'complete' | 'selected' | 'incomplete' | 'unknown'; omissions: string[] };
};
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type BackendMetadata = {
  route?: { provider: string; model: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};
export type Metadata = BackendMetadata & { duration_ms: number };
export type Binding = { protocol_version: 1; request_id: string; snapshot_id: string; policy: PolicyVersion };
export type Decision = Binding & { status: 'result'; decision: 'allow' | 'ask' | 'deny'; reason: string; authority_refs: string[]; evidence_refs: string[] };
export type ErrorCode = 'invalid_input' | 'invalid_response' | 'context_unavailable' | 'backend_error' | 'timeout' | 'cancelled';
export type ReviewError = (
  | (Binding & { code: Exclude<ErrorCode, 'invalid_input'> })
  | ({ protocol_version: 1; code: 'invalid_input' } & Partial<Omit<Binding, 'protocol_version'>>)
) & { status: 'error'; message: string };
export type ReviewResult = DeepReadonly<(Decision | ReviewError) & { metadata: Metadata }>;
export type ReviewEvent = DeepReadonly<{ status: 'result'; decision: Decision['decision']; metadata: Metadata } | { status: 'error'; code: ErrorCode; metadata: Metadata }>;
export type Backend = (payload: {
  readonly request: DeepReadonly<ReviewRequest>;
  readonly policy: DeepReadonly<PolicyVersion & { text: string }>;
  readonly responseSchema: DeepReadonly<Record<string, unknown>>;
}, options: { signal: AbortSignal }) => Promise<{ output: string } & BackendMetadata> | ({ output: string } & BackendMetadata);
export function createReviewer(options: { backend: Backend; timeoutMs?: number; onEvent?: (event: ReviewEvent) => unknown }): {
  review(input: unknown, options?: { signal?: AbortSignal }): Promise<ReviewResult>;
};
export function snapshotAction(action: Action | Omit<Action, 'snapshot_id'>): string;
export const POLICY: DeepReadonly<PolicyVersion & { text: string }>;
export const REQUEST_SCHEMA: DeepReadonly<Record<string, unknown>>;
export const RESPONSE_SCHEMA: DeepReadonly<Record<string, unknown>>;

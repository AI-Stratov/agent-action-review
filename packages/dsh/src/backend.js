const OUTPUT_LIMIT = 64 * 1024;
const REASONING_LIMIT = 512 * 1024;
const BLOCK_LIMIT = 256;

function selectedRoute(agent, route) {
  const config = route.mode === 'inherit' ? agent.session.requestHeader()?.config : route;
  if (!config || typeof config.provider !== 'string' || !config.provider.trim()
    || typeof config.model !== 'string' || !config.model.trim()) {
    throw new TypeError('Select a configured reviewer provider and model.');
  }
  const selected = { provider: config.provider, model: config.model };
  if (config.reasoningEffort !== undefined) {
    if (typeof config.reasoningEffort !== 'string' || !config.reasoningEffort.trim()) {
      throw new TypeError('The reviewer reasoning effort is invalid.');
    }
    selected.reasoningEffort = config.reasoningEffort;
  }
  return Object.freeze(selected);
}

function nextChunk(iterator, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => iterator.next()).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function readOutput(stream, signal, cancel) {
  const iterator = stream[Symbol.asyncIterator]();
  const blocks = new Map();
  let finished = false;
  let exhausted = false;
  let reasoningBytes = 0;
  let usage;
  const fail = message => { cancel(); throw new Error(message); };
  const blockAt = (index, type) => {
    if (!Number.isSafeInteger(index) || index < 0) return fail('The reviewer emitted an invalid block index.');
    if (!['text', 'reasoning'].includes(type)) return fail('The reviewer must not call tools or return attachments.');
    const existing = blocks.get(index);
    if (existing) {
      if (existing.type !== type || existing.closed) return fail('The reviewer emitted conflicting or repeated blocks.');
      return existing;
    }
    if ([...blocks.values()].some(block => block.type === 'text')) return fail('The reviewer emitted content after its text response.');
    if (blocks.size >= BLOCK_LIMIT) return fail('The reviewer emitted too many blocks.');
    const block = { type, text: '', closed: false };
    blocks.set(index, block);
    return block;
  };
  try {
    while (true) {
      const next = await nextChunk(iterator, signal);
      if (next.done) { exhausted = true; break; }
      const chunk = next.value;
      if (!chunk || typeof chunk !== 'object' || finished) return fail('The reviewer emitted data after its terminal finish.');
      switch (chunk.type) {
        case 'block-start':
          if (blocks.has(chunk.index)) return fail('The reviewer emitted a repeated block start.');
          blockAt(chunk.index, chunk.blockType);
          break;
        case 'text-delta':
        case 'reasoning-delta': {
          if (typeof chunk.text !== 'string') return fail('The reviewer emitted invalid text.');
          const type = chunk.type === 'text-delta' ? 'text' : 'reasoning';
          const block = blockAt(chunk.index, type);
          if (type === 'reasoning') {
            reasoningBytes += Buffer.byteLength(chunk.text, 'utf8');
            if (reasoningBytes > REASONING_LIMIT) return fail('Reviewer reasoning exceeded its limit.');
          } else {
            block.text += chunk.text;
            if (Buffer.byteLength(block.text, 'utf8') > OUTPUT_LIMIT) return fail('Reviewer output exceeded 64 KiB.');
          }
          break;
        }
        case 'block-end': {
          if (!chunk.block || typeof chunk.block.text !== 'string') return fail('The reviewer emitted an invalid completed block.');
          const block = blockAt(chunk.index, chunk.block.type);
          if (block.type === 'text') {
            if (Buffer.byteLength(chunk.block.text, 'utf8') > OUTPUT_LIMIT) return fail('Reviewer output exceeded 64 KiB.');
            if (block.text && block.text !== chunk.block.text) return fail('Reviewer deltas conflict with the completed output.');
            block.text = chunk.block.text;
          } else if (Buffer.byteLength(chunk.block.text, 'utf8') > REASONING_LIMIT) return fail('Reviewer reasoning exceeded its limit.');
          block.closed = true;
          break;
        }
        case 'usage': {
          usage = {};
          for (const [host, normalized] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens']]) {
            if (Number.isSafeInteger(chunk.usage?.[host]) && chunk.usage[host] >= 0) usage[normalized] = chunk.usage[host];
          }
          break;
        }
        case 'finish':
          if (chunk.reason?.kind !== 'stop') return fail('The reviewer did not finish successfully.');
          finished = true;
          break;
        default:
          return fail('The reviewer emitted an unsupported stream event.');
      }
    }
    signal.throwIfAborted();
    const ordered = [...blocks.values()];
    const final = ordered.at(-1);
    if (!finished || final?.type !== 'text' || ordered.slice(0, -1).some(block => block.type !== 'reasoning')) {
      return fail('The reviewer must finish with exactly one text response.');
    }
    return { output: final.text, ...(usage && Object.keys(usage).length ? { usage } : {}) };
  } finally {
    if (!exhausted) {
      cancel();
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
    }
  }
}

export function makeBackend(ctx, agent, route = { mode: 'inherit' }) {
  if (!route || !['inherit', 'fixed'].includes(route.mode)) throw new TypeError('Select inherit or fixed reviewer routing.');
  const selected = selectedRoute(agent, route);
  const llm = ctx.llm;
  return async ({ request, policy, responseSchema }, { signal }) => {
    signal.throwIfAborted();
    const lifetime = new AbortController();
    const streamSignal = AbortSignal.any([signal, lifetime.signal]);
    const options = Object.freeze({
      ...selected,
      system: policy.text + '\n\nReturn exactly one JSON object matching this response schema. Do not execute any action or emit tools.\n' + JSON.stringify(responseSchema),
      messages: Object.freeze([Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(request) })]) })]),
      temperature: 0,
      signal: streamSignal,
    });
    const result = await readOutput(llm.stream(options), streamSignal, () => lifetime.abort());
    streamSignal.throwIfAborted();
    return { ...result, route: { provider: selected.provider, model: selected.model } };
  };
}

/** Synthetic fixture builders. Every string here is invented; no real trajectory content. */

export const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ---------------------------------------------------------------- ATIF
export function atifDoc(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'sess-synthetic',
    trajectory_id: 'traj-synthetic',
    agent: { name: 'demo-agent', version: '0.0.1', model_name: 'demo-model' },
    final_metrics: { total_steps: 3, total_prompt_tokens: 300, total_completion_tokens: 30, total_cached_tokens: 100, total_cost_usd: 0.01 },
    steps: [
      { step_id: 1, timestamp: '2026-01-01T10:00:00Z', source: 'user', message: 'Rename the helper.', reasoning_content: null, tool_calls: [], observation: null },
      {
        step_id: 2, timestamp: '2026-01-01T10:00:05Z', source: 'agent', message: 'Looking at the file.',
        reasoning_content: 'I should read it first.',
        tool_calls: [
          { tool_call_id: 'c1', function_name: 'read_file', arguments: { path: 'a.ts' } },
          { tool_call_id: 'c2', function_name: 'grep', arguments: '{"pattern":"helper"}' },
        ],
        observation: { results: [{ source_call_id: 'c2', content: 'a.ts:3' }, { source_call_id: 'c1', content: 'export const helper = 1' }] },
        metrics: { prompt_tokens: 120, completion_tokens: 12, cached_tokens: 100, cost_usd: 0.004 },
      },
      { step_id: 3, timestamp: '2026-01-01T10:00:09Z', source: 'agent', message: '', reasoning_content: null, tool_calls: [], observation: null },
      { step_id: 4, timestamp: '2026-01-01T10:00:12Z', source: 'agent', message: 'Done.', reasoning_content: null, tool_calls: [], observation: null },
    ],
    ...extra,
  };
}

// ---------------------------------------------------------------- Claude Code
let seq = 0;
const stamp = () => new Date(Date.UTC(2026, 0, 1, 10, 0, seq++)).toISOString();
const base = (uuid: string, parentUuid: string | null) => ({
  uuid, parentUuid, sessionId: 'cc-synthetic', timestamp: stamp(), cwd: '/work/demo', gitBranch: 'main', version: '9.9.9', isSidechain: false,
});
export const cc = {
  reset: () => { seq = 0; },
  user: (uuid: string, parent: string | null, content: unknown, extra: object = {}) =>
    ({ type: 'user', ...base(uuid, parent), message: { role: 'user', content }, ...extra }),
  assistant: (uuid: string, parent: string | null, content: unknown[], extra: object = {}, msg: object = {}) =>
    ({ type: 'assistant', ...base(uuid, parent), message: { role: 'assistant', model: 'demo-model', content, ...msg }, ...extra }),
  toolUse: (id: string, name = 'Read', input: unknown = { file: 'a.ts' }) => ({ type: 'tool_use', id, name, input }),
  toolResult: (id: string, content: unknown = 'ok', isError = false) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }),
  text: (text: string) => ({ type: 'text', text }),
  thinking: (thinking: string) => ({ type: 'thinking', thinking, signature: 'sig' }),
  noise: (i: number) => [
    { type: 'api-request', sessionId: 'cc-synthetic', id: `req${i}`, params: { n: i } },
    { type: 'file-history-snapshot', messageId: `m${i}`, snapshot: {} },
    { type: 'queue-operation', sessionId: 'cc-synthetic', operation: 'enqueue', content: 'x' },
    { type: 'attachment', ...base(`att${i}`, null), attachment: { kind: 'note' } },
  ],
};

/** A linear synthetic Claude Code session with `turns` user turns, each with one tool round-trip. */
export function ccSession(turns: number): unknown[] {
  cc.reset();
  const rows: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const u = `u${i}`, a1 = `a${i}x`, r = `r${i}`, a2 = `a${i}y`;
    rows.push(cc.user(u, parent, `Question ${i}`));
    rows.push(cc.assistant(a1, u, [cc.toolUse(`t${i}`)], {}, { id: `msg${i}a`, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } }));
    rows.push(cc.user(r, a1, [cc.toolResult(`t${i}`, `result ${i}`)]));
    rows.push(cc.assistant(a2, r, [cc.text(`Answer ${i}`)], {}, { id: `msg${i}b`, usage: { input_tokens: 12, output_tokens: 7 } }));
    parent = a2;
  }
  return rows;
}

// ---------------------------------------------------------------- Codex
let line = 0;
const cx = (type: string, payload: object) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, 11, 0, line++)).toISOString(), type, payload });
export const codex = {
  reset: () => { line = 0; },
  meta: () => cx('session_meta', { id: 'codex-synthetic', cwd: '/work/demo', cli_version: '1.2.3', model_provider: 'demo', git: { branch: 'main' } }),
  turn: (model = 'demo-codex') => cx('turn_context', { model, effort: 'high' }),
  msg: (role: string, text: string, id?: string) =>
    cx('response_item', { type: 'message', role, id, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }),
  reasoning: (id: string, summary?: string) =>
    cx('response_item', { type: 'reasoning', id, summary: summary ? [{ type: 'summary_text', text: summary }] : [], encrypted_content: 'gAAAA-synthetic' }),
  call: (callId: string, name: string, args: object) => cx('response_item', { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }),
  output: (callId: string, output: unknown) => cx('response_item', { type: 'function_call_output', call_id: callId, output }),
  customCall: (callId: string, input: string) => cx('response_item', { type: 'custom_tool_call', call_id: callId, name: 'exec', input }),
  customOutput: (callId: string, output: unknown) => cx('response_item', { type: 'custom_tool_call_output', call_id: callId, output }),
  dup: (kind: string, id: string, startedAtMs?: number, completedAtMs?: number) =>
    cx('event_msg', { type: 'item_completed', item: { type: kind, id }, started_at_ms: startedAtMs, completed_at_ms: completedAtMs }),
  tokens: (total: number, last = 10) => cx('event_msg', {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: last, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: last + 2 }, total_token_usage: { total_tokens: total } },
  }),
  event: (type: string, extra: object = {}) => cx('event_msg', { type, ...extra }),
};

import { describe, expect, it } from 'vitest';
import { parse, ParseError, type ParseResult, type TraceEvent } from '../../src/parse/index.ts';
import { atifDoc, cc, ccSession, codex, jsonl } from './fixtures.ts';

const kinds = (r: ParseResult) => r.session.events.map((e) => e.kind);
const by = (r: ParseResult, kind: string) => r.session.events.filter((e) => e.kind === kind);
const strip = (events: TraceEvent[]) => events.map(({ raw, ...rest }) => rest);

/** Invariants every successful parse must satisfy, whatever the format. */
function invariants(r: ParseResult) {
  const ev = r.session.events;
  expect(ev.length).toBeGreaterThan(0);
  expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
  ev.forEach((e, i) => expect(e.idx).toBe(i));
  const ids = new Set(ev.map((e) => e.id));
  for (const e of ev) if (e.parentId !== undefined) expect(ids.has(e.parentId)).toBe(true);
  const calls = ev.filter((e) => e.kind === 'tool_call' && e.callId !== undefined).map((e) => e.callId);
  expect(new Set(calls).size).toBe(calls.length);
  for (const e of ev) if (e.kind === 'message' || e.kind === 'thinking') expect(e.text?.trim()).toBeTruthy();
  expect(structuredClone(r)).toEqual(r);
  expect(r.session.format).toBe(r.format);
}
const fails = (input: string, code: string) => {
  try {
    parse(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    expect((e as ParseError).code).toBe(code);
    expect((e as ParseError).message.length).toBeGreaterThan(30);
    return (e as ParseError).message;
  }
  throw new Error('expected parse() to throw');
};

describe('ATIF', () => {
  it('splits one step into thinking, message, calls, results and usage in reading order', () => {
    const r = parse(JSON.stringify(atifDoc()));
    invariants(r);
    expect(r.format).toBe('atif');
    expect(kinds(r)).toEqual(['message', 'thinking', 'message', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'usage', 'message']);
    expect(r.session.events.map((e) => e.actor)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'assistant', 'tool', 'tool', 'system', 'assistant']);
    expect(r.session.events.map((e) => e.step)).toEqual([1, 2, 2, 2, 2, 2, 2, 2, 4]);
    expect(r.diagnostics).toEqual([]);
  });

  it('exposes session metadata and normalized totals', () => {
    const { session } = parse(JSON.stringify(atifDoc()));
    expect(session.id).toBe('sess-synthetic');
    expect(session.meta).toMatchObject({
      model: 'demo-model', agentName: 'demo-agent', schemaVersion: 'ATIF-v1.7', stepCount: 4,
      startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:00:12Z',
      totalUsage: { input: 300, output: 30, cacheRead: 100, costUsd: 0.01, total: 330 },
    });
  });

  it('parses JSON-string arguments, pairs out-of-order results and labels them with the tool name', () => {
    const r = parse(JSON.stringify(atifDoc()));
    const [c1, c2] = by(r, 'tool_call');
    expect(c1.input).toEqual({ path: 'a.ts' });
    expect(c2.input).toEqual({ pattern: 'helper' });
    const [first, second] = by(r, 'tool_result');
    expect([first.callId, first.name, first.output]).toEqual(['c2', 'grep', 'a.ts:3']);
    expect([second.callId, second.name]).toEqual(['c1', 'read_file']);
    expect(by(r, 'usage')[0].usage).toEqual({ input: 120, output: 12, cacheRead: 100, total: 132, costUsd: 0.004 });
  });

  it('keeps the most specific source object in raw', () => {
    const doc = atifDoc();
    const r = parse(JSON.stringify(doc));
    expect(by(r, 'tool_call')[0].raw).toEqual(doc.steps[1].tool_calls![0]);
    expect(by(r, 'thinking')[0].raw).toEqual(doc.steps[1]);
  });

  it('renames call ids that an agent reuses across steps so pairing stays correct', () => {
    const step = (n: number) => ({
      step_id: n, source: 'agent', message: '', tool_calls: [{ tool_call_id: 'call_1', function_name: `tool${n}`, arguments: {} }],
      observation: { results: [{ source_call_id: 'call_1', content: `out${n}` }] },
    });
    const r = parse(JSON.stringify({ schema_version: 'ATIF-v1.5', steps: [step(1), step(2), step(3)] }));
    invariants(r);
    expect(by(r, 'tool_call').map((e) => e.callId)).toEqual(['call_1', 'call_1#2', 'call_1#3']);
    expect(by(r, 'tool_result').map((e) => [e.callId, e.name, e.output])).toEqual([['call_1', 'tool1', 'out1'], ['call_1#2', 'tool2', 'out2'], ['call_1#3', 'tool3', 'out3']]);
    expect(r.diagnostics.some((d) => /reused/.test(d.reason))).toBe(true);
  });

  it('reports orphan results, unknown sources and malformed steps without failing', () => {
    const r = parse(JSON.stringify({
      steps: [
        { step_id: 1, source: 'robot', message: 'hi' },
        'not a step',
        { step_id: 2, source: 'agent', message: '', observation: { results: [{ source_call_id: 'ghost', content: 'x' }] } },
      ],
    }));
    invariants(r);
    expect(r.session.events[0].actor).toBe('system');
    expect(r.diagnostics.map((d) => d.reason).join('\n')).toMatch(/unrecognized source[\s\S]*not an object[\s\S]*not in this file/);
  });

  it('keeps step-level duration and TTFT only when the key states its unit', () => {
    const r = parse(JSON.stringify({
      schema_version: 'ATIF-v1.7',
      steps: [
        { step_id: 1, source: 'agent', message: 'a', metrics: { prompt_tokens: 10, completion_tokens: 2, duration_ms: 1200, ttft_ms: 300 } },
        { step_id: 2, source: 'agent', message: 'b', extra: { duration_seconds: 2.5, time_to_first_token: 7, latency: 5 } },
        { step_id: 3, source: 'agent', message: 'c', tool_calls: [{ tool_call_id: 'x', function_name: 't', arguments: {} }],
          observation: { results: [{ source_call_id: 'x', content: 'ok', extra: { duration_ms: 40 } }] } },
      ],
    }));
    invariants(r);
    expect(by(r, 'usage').map((e) => [e.step, e.durationMs, e.ttftMs ?? null, e.text])).toEqual([
      [1, 1200, 300, '10 in · 2 out · took 1.2s · first token after 300ms'],
      [2, 2500, null, 'took 2.5s'], // unitless "time_to_first_token" and "latency" are not guessed at
    ]);
    expect(by(r, 'tool_result')[0].durationMs).toBe(40);
    expect(by(r, 'message').every((e) => e.durationMs === undefined)).toBe(true);
  });

  it('flattens multimodal message parts and keeps non-text tool output intact', () => {
    const image = { type: 'image', source: { media_type: 'image/png', path: 'shot.png' } };
    const r = parse(JSON.stringify({
      schema_version: 'ATIF-v1.6',
      steps: [{
        step_id: 1, source: 'user', message: [{ type: 'text', text: 'See this' }, image],
        tool_calls: [{ tool_call_id: 'a', function_name: 'shot', arguments: {} }],
        observation: { results: [{ source_call_id: 'a', content: [{ type: 'text', text: 'done' }, image] }] },
      }],
    }));
    expect(r.session.events[0].text).toBe('See this\n\n[image]');
    expect(by(r, 'tool_result')[0].output).toEqual([{ type: 'text', text: 'done' }, image]);
  });
});

describe('chat transcripts', () => {
  it('reads OpenAI chat messages with tool calls', () => {
    const r = parse(JSON.stringify({
      model: 'demo-chat',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: null, reasoning_content: 'Need the tool.', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"Pune"}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: '31C' },
        { role: 'assistant', content: 'It is 31C.', usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } },
      ],
    }));
    invariants(r);
    expect(r.format).toBe('chat');
    expect(r.session.meta.model).toBe('demo-chat');
    expect(kinds(r)).toEqual(['message', 'message', 'thinking', 'tool_call', 'tool_result', 'message', 'usage']);
    expect(by(r, 'tool_call')[0]).toMatchObject({ callId: 'call_a', name: 'weather', input: { city: 'Pune' }, step: 3 });
    expect(by(r, 'tool_result')[0]).toMatchObject({ callId: 'call_a', name: 'weather', output: '31C', actor: 'tool' });
    expect(by(r, 'usage')[0].usage).toEqual({ input: 50, output: 5, cacheRead: 20, total: 55 });
  });

  it('reads Anthropic messages with content blocks and a top-level system prompt', () => {
    const r = parse(JSON.stringify({
      system: 'You are terse.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'List files' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Use ls.' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.ts' }], is_error: true }, { type: 'text', text: 'and now?' }] },
      ],
    }));
    invariants(r);
    expect(r.session.events.map((e) => [e.actor, e.kind])).toEqual([
      ['system', 'message'], ['user', 'message'], ['assistant', 'thinking'], ['assistant', 'message'],
      ['assistant', 'tool_call'], ['tool', 'tool_result'], ['user', 'message'],
    ]);
    expect(by(r, 'tool_result')[0]).toMatchObject({ callId: 'tu1', output: 'a.ts', isError: true, name: 'bash' });
  });

  it('reads a bare array, JSONL, Responses items, ShareGPT turns and legacy function_call', () => {
    const bare = parse(JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]));
    expect(kinds(bare)).toEqual(['message', 'message']);

    const lines = parse(jsonl([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]));
    expect(strip(lines.session.events)).toEqual(strip(bare.session.events));

    const items = parse(JSON.stringify({ input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan.' }] },
      { type: 'function_call', call_id: 'fc1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'fc1', output: '{"output":"boom","metadata":{"exit_code":2}}' },
    ] }));
    invariants(items);
    expect(kinds(items)).toEqual(['message', 'thinking', 'tool_call', 'tool_result']);
    expect(by(items, 'tool_result')[0]).toMatchObject({ output: 'boom', isError: true, callId: 'fc1', name: 'shell' });

    const share = parse(JSON.stringify({ conversations: [{ from: 'human', value: 'q' }, { from: 'gpt', value: 'a' }] }));
    expect(share.session.events.map((e) => e.actor)).toEqual(['user', 'assistant']);

    const legacy = parse(JSON.stringify([
      { role: 'user', content: 'time?' },
      { role: 'assistant', content: null, function_call: { name: 'clock', arguments: '{}' } },
      { role: 'function', name: 'clock', content: '10:00' },
    ]));
    invariants(legacy);
    const call = by(legacy, 'tool_call')[0];
    expect(by(legacy, 'tool_result')[0].callId).toBe(call.callId);
  });

  it('shows harness-injected context as system, and unknown roles with a diagnostic', () => {
    const r = parse(JSON.stringify([
      { role: 'user', content: '<environment_context>\ncwd: /work\n</environment_context>' },
      { role: 'user', content: 'Use <b>bold</b> please' },
      { role: 'narrator', content: 'meanwhile' },
    ]));
    expect(r.session.events.map((e) => e.actor)).toEqual(['system', 'user', 'system']);
    expect(r.session.events[0].name).toBe('environment_context');
    expect(r.diagnostics[0].reason).toMatch(/unrecognized role/);
  });
});

describe('Claude Code', () => {
  it('reads a linear session with metadata, parent chain and per-response usage', () => {
    const r = parse(jsonl(ccSession(2)));
    invariants(r);
    expect(r.format).toBe('claude-code');
    expect(r.session.id).toBe('cc-synthetic');
    expect(r.session.meta).toMatchObject({ model: 'demo-model', cwd: '/work/demo', gitBranch: 'main', version: '9.9.9' });
    expect(kinds(r)).toEqual(['message', 'tool_call', 'usage', 'tool_result', 'message', 'usage', 'message', 'tool_call', 'usage', 'tool_result', 'message', 'usage']);
    const ev = r.session.events;
    expect(ev[0].parentId).toBeUndefined();
    expect(ev[3].parentId).toBe(ev[1].id); // result follows the call, skipping the usage marker
    expect(ev[6].parentId).toBe(ev[4].id);
    expect(ev[2].usage).toEqual({ input: 100, output: 5, cacheRead: 90, total: 105 }); // Anthropic input excludes cache; normalized to include it
    expect(ev.some((e) => e.offPath)).toBe(false);
  });

  it('is unaffected by interleaved noise records', () => {
    const clean = ccSession(3);
    cc.reset();
    const noisy = ccSession(3).flatMap((row, i) => [row, ...cc.noise(i).filter((n) => n.type !== 'attachment')]);
    const a = parse(jsonl(clean));
    const b = parse(jsonl(noisy));
    expect(strip(b.session.events)).toEqual(strip(a.session.events));
    expect(b.session.meta.skippedRecords).toMatchObject({ 'api-request': 12, 'file-history-snapshot': 12 });
  });

  it('keeps parallel tool results on the active path even though they fork the chain', () => {
    cc.reset();
    const rows = [
      cc.user('u', null, 'go'),
      cc.assistant('a1', 'u', [cc.toolUse('t1')], {}, { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 } }),
      cc.assistant('a2', 'a1', [cc.toolUse('t2')], {}, { id: 'm1', usage: { input_tokens: 1, output_tokens: 9 } }),
      cc.assistant('a3', 'a2', [cc.toolUse('t3')], {}, { id: 'm1', usage: { input_tokens: 1, output_tokens: 9 } }),
      cc.user('r2', 'a2', [cc.toolResult('t2')]),
      cc.user('r1', 'a1', [cc.toolResult('t1', 'bad', true)]),
      cc.user('r3', 'a3', [cc.toolResult('t3')]),
      cc.assistant('a4', 'r3', [cc.text('done')]),
      { type: 'last-prompt', sessionId: 'cc-synthetic', leafUuid: 'a4' },
    ];
    const r = parse(jsonl(rows));
    invariants(r);
    expect(r.session.events.some((e) => e.offPath)).toBe(false);
    expect(r.diagnostics).toEqual([]);
    expect(by(r, 'usage')).toHaveLength(1); // three lines, one API response
    expect(by(r, 'usage')[0].usage?.output).toBe(9);
    expect(by(r, 'tool_result').map((e) => [e.callId, e.isError ?? false])).toEqual([['t2', false], ['t1', true], ['t3', false]]);
  });

  it('flags a rewound branch as offPath and keeps the active one clean', () => {
    cc.reset();
    const rows = [
      cc.user('u1', null, 'first try'),
      cc.assistant('a1', 'u1', [cc.text('wrong answer')]),
      cc.user('u1b', null, 'second try'),
      cc.assistant('a1b', 'u1b', [cc.text('right answer')]),
      { type: 'last-prompt', sessionId: 'cc-synthetic', leafUuid: 'a1b' },
    ];
    rows[2] = cc.user('u1b', 'u1', 'follow up, later rewound'); // fork under u1
    rows[3] = cc.assistant('a1b', 'u1', [cc.text('right answer')]);
    const r = parse(jsonl(rows));
    invariants(r);
    expect(r.session.events.map((e) => [e.text, e.offPath ?? false])).toEqual([
      ['first try', false], ['wrong answer', true], ['follow up, later rewound', true], ['right answer', false],
    ]);
    expect(r.session.meta.offPathEvents).toBe(2);
    expect(r.diagnostics[0].reason).toMatch(/2 event\(s\) on 2 abandoned branch/);
  });

  it('follows compaction boundaries and survives a dangling parent link', () => {
    cc.reset();
    const rows = [
      cc.user('u1', null, 'before compaction'),
      cc.assistant('a1', 'u1', [cc.text('early work')]),
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1', sessionId: 'cc-synthetic', timestamp: '2026-01-01T10:01:00Z' },
      cc.user('u2', 'c1', 'summary of earlier work', { isCompactSummary: true }),
      cc.assistant('a2', 'u2', [cc.text('continuing')]),
      cc.user('u3', 'missing-uuid', 'after a lost record'),
      cc.assistant('a3', 'u3', [cc.text('still here')]),
    ];
    const r = parse(jsonl(rows));
    invariants(r);
    expect(r.session.events.some((e) => e.offPath)).toBe(false);
    expect(r.session.events.map((e) => [e.actor, e.kind])).toEqual([
      ['user', 'message'], ['assistant', 'message'], ['system', 'meta'], ['system', 'message'],
      ['assistant', 'message'], ['user', 'message'], ['assistant', 'message'],
    ]);
    expect(r.session.events[2].parentId).toBe(r.session.events[1].id); // logicalParentUuid bridges the boundary
    expect(r.session.meta.brokenParentLinks).toBe(1);
    expect(r.diagnostics[0]).toMatchObject({ line: 6 });
  });

  it('preserves response ids and the durations Claude Code records', () => {
    cc.reset();
    const r = parse(jsonl([
      cc.user('u', null, 'go'),
      cc.assistant('a1', 'u', [cc.thinking('plan')], { thinkingDurationMs: 4200 }, { id: 'resp1', usage: { input_tokens: 5, output_tokens: 1 } }),
      cc.assistant('a2', 'a1', [cc.toolUse('t1')], {}, { id: 'resp1', usage: { input_tokens: 5, output_tokens: 3 } }),
      cc.user('r1', 'a2', [cc.toolResult('t1')], { toolUseResult: { durationMs: 730 } }),
      cc.assistant('a3', 'r1', [cc.thinking('')], { thinkingDurationMs: 9000 }, { id: 'resp2' }),
      cc.assistant('a4', 'a3', [cc.text('done')], {}, { id: 'resp2' }),
      { type: 'system', subtype: 'turn_duration', durationMs: 20_000, uuid: 's1', parentUuid: 'a4', sessionId: 'cc-synthetic', timestamp: '2026-01-01T10:05:00Z' },
    ]));
    invariants(r);
    expect(r.session.events.map((e) => [e.kind, e.responseId ?? null, e.durationMs ?? null])).toEqual([
      ['message', null, null], ['thinking', 'resp1', 4200], ['usage', 'resp1', null], ['tool_call', 'resp1', null],
      ['tool_result', null, 730], ['message', 'resp2', null], ['meta', null, 20_000],
    ]);
    expect(r.session.meta).toMatchObject({ hiddenReasoningCount: 1, hiddenReasoningMs: 9000 });
    expect(r.session.events[6]).toMatchObject({ name: 'turn_duration', text: 'Turn completed' });
  });

  it('treats a sub-agent transcript as its own main thread', () => {
    cc.reset();
    const side = { isSidechain: true };
    const r = parse(jsonl([
      cc.user('u', null, 'task for the sub-agent', side),
      cc.assistant('a', 'u', [cc.text('first try')], side),
      cc.assistant('b', 'u', [cc.text('retry')], side),
      { type: 'last-prompt', sessionId: 'cc-synthetic', leafUuid: 'b' },
    ]));
    invariants(r);
    expect(r.session.meta.subagentTranscript).toBe(true);
    expect(r.session.events.some((e) => e.sidechain)).toBe(false);
    expect(r.session.events.map((e) => e.offPath ?? false)).toEqual([false, true, false]); // branch detection still works
  });

  it('handles string and block content, meta turns, sidechains, duplicates and titles', () => {
    cc.reset();
    const rows = [
      { type: 'custom-title', sessionId: 'cc-synthetic', customTitle: 'Synthetic title' },
      cc.user('u1', null, 'plain string'),
      cc.user('u2', 'u1', '<local-command-caveat>note</local-command-caveat>'),
      cc.user('u3', 'u2', 'meta note', { isMeta: true }),
      cc.assistant('a1', 'u3', [cc.thinking('hmm'), cc.thinking(''), cc.text('part one'), cc.text('part two')]),
      cc.assistant('a1', 'u3', [cc.text('duplicate uuid')]),
      cc.assistant('s1', null, [cc.text('subagent says hi')], { isSidechain: true }),
      cc.assistant('a2', 'a1', [cc.text('api failed')], { isApiErrorMessage: true }),
    ];
    const r = parse(jsonl(rows));
    invariants(r);
    expect(r.session.meta.title).toBe('Synthetic title');
    expect(r.session.events.map((e) => [e.actor, e.kind, e.text])).toEqual([
      ['user', 'message', 'plain string'],
      ['system', 'message', '<local-command-caveat>note</local-command-caveat>'],
      ['system', 'message', 'meta note'],
      ['assistant', 'thinking', 'hmm'],
      ['assistant', 'message', 'part one\n\npart two'],
      ['assistant', 'message', 'subagent says hi'],
      ['assistant', 'message', 'api failed'],
    ]);
    expect(r.session.events[5]).toMatchObject({ sidechain: true });
    expect(r.session.events[5].offPath).toBeUndefined();
    expect(r.session.events[6].isError).toBe(true);
    expect(r.diagnostics.some((d) => /duplicate record/.test(d.reason))).toBe(true);
  });
});

describe('Codex', () => {
  const session = () => {
    codex.reset();
    return [
      codex.meta(),
      codex.turn(),
      codex.msg('developer', 'Follow the rules.', 'i0'),
      codex.msg('user', '<environment_context>\n<cwd>/work</cwd>\n</environment_context>', 'i1'),
      codex.msg('user', 'Fix the test', 'i2'),
      codex.reasoning('i3'),
      codex.dup('Reasoning', 'i3'),
      codex.reasoning('i4', 'Inspect the failure.'),
      codex.call('c1', 'shell', { cmd: 'npm test' }),
      codex.dup('CommandExecution', 'x1'),
      codex.output('c1', '{"output":"1 failed","metadata":{"exit_code":1,"duration_seconds":2}}'),
      codex.tokens(100),
      codex.tokens(100),
      codex.customCall('c2', 'apply patch'),
      codex.customOutput('c2', [{ type: 'input_text', text: 'Script completed\nok' }]),
      codex.customCall('c3', 'run'),
      codex.customOutput('c3', [{ type: 'input_text', text: 'Script failed\ntrace' }]),
      codex.tokens(180),
      codex.msg('assistant', 'Fixed.', 'i9'),
      codex.dup('AgentMessage', 'i9'),
      codex.event('task_complete', { duration_ms: 5000 }),
      { timestamp: '2026-01-01T11:10:00Z', type: 'token_usage_record', payload: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
  };

  it('uses response items as the source of truth and never double-renders duplicates', () => {
    const r = parse(jsonl(session()));
    invariants(r);
    expect(r.format).toBe('codex');
    expect(r.session.id).toBe('codex-synthetic');
    expect(r.session.meta).toMatchObject({ model: 'demo-codex', effort: 'high', cwd: '/work/demo', cliVersion: '1.2.3', gitBranch: 'main', hiddenReasoningCount: 1, turnCount: 1 });
    expect(r.session.events.map((e) => [e.actor, e.kind])).toEqual([
      ['system', 'message'], ['system', 'message'], ['user', 'message'], ['assistant', 'thinking'],
      ['assistant', 'tool_call'], ['tool', 'tool_result'], ['system', 'usage'],
      ['assistant', 'tool_call'], ['tool', 'tool_result'], ['assistant', 'tool_call'], ['tool', 'tool_result'],
      ['system', 'usage'], ['assistant', 'message'], ['system', 'meta'],
    ]);
    expect(r.session.meta.skippedRecords).toMatchObject({ 'event_msg:item_completed': 3, token_usage_record: 1 });
  });

  it('unwraps tool output envelopes and detects failures', () => {
    const r = parse(jsonl(session()));
    expect(by(r, 'tool_call')[0]).toMatchObject({ name: 'shell', input: { cmd: 'npm test' }, callId: 'c1' });
    expect(by(r, 'tool_result').map((e) => [e.output, e.isError ?? null, e.name])).toEqual([
      ['1 failed', true, 'shell'], ['Script completed\nok', null, 'exec'], ['Script failed\ntrace', true, 'exec'],
    ]);
    expect(by(r, 'usage').map((e) => e.usage)).toEqual([
      { input: 10, output: 2, cacheRead: 4, reasoning: 1, total: 12 }, { input: 10, output: 2, cacheRead: 4, reasoning: 1, total: 12 },
    ]);
  });

  it('never exposes encrypted reasoning in raw', () => {
    const r = parse(jsonl(session()));
    expect(JSON.stringify(by(r, 'thinking')[0].raw)).not.toContain('gAAAA');
  });

  it('surfaces aborts, compaction, model changes and inter-agent messages', () => {
    codex.reset();
    const r = parse(jsonl([
      codex.meta(), codex.turn('m1'), codex.msg('user', 'go'),
      codex.event('turn_aborted', { reason: 'interrupted' }),
      { timestamp: '2026-01-01T11:00:09Z', type: 'compacted', payload: { message: '' } },
      codex.turn('m2'),
      { timestamp: '2026-01-01T11:00:10Z', type: 'response_item', payload: { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'text', text: 'finished' }] } },
    ]));
    invariants(r);
    expect(r.session.events.map((e) => [e.kind, e.name ?? null, e.text])).toEqual([
      ['message', null, 'go'], ['meta', 'turn_aborted', 'interrupted'], ['meta', 'compacted', 'Context compacted'],
      ['meta', 'model_changed', 'Model changed to m2'], ['message', '/root/worker → /root', 'finished'],
    ]);
    expect(r.session.meta.model).toBe('m2');
  });

  it('preserves durations and TTFT the CLI recorded, each on the record it belongs to', () => {
    codex.reset();
    const r = parse(jsonl([
      codex.meta(), codex.turn(), codex.msg('user', 'go'),
      codex.dup('Reasoning', 'r1', 1000, 4000), codex.reasoning('r1', 'Plan.'),
      codex.dup('Reasoning', 'r2', 4000, 4500), codex.reasoning('r2'),
      codex.call('c1', 'shell', { cmd: 'a' }), codex.output('c1', 'Wall time: 1.5 seconds\nOutput:\nok'),
      codex.customCall('c2', 'x'), codex.customOutput('c2', [{ type: 'input_text', text: 'Script completed\nWall time 2 seconds\nOutput:\nok' }]),
      codex.call('c3', 'shell', { cmd: 'b' }), codex.output('c3', '{"output":"ok","metadata":{"exit_code":0,"duration_seconds":0.25}}'),
      codex.call('c4', 'mcp', {}), codex.dup('McpToolCall', 'c4', 100, 900), codex.output('c4', 'plain result'),
      codex.call('c5', 'shell', { cmd: 'c' }), codex.dup('CommandExecution', 'unrelated-id', 0, 99_000), codex.output('c5', 'no header'),
      codex.msg('assistant', 'Wall time: 9 seconds'),
      codex.event('task_complete', { duration_ms: 61_000, time_to_first_token_ms: 850, turn_id: 't1' }),
    ]));
    invariants(r);
    expect(by(r, 'thinking').map((e) => e.durationMs)).toEqual([3000]);
    expect(r.session.meta).toMatchObject({ hiddenReasoningCount: 1, hiddenReasoningMs: 500 });
    expect(by(r, 'tool_result').map((e) => e.durationMs)).toEqual([1500, 2000, 250, 800, undefined]);
    expect(by(r, 'tool_call').every((e) => e.durationMs === undefined)).toBe(true);
    expect(by(r, 'message').every((e) => e.durationMs === undefined)).toBe(true); // message text is never read as a header
    const done = by(r, 'meta')[0];
    expect(done).toMatchObject({ name: 'task_complete', durationMs: 61_000, ttftMs: 850, text: 'Turn completed · took 1m 1s · first token after 850ms' });
    expect(done.callId).toBeUndefined();
  });

  it('falls back to event messages when a rollout has no response items', () => {
    codex.reset();
    const r = parse(jsonl([codex.meta(), codex.event('user_message', { message: 'hi' }), codex.event('agent_reasoning', { text: 'think' }), codex.event('agent_message', { message: 'yo' })]));
    expect(r.session.events.map((e) => [e.actor, e.kind])).toEqual([['user', 'message'], ['assistant', 'thinking'], ['assistant', 'message']]);
  });
});

describe('robustness', () => {
  it('rejects empty and non-JSON input with an actionable message', () => {
    fails('', 'empty');
    fails('  \n\t ', 'empty');
    fails('[]', 'empty');
    expect(fails('# Notes\n\nJust some prose.\n'.repeat(50), 'not_json')).toMatch(/not JSON or JSONL/);
    expect(fails('{\n  "steps": [\n    {"step_id": 1,', 'not_json')).toMatch(/truncated|could not be read/);
  });

  it('rejects unknown structures and says what it found', () => {
    expect(fails(JSON.stringify({ users: [], total: 3 }), 'unknown_format')).toMatch(/Top-level keys found: users, total/);
    expect(fails(jsonl([{ a: 1 }, { a: 2 }]), 'unknown_format')).toMatch(/first record has keys: a/);
    expect(fails(JSON.stringify([{ a: 1 }]), 'unknown_format')).toMatch(/keys: a/);
    fails('42', 'unknown_format');
    fails(JSON.stringify({ schema_version: 'ATIF-v1.7', steps: [] }), 'no_events');
    fails(jsonl([{ type: 'queue-operation', sessionId: 's' }]), 'no_events');
  });

  it('does not mistake look-alike JSONL for a session log', () => {
    fails(jsonl([{ type: 'log', level: 'info', msg: 'x' }, { type: 'log', level: 'warn', msg: 'y' }]), 'unknown_format');
    fails(jsonl([{ event: 'click', payload: { x: 1 } }]), 'unknown_format');
  });

  it('keeps going past a truncated tail and a garbage line, with line numbers', () => {
    const good = jsonl(ccSession(2));
    const cut = good.trimEnd();
    const truncated = parse(cut.slice(0, cut.length - 25));
    invariants(truncated);
    expect(truncated.diagnostics).toEqual([{ line: 8, reason: expect.stringMatching(/cut off/) }]);
    expect(truncated.session.events.length).toBe(parse(good).session.events.length - 2);

    const lines = good.trimEnd().split('\n');
    lines.splice(3, 0, '{"oops": ', '7', '');
    const garbage = parse(lines.join('\n'));
    expect(garbage.diagnostics).toEqual([
      { line: 4, reason: expect.stringMatching(/not valid JSON/) },
      { line: 5, reason: expect.stringMatching(/not an object/) },
    ]);
    expect(strip(garbage.session.events)).toEqual(strip(parse(good).session.events));
  });

  it('accepts BOM, CRLF, blank lines, unicode and a single-line JSONL file', () => {
    cc.reset();
    const rows = [cc.user('u1', null, 'héllo 👋 你好'), cc.assistant('a1', 'u1', [cc.text('ok')])];
    const text = '﻿' + rows.map((r) => JSON.stringify(r)).join('\r\n\r\n') + '\r\n';
    const r = parse(text);
    invariants(r);
    expect(r.session.events[0].text).toBe('héllo 👋 你好');
    expect(r.diagnostics).toEqual([]);
    expect(parse(JSON.stringify(rows[0])).format).toBe('claude-code');
    expect(parse('﻿  ' + JSON.stringify(atifDoc())).format).toBe('atif');
  });

  it('preserves future block and record types instead of dropping the view', () => {
    cc.reset();
    const r = parse(jsonl([
      cc.user('u1', null, 'hi'),
      cc.assistant('a1', 'u1', [{ type: 'hologram', data: 1 }, cc.text('still works')]),
      { type: 'brand-new-record', sessionId: 'cc-synthetic' },
    ]));
    invariants(r);
    expect(r.session.events.map((e) => [e.kind, e.name ?? null])).toEqual([['message', null], ['unknown', 'hologram'], ['message', null]]);
    expect(r.session.meta.skippedRecords).toEqual({ 'brand-new-record': 1 });
  });

  it('caps diagnostics so a badly damaged file cannot flood the UI', () => {
    const rows = ccSession(1).map((r) => JSON.stringify(r));
    const text = rows.join('\n') + '\n' + '{bad\n'.repeat(1000);
    const r = parse(text);
    expect(r.diagnostics.length).toBe(201);
    expect(r.diagnostics[200].reason).toMatch(/800 more/);
  });
});

describe('performance', () => {
  it('parses a 50k-event session well inside the interaction budget', () => {
    const text = jsonl(ccSession(8400).flatMap((row, i) => (i % 4 === 0 ? [row, ...cc.noise(i)] : [row])));
    const t0 = performance.now();
    const r = parse(text);
    const ms = performance.now() - t0;
    expect(r.session.events.length).toBe(8400 * 6);
    expect(r.session.events.some((e) => e.offPath)).toBe(false);
    console.info(`50,400 events from ${(text.length / 1048576).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  });

  it('handles a single 5 MB tool output without copying it', () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const doc = { steps: [{ step_id: 1, source: 'agent', message: 'm', tool_calls: [{ tool_call_id: 'a', function_name: 't', arguments: {} }], observation: { results: [{ source_call_id: 'a', content: big }] } }] };
    const text = JSON.stringify(doc);
    const t0 = performance.now();
    const r = parse(text);
    const ms = performance.now() - t0;
    expect((by(r, 'tool_result')[0].output as string).length).toBe(big.length);
    expect(ms).toBeLessThan(500);
  });
});

import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.ts';
import { analyze } from '../../src/analyze/index.ts';
import { codex, jsonl } from './fixtures.ts';

const read = (rows: object[]) => parse(jsonl(rows));
const textEvents = (rows: object[]) => read(rows).session.events.filter(e => e.kind === 'message' || e.kind === 'thinking').map(e => [e.actor, e.kind, e.text]);

describe('Codex mixed readable streams', () => {
  it('keeps a legacy-only prompt and unique reasoning when response items exist', () => {
    codex.reset();
    expect(textEvents([
      codex.meta(), codex.event('user_message', {message: 'Fix the synthetic test'}),
      codex.event('agent_reasoning', {text: 'A unique readable thought'}),
      codex.reasoning('encrypted-only'), codex.msg('assistant', 'Done'),
    ])).toEqual([
      ['user', 'message', 'Fix the synthetic test'],
      ['assistant', 'thinking', 'A unique readable thought'],
      ['assistant', 'message', 'Done'],
    ]);
  });
  it('deduplicates exact mirrors before or after the canonical item, ignoring metadata', () => {
    codex.reset();
    const result = read([
      codex.meta(), codex.event('user_message', {message: 'Go'}), codex.msg('user', 'Go'),
      codex.event('agent_reasoning', {text: 'Plan'}), codex.dup('Reasoning', 'r'), codex.reasoning('r', 'Plan'),
      codex.msg('assistant', 'Done'), codex.event('token_count', {info: null}), codex.event('agent_message', {message: 'Done'}),
    ]);
    expect(result.session.events.map(e => [e.actor, e.kind, e.text])).toEqual([
      ['user', 'message', 'Go'], ['assistant', 'thinking', 'Plan'], ['assistant', 'message', 'Done'],
    ]);
    expect(result.session.meta.skippedRecords).toMatchObject({'event_msg:user_message': 1, 'event_msg:agent_reasoning': 1, 'event_msg:agent_message': 1});
  });
  it('does not deduplicate identical prompts across a turn boundary or tool activity', () => {
    codex.reset();
    expect(textEvents([
      codex.meta(), codex.msg('user', 'Again'), codex.event('task_complete'),
      codex.event('user_message', {message: 'Again'}), codex.call('c', 'shell', {cmd: 'echo test'}),
      codex.msg('user', 'Again'),
    ]).filter(e => e[0] === 'user')).toHaveLength(3);
  });
  it('pairs mirrors one-to-one and keeps an additional identical legacy occurrence', () => {
    codex.reset();
    expect(textEvents([
      codex.meta(), codex.event('user_message', {message: 'Repeat'}),
      codex.event('user_message', {message: 'Repeat'}), codex.msg('user', 'Repeat'),
    ])).toEqual([['user', 'message', 'Repeat'], ['user', 'message', 'Repeat']]);
  });
  it('keeps similar but nonidentical legacy messages', () => {
    codex.reset();
    expect(textEvents([
      codex.meta(), codex.msg('assistant', 'Done'), codex.event('agent_message', {message: 'Done, with a caveat'}),
    ])).toHaveLength(2);
  });
});

describe('Codex usage stream fallback', () => {
  it.each([null, {}, {last_token_usage: null}, {last_token_usage: {}}])('uses valid token_usage_record when token_count info is unusable: %j', info => {
    codex.reset();
    const result = read([
      codex.meta(), codex.msg('assistant', 'ok'), codex.event('token_count', {info}),
      {type: 'token_usage_record', payload: {usage: {input_tokens: 100, output_tokens: 20}, thread_token_usage: {total_tokens: 120}}},
    ]);
    const analysis = analyze(result.session);
    expect(result.session.events.filter(e => e.kind === 'usage')).toHaveLength(1);
    expect([analysis.inputTokens, analysis.outputTokens]).toEqual([100, 20]);
  });
  it('still prefers usable token_count records over the alternative usage stream', () => {
    codex.reset();
    const result = read([
      codex.meta(), codex.msg('assistant', 'ok'), codex.tokens(120, 100),
      {type: 'token_usage_record', payload: {usage: {input_tokens: 100, output_tokens: 2}}},
    ]);
    expect(result.session.events.filter(e => e.kind === 'usage')).toHaveLength(1);
    expect(analyze(result.session).inputTokens).toBe(100);
  });
});

describe('tool output envelope representation parity', () => {
  it.each([1, 0])('preserves status and timing from both parsed and JSON-encoded envelopes (exit %s)', exitCode => {
    const envelope = {output: 'Synthetic output', metadata: {exit_code: exitCode, duration_seconds: 1.25}};
    const normalized = [envelope, JSON.stringify(envelope)].map(output => {
      codex.reset();
      const result = read([codex.meta(), codex.call('c', 'shell', {}), codex.output('c', output)]);
      const event = result.session.events.find(e => e.kind === 'tool_result')!;
      expect(event.raw).toMatchObject({output});
      return {output: event.output, isError: event.isError, durationMs: event.durationMs};
    });
    expect(normalized).toEqual([
      {output: 'Synthetic output', isError: exitCode !== 0, durationMs: 1250},
      {output: 'Synthetic output', isError: exitCode !== 0, durationMs: 1250},
    ]);
  });
  it('leaves absent status and ambiguous timing unknown rather than guessing', () => {
    codex.reset();
    const result = read([codex.meta(), codex.call('c', 'shell', {}), codex.output('c', {output: 'It says failure in ordinary text', metadata: {duration: 123}})]);
    const event = result.session.events.find(e => e.kind === 'tool_result')!;
    expect(event.isError).toBeUndefined(); expect(event.durationMs).toBeUndefined();
  });
  it('preserves ordinary object payloads that are not output envelopes', () => {
    codex.reset();
    const output = {name: 'status', data: [1, 2], metadata: {exit_code: 7}};
    const result = read([codex.meta(), codex.call('c', 'tool', {}), codex.output('c', output)]);
    const event = result.session.events.find(e => e.kind === 'tool_result')!;
    expect(event.output).toEqual(output); expect(event.isError).toBeUndefined();
  });
});

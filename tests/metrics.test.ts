import { describe, expect, it } from 'vitest';
import { buildMetrics, type StepTiming } from '../src/metrics.ts';
import { parse } from '../src/parse/index.ts';
import type { Session, TraceEvent } from '../src/parse/types.ts';
import { atifDoc, cc, ccSession, codex, jsonl } from './parse/fixtures.ts';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const pick = (s: StepTiming) => [s.label, s.elapsedMs ?? null, s.nextGapMs ?? null, s.durationMs ?? null];
const idOf = (session: Session, pred: (e: TraceEvent) => boolean) => session.events.find(pred)!.id;

describe('ATIF: grouped by the source step', () => {
  const { session } = parse(JSON.stringify(atifDoc()));
  const m = buildMetrics(session);

  it('reports timestamp intervals between steps and never a duration', () => {
    // step 3 has no content, so it produces no events and no step
    expect(m.steps.map(pick)).toEqual([
      ['Step 1', 0, 5000, null],
      ['Step 2', 5000, 7000, null],
      ['Step 4', 12_000, null, null],
    ]);
    expect(m.steps.map((s) => [s.key, s.grouping, s.eventCount])).toEqual([['s:1', 'step', 1], ['s:2', 'step', 7], ['s:4', 'step', 1]]);
    expect(m.steps[0].startMs).toBe(T0);
    expect(m.durationMs).toBe(12_000);
    expect(m.maxNextGapMs).toBe(7000);
    expect(m.ttftMs).toBeUndefined();
    expect(m.recordedDurationMs).toBeUndefined();
    expect(m.maxDurationMs).toBeUndefined();
  });

  it('attaches the step usage, and anchors the step on its first visible card', () => {
    expect(m.steps[1].usage).toEqual({ input: 120, output: 12, cacheRead: 100, total: 132, costUsd: 0.004 });
    expect(m.steps[0].usage).toBeUndefined();
    expect(m.steps[1].eventId).toBe(idOf(session, (e) => e.kind === 'thinking'));
  });

  it('does not turn the step interval into a duration for parallel tool calls', () => {
    const calls = session.events.filter((e) => e.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const em = m.byEvent.get(c.id)!;
      expect(em.durationMs).toBeUndefined();
      expect(em.nextGapMs).toBe(7000); // the step's interval, labelled as such
      expect(em.elapsedMs).toBe(5000);
      expect(em.usage).toEqual(m.steps[1].usage);
    }
    expect(m.byEvent.size).toBe(session.events.length);
  });

  it('uses a step-level duration and TTFT only when the source recorded them', () => {
    const doc = atifDoc();
    Object.assign(doc.steps[1].metrics!, { duration_ms: 4100, time_to_first_token_ms: 620 });
    const s = parse(JSON.stringify(doc)).session;
    const mm = buildMetrics(s);
    expect(mm.steps.map(pick)).toEqual([['Step 1', 0, 5000, null], ['Step 2', 5000, 7000, 4100], ['Step 4', 12_000, null, null]]);
    expect(mm.steps[1].ttftMs).toBe(620);
    expect(mm.ttftMs).toEqual([620]);
    expect(mm.maxDurationMs).toBe(4100);
    const call = mm.byEvent.get(idOf(s, (e) => e.kind === 'tool_call'))!;
    expect(call.durationMs).toBeUndefined(); // the step took 4.1s; that says nothing about one tool
    expect(call.ttftMs).toBe(620); // TTFT belongs to the response that produced the step
  });
});

describe('Claude Code: grouped by model response', () => {
  cc.reset();
  const { session } = parse(jsonl([
    cc.user('u', null, 'go'),                                                                   // t+0
    cc.assistant('a1', 'u', [cc.thinking('plan')], { thinkingDurationMs: 4200 }, { id: 'resp1', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 95 } }), // t+1
    cc.assistant('a2', 'a1', [cc.toolUse('t1')], {}, { id: 'resp1', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 95 } }),  // t+2
    cc.assistant('a3', 'a2', [cc.toolUse('t2')], {}, { id: 'resp1', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 95 } }),  // t+3
    cc.user('r2', 'a3', [cc.toolResult('t2')], { toolUseResult: { durationMs: 900 } }),          // t+4
    cc.user('r1', 'a2', [cc.toolResult('t1')], { toolUseResult: { durationMs: 730 } }),          // t+5
    cc.assistant('a4', 'r2', [cc.text('done')], {}, { id: 'resp2', usage: { input_tokens: 9, output_tokens: 2 } }), // t+6
    cc.assistant('x1', 'u', [cc.text('abandoned')], {}, { id: 'respX' }),                        // t+7, rewound branch
    { type: 'last-prompt', sessionId: 'cc-synthetic', leafUuid: 'a4' },
  ]));
  const m = buildMetrics(session);

  it('joins a response with the results of its own tool calls', () => {
    expect(m.steps.map((s) => [s.label, s.grouping, s.eventCount, s.elapsedMs, s.nextGapMs ?? null])).toEqual([
      ['User message', 'event', 1, 0, 1000],
      ['Response 1', 'response', 6, 1000, 5000],
      ['Response 2', 'response', 2, 6000, null],
    ]);
    expect(m.steps[1].usage).toEqual({ input: 100, output: 3, cacheRead: 95, total: 103 });
    expect(m.steps[1].eventId).toBe(idOf(session, (e) => e.kind === 'thinking'));
  });

  it('keeps recorded durations on their own events and does not add them into a step duration', () => {
    expect(m.steps[1].durationMs).toBeUndefined(); // 4.2s thinking + 0.73s + 0.9s parallel tools is not a step duration
    const of = (pred: (e: TraceEvent) => boolean) => m.byEvent.get(idOf(session, pred))!.durationMs;
    expect(of((e) => e.kind === 'thinking')).toBe(4200);
    expect(of((e) => e.kind === 'tool_call' && e.callId === 't1')).toBe(730);
    expect(of((e) => e.kind === 'tool_call' && e.callId === 't2')).toBe(900);
    expect(of((e) => e.kind === 'tool_result' && e.callId === 't2')).toBe(900);
    expect(of((e) => e.text === 'done')).toBeUndefined();
  });

  it('leaves abandoned branches out of the steps but still describes their events', () => {
    const off = session.events.find((e) => e.offPath)!;
    expect(off.text).toBe('abandoned');
    expect(m.steps.some((s) => s.key === 'r:respX')).toBe(false);
    expect(m.byEvent.get(off.id)).toEqual({ startMs: T0 + 7000, elapsedMs: 7000 }); // no stepKey: it belongs to no step
    expect(m.durationMs).toBe(7000);
  });
});

describe('Codex: grouped by model request', () => {
  codex.reset();
  const { session } = parse(jsonl([
    codex.meta(), codex.turn(),
    codex.msg('user', 'go'),                                                   // +2s
    codex.dup('Reasoning', 'r1', 1000, 4000), codex.reasoning('r1', 'Plan.'),   // +4s
    codex.call('c1', 'shell', { cmd: 'a' }),                                    // +5s
    codex.output('c1', 'Wall time: 1.5 seconds\nOutput:\nok'),                  // +6s
    codex.tokens(100, 80),                                                      // +7s  closes request 1
    codex.msg('assistant', 'Done.'),                                            // +8s
    codex.tokens(190, 90),                                                      // +9s  closes request 2
    codex.event('task_complete', { duration_ms: 61_000, time_to_first_token_ms: 850 }), // +10s
    codex.msg('user', 'again'),                                                 // +11s
    codex.msg('assistant', 'cut short'),                                        // +12s  no usage record follows
    codex.event('turn_aborted', { reason: 'interrupted', duration_ms: 3000 }),  // +13s
    codex.msg('assistant', 'new turn output'),                                  // +14s
  ]));
  const m = buildMetrics(session);

  it('closes a request at its usage record and at turn boundaries', () => {
    expect(m.steps.map((s) => [s.label, s.grouping, s.eventCount])).toEqual([
      ['User message', 'event', 1],
      ['Request 1', 'request', 4],
      ['Request 2', 'request', 2],
      ['Task complete', 'event', 1],
      ['User message', 'event', 1],
      ['Request 3', 'request', 1],
      ['Turn aborted', 'event', 1],
      ['Request 4', 'request', 1],
    ]);
    expect(m.steps[1].usage).toEqual({ input: 80, output: 2, cacheRead: 4, reasoning: 1, total: 82 });
    expect(m.steps[2].usage?.input).toBe(90);
    expect(m.steps[5].usage).toBeUndefined();
  });

  it('carries turn duration and TTFT on the turn marker only', () => {
    expect(m.steps.map((s) => [s.durationMs ?? null, s.ttftMs ?? null])).toEqual([
      [null, null], [null, null], [null, null], [61_000, 850], [null, null], [null, null], [3000, null], [null, null],
    ]);
    expect(m.ttftMs).toEqual([850]);
    expect(m.recordedDurationMs).toBe(64_000);
    expect(m.durationMs).toBe(12_000); // timestamp span, reported separately from recorded turn time
    expect(m.steps[1].nextGapMs).toBe(4000);
  });

  it('gives a tool call the wall time its result recorded, and reasoning its own item time', () => {
    const of = (pred: (e: TraceEvent) => boolean) => m.byEvent.get(idOf(session, pred))!;
    expect(of((e) => e.kind === 'tool_call').durationMs).toBe(1500);
    expect(of((e) => e.kind === 'thinking').durationMs).toBe(3000);
    expect(of((e) => e.text === 'Done.').durationMs).toBeUndefined();
    expect(of((e) => e.text === 'Done.').usage?.input).toBe(90);
  });
});

describe('edge cases', () => {
  const make = (rows: Partial<TraceEvent>[], format = 'chat'): Session => ({
    id: 's', format, meta: {},
    events: rows.map((r, idx) => ({ idx, id: `e${idx}`, actor: 'assistant', kind: 'message', ...r }) as TraceEvent),
  });

  it('reports nothing time-based when the source has no timestamps', () => {
    const m = buildMetrics(make([{ step: 1, text: 'a' }, { step: 2, text: 'b' }]));
    expect(m.steps).toEqual([
      { key: 's:1', label: 'Message 1', eventId: 'e0', grouping: 'step', eventCount: 1 },
      { key: 's:2', label: 'Message 2', eventId: 'e1', grouping: 'step', eventCount: 1 },
    ]);
    expect(m.durationMs).toBeUndefined();
    expect(m.maxNextGapMs).toBeUndefined();
    expect([...m.byEvent.values()]).toEqual([{ stepKey: 's:1' }, { stepKey: 's:2' }]);
  });

  it('ignores a backwards timestamp instead of reporting a negative interval', () => {
    const at = (s: number) => new Date(T0 + s * 1000).toISOString();
    const m = buildMetrics(make([{ step: 1, ts: at(10) }, { step: 2, ts: at(4) }, { step: 3, ts: at(20) }]));
    expect(m.steps.map((s) => s.nextGapMs ?? null)).toEqual([null, 16_000, null]);
    expect(m.steps.map((s) => s.elapsedMs)).toEqual([6000, 0, 16_000]);
  });

  it('does not use sub-agent events to measure main-thread intervals', () => {
    const at = (s: number) => new Date(T0 + s * 1000).toISOString();
    const m = buildMetrics(make([
      { responseId: 'a', ts: at(0) }, { responseId: 'sub', ts: at(3), sidechain: true }, { responseId: 'b', ts: at(10) },
    ], 'claude-code'));
    expect(m.steps.map((s) => [s.label, s.nextGapMs ?? null])).toEqual([['Response 1', 10_000], ['Response 2', null], ['Response 3', null]]);
  });

  it('tells the UI which step each event belongs to', () => {
    const { session } = parse(jsonl(ccSession(2)));
    const m = buildMetrics(session);
    const keys = session.events.map((e) => m.byEvent.get(e.id)!.stepKey);
    expect(new Set(keys).size).toBe(m.steps.length);
    expect(keys.every((k) => m.steps.some((s) => s.key === k))).toBe(true);
    // user turn, then response (call + usage + its result), then response (text + usage)
    expect(keys.slice(0, 6).map((k) => keys.indexOf(k))).toEqual([0, 1, 1, 1, 4, 4]);
  });

  it('never lets one event\'s duration stand in for a multi-event or grouped step', () => {
    const lone = buildMetrics(make([{ responseId: 'r', kind: 'thinking', durationMs: 900 }], 'claude-code'));
    expect(lone.steps[0]).toMatchObject({ label: 'Response 1', eventCount: 1 });
    expect(lone.steps[0].durationMs).toBeUndefined(); // 900ms of thinking is not the response's duration
    expect(lone.byEvent.get('e0')!.durationMs).toBe(900);

    const request = buildMetrics(make([{ text: 'streamed', durationMs: 400, ttftMs: 50 }], 'codex'));
    expect(request.steps[0]).toMatchObject({ label: 'Request 1', grouping: 'request' });
    expect(request.steps[0].durationMs).toBeUndefined();
    expect(request.steps[0].ttftMs).toBeUndefined();

    const marker = buildMetrics(make([{ kind: 'meta', actor: 'system', name: 'task_complete', durationMs: 5000, ttftMs: 700 }], 'codex'));
    expect(marker.steps[0]).toMatchObject({ label: 'Task complete', grouping: 'event', durationMs: 5000, ttftMs: 700 });
  });

  it('does not guess when a call has several results with durations', () => {
    const m = buildMetrics(make([
      { kind: 'tool_call', callId: 'c', name: 't' },
      { kind: 'tool_result', actor: 'tool', callId: 'c', durationMs: 5 },
      { kind: 'tool_result', actor: 'tool', callId: 'c', durationMs: 7 },
    ], 'claude-code'));
    expect(m.byEvent.get('e0')!.durationMs).toBeUndefined();
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0]).toMatchObject({ label: 't call', eventCount: 3, eventId: 'e0' });
    expect(m.steps[0].durationMs).toBeUndefined();
  });

  it('builds metrics for a 50k-event session in one quick pass', () => {
    const { session } = parse(jsonl(ccSession(8400)));
    const t0 = performance.now();
    const m = buildMetrics(session);
    const ms = performance.now() - t0;
    expect(m.byEvent.size).toBe(session.events.length);
    expect(m.steps).toHaveLength(8400 * 3); // user turn + two responses per turn
    console.info(`buildMetrics: ${session.events.length} events in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

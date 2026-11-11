import { describe, expect, it } from 'vitest';
import { analyze, excerptAround, findRanges, firstMatch, fold, formatSpan, matchExcerpt, valueText } from '../../src/analyze/index.ts';
import { parse } from '../../src/parse/index.ts';
import type { Session, TraceEvent } from '../../src/parse/types.ts';
import { atifDoc, ccSession, codex, jsonl } from '../parse/fixtures.ts';

/** Build a synthetic session directly, so each test states exactly the evidence it relies on. */
function session(rows: Partial<TraceEvent>[], meta: Session['meta'] = {}): Session {
  const events = rows.map((r, idx) => ({ idx, id: `e${idx}`, actor: 'assistant', kind: 'message', ...r }) as TraceEvent);
  return { id: 's', format: 'chat', meta, events };
}
const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + sec * 1000).toISOString();
const call = (callId: string, name: string, input: unknown, extra: Partial<TraceEvent> = {}): Partial<TraceEvent> =>
  ({ kind: 'tool_call', callId, name, input, ...extra });
const result = (callId: string, output: unknown, extra: Partial<TraceEvent> = {}): Partial<TraceEvent> =>
  ({ kind: 'tool_result', actor: 'tool', callId, output, ...extra });

describe('search index', () => {
  it('lowercases once and makes a call searchable by all of its results', () => {
    const a = analyze(session([
      { actor: 'user', text: 'Find The NEEDLE' },
      call('c1', 'Grep', { pattern: 'Needle', path: 'SRC/a.ts' }),
      result('c1', 'First HIT'),
      result('c1', [{ type: 'text', text: 'Second Hit' }]),
      { kind: 'thinking', text: 'Hmm' },
    ]));
    expect(a.searchIndex.size).toBe(5);
    expect(a.searchIndex.get('e0')).toBe('find the needle');
    const hay = a.searchIndex.get('e1')!;
    for (const term of ['grep', 'pattern', 'needle', 'src/a.ts', 'first hit', 'second hit']) expect(hay).toContain(term);
    expect(a.searchIndex.get('e2')).toBe('first hit');
    expect(a.searchIndex.get('e4')).toBe('hmm');
    for (const v of a.searchIndex.values()) expect(v).toBe(v.toLowerCase());
  });

  it('skips encoded binary but keeps long real text', () => {
    const blob = 'A'.repeat(10_000);
    const prose = 'word '.repeat(4000);
    expect(valueText({ image: { data: blob }, caption: 'Chart' })).toBe('image data caption Chart');
    expect(valueText([prose]).length).toBe(prose.length);
    expect(valueText(blob)).toBe(blob); // a plain string output is always kept whole
    expect(valueText({ n: 3, ok: true, none: null })).toBe('n 3 ok true none');
    // content parts contribute their text only, so searching "text" or "type" does not match every structured output
    expect(valueText([{ type: 'text', text: 'Hello' }, { type: 'image', source: { media_type: 'image/png', data: blob } }])).toBe('Hello type image source media_type image/png data');
  });

  it('gives each tool call a one-line preview', () => {
    const a = analyze(session([
      call('1', 'Read', { limit: 5, file_path: '/work/a.ts' }),
      call('2', 'Bash', { command: 'npm test\nnpm run build' }),
      call('3', 'exec', 'ls -la'),
      call('4', 'custom', { count: 2 }),
      call('5', 'long', { query: 'q'.repeat(200) }),
    ]));
    expect([...a.previews.values()].slice(0, 4)).toEqual(['/work/a.ts', 'npm test', 'ls -la', '']);
    expect(a.previews.get('e4')!.length).toBe(80);
  });
});

describe('matching in original text', () => {
  const marks = (text: string, query: string, opts?: Parameters<typeof findRanges>[2]) =>
    findRanges(fold(text), query, opts).map(([a, b]) => text.slice(a, b));

  it('finds matches case-insensitively and returns the original casing', () => {
    expect(marks('Error: no ERROR, just an error.', 'error')).toEqual(['Error', 'ERROR', 'error']);
    expect(marks('aaaa', 'aa')).toEqual(['aa', 'aa']); // non-overlapping
    expect(marks('nothing here', 'zzz')).toEqual([]);
    expect(marks('anything', '')).toEqual([]);
    expect(firstMatch(fold('one Two'), 'TWO')).toBe(4);
  });

  it('stays aligned after a character that changes length when lowercased', () => {
    const text = 'İstanbul and İzmir: Error in İzmir';
    expect(text.toLowerCase().length).not.toBe(text.length); // the naive approach would be off by one per İ
    expect(marks(text, 'error')).toEqual(['Error']);
    expect(marks(text, 'izmir')).toEqual([]); // İ lowercases to i + combining dot, which is not a plain i
    expect(marks(text, 'İzmir')).toEqual(['İzmir', 'İzmir']);
    expect(marks(text, 'i')).toEqual(['İ', 'İ', 'i', 'i', 'İ', 'i']); // a match inside İ widens to the whole character
    expect(firstMatch(fold(text), 'and')).toBe(text.indexOf('and'));
  });

  it('handles emoji, CJK and Greek final sigma', () => {
    expect(marks('done 👋 你好 DONE 👋', 'done')).toEqual(['done', 'DONE']);
    expect(marks('👋👋 ok', '👋')).toEqual(['👋', '👋']);
    expect(marks('你好，世界', '世界')).toEqual(['世界']);
    expect(marks('ΟΔΟΣ οδός ΟΔΟΣ', 'οδοσ')).toEqual(['ΟΔΟΣ', 'ΟΔΟΣ']);
    expect(marks('ΟΔΟΣ', 'ΟΔΟΣ')).toEqual(['ΟΔΟΣ']);
  });

  it('never ends a match inside a combined character, and never returns overlapping ranges', () => {
    expect(marks('e\u0301e\u0301 x', 'e')).toEqual(['e\u0301', 'e\u0301']);
    expect(marks('👍🏿👍', '👍')).toEqual(['👍🏿', '👍']);
    expect(marks('❤\ufe0f ok', '❤')).toEqual(['❤\ufe0f']);
    const text = 'a\u0301\u0301b';
    const ranges = findRanges(fold(text), '\u0301');
    expect(ranges).toEqual([[1, 3]]); // the second accent is inside the first range, not a second overlapping one
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][1]);
  });

  it('restricts the search to a window and honors the limit', () => {
    const text = 'x '.repeat(1000) + 'İ ' + 'x '.repeat(1000);
    expect(findRanges(fold(text), 'x', { from: 100, to: 110 })).toEqual([[100, 101], [102, 103], [104, 105], [106, 107], [108, 109]]);
    expect(findRanges(fold(text), 'x', { from: 2004, to: 2010 })).toEqual([[2004, 2005], [2006, 2007], [2008, 2009]]); // window after the İ
    expect(findRanges(fold(text), 'x', { limit: 3 })).toHaveLength(3);
  });

  it('cuts excerpts around the match without splitting characters', () => {
    const text = 'a'.repeat(100) + ' NEEDLE\n\n  in   a haystack ' + 'b'.repeat(300);
    const ex = excerptAround(text, text.indexOf('NEEDLE'), 60);
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('…')).toBe(true);
    expect(ex).toContain('NEEDLE in a'); // whitespace collapsed
    expect(excerptAround('short text', 6, 60)).toBe('short text');
    const emoji = '👋'.repeat(100);
    for (const at of [57, 58, 59, 60]) expect(excerptAround(emoji, at, 21)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe('match excerpts for list rows', () => {
  const s = session([
    { actor: 'user', text: 'Please FIX the Flaky Test in CI' },
    call('c1', 'Bash', { command: 'npm TEST -- --Watch' }),
    result('c1', 'PASS src/a.test.ts\nFAIL src/B.test.ts: Timeout Exceeded', { name: 'Bash' }),
    result('c1', [{ type: 'text', text: 'Second Output Chunk' }], { name: 'Bash' }),
    { kind: 'thinking', text: 'İstanbul Deploy Failed' },
  ]);
  const a = analyze(s);
  const ex = (i: number, q: string) => matchExcerpt(a, s.events[i], q);

  it('shows the source casing, never the lowercased index', () => {
    expect(ex(0, 'flaky')).toBe('Please FIX the Flaky Test in CI');
    expect(ex(1, 'test --')).toBe('command npm TEST -- --Watch'); // argument names are part of what is searchable
    expect(a.searchIndex.get('e0')).toBe('please fix the flaky test in ci'); // what the UI must not display
  });

  it('finds the match inside a result of the call, in the right piece', () => {
    expect(ex(1, 'timeout')).toBe('PASS src/a.test.ts FAIL src/B.test.ts: Timeout Exceeded');
    expect(ex(1, 'second output')).toBe('Second Output Chunk');
    expect(ex(1, 'bash')).toBe('Bash ');
    expect(ex(2, 'b.test')).toContain('FAIL src/B.test.ts');
  });

  it('returns undefined when the event does not match, and survives length-changing characters', () => {
    expect(ex(0, 'absent')).toBeUndefined();
    expect(ex(0, '')).toBeUndefined();
    expect(ex(4, 'deploy')).toBe('İstanbul Deploy Failed');
  });

  it('does not copy a large output to build one row preview', () => {
    const big = 'line of ordinary log output\n'.repeat(180_000) + 'UNIQUE-MARKER tail'; // about 5 MB
    const bigSession = session([call('c', 'Bash', { command: 'x' }), result('c', big)]);
    const an = analyze(bigSession);
    const t0 = performance.now();
    let out = '';
    for (let i = 0; i < 100; i++) out = matchExcerpt(an, bigSession.events[0], 'unique-marker')!;
    const ms = performance.now() - t0;
    expect(out).toContain('UNIQUE-MARKER tail');
    console.info(`matchExcerpt on a 5 MB output: ${(ms / 100).toFixed(2)} ms per row`);
    expect(ms / 100).toBeLessThan(20);
  });
});

describe('token totals', () => {
  it('prefers the total the source reports', () => {
    const a = analyze(parse(JSON.stringify(atifDoc())).session);
    expect(a).toMatchObject({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 100, tokenSource: 'reported' });
    expect(a.requestCount).toBeUndefined();
  });

  it('sums per-request usage when there is no reported total', () => {
    const a = analyze(parse(jsonl(ccSession(3))).session);
    // each turn: (10 + 90 cached, 5 out) + (12, 7 out)
    expect(a).toMatchObject({ inputTokens: 336, outputTokens: 36, cacheReadTokens: 270, tokenSource: 'summed', requestCount: 6 });
  });

  it('does not double count Codex running totals or repeated token_count records', () => {
    codex.reset();
    const a = analyze(parse(jsonl([
      codex.meta(), codex.msg('user', 'go'),
      codex.tokens(100, 100), codex.tokens(100, 100), codex.tokens(100, 100),
      codex.msg('assistant', 'one'),
      codex.tokens(250, 150),
      { timestamp: '2026-01-01T11:10:00Z', type: 'token_usage_record', payload: { usage: { input_tokens: 150, output_tokens: 2 } } },
      codex.msg('assistant', 'two'),
    ])).session);
    expect(a).toMatchObject({ inputTokens: 250, outputTokens: 4, tokenSource: 'summed', requestCount: 2 });
  });

  it('reports no totals when the source has no usage', () => {
    const a = analyze(session([{ text: 'hi' }]));
    expect(a.inputTokens).toBeUndefined();
    expect(a.outputTokens).toBeUndefined();
    expect(a.tokenSource).toBeUndefined();
  });
});

describe('notes', () => {
  it('counts explicitly flagged errors and points at the visible call card', () => {
    const a = analyze(session([
      call('c1', 'Bash', { command: 'a' }), result('c1', 'boom', { isError: true, name: 'Bash' }),
      call('c2', 'Read', { file_path: 'x' }), result('c2', 'fine', { name: 'Read' }),
      call('c3', 'Bash', { command: 'b' }), result('c3', 'boom again', { isError: true, name: 'Bash' }),
      { kind: 'meta', actor: 'system', name: 'turn_aborted', text: 'interrupted', isError: true },
    ]));
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0]).toMatchObject({ id: 'error:all', kind: 'error', count: 3, title: '3 errors reported', eventId: 'e0', eventIds: ['e0', 'e4', 'e6'] });
    expect(a.notes[0].detail).toMatch(/By tool: Bash ×2\. 1 non-tool error .* at events 1, 5, 7\./);
  });

  it('reports a run of consecutive failing tool results', () => {
    const rows = [0, 1, 2, 3].flatMap((i) => [call(`c${i}`, 'Edit', { n: i }), result(`c${i}`, 'no', { isError: true, name: 'Edit' })]);
    const a = analyze(session([...rows, call('ok', 'Edit', { n: 9 }), result('ok', 'yes')]));
    expect(a.notes.map((n) => n.id)).toEqual(['error:all', 'error:streak']);
    expect(a.notes[1]).toMatchObject({ title: '4 tool errors in a row', count: 4, eventId: 'e0' });
    expect(a.notes[1].detail).toBe('Every tool result from event 1 to event 7 was flagged as an error by the source.');
  });

  it('does not invent errors when the source flags none', () => {
    const a = analyze(session([call('c', 'Bash', {}), result('c', 'Traceback: Error: failed with exit code 1')]));
    expect(a.notes).toEqual([]);
  });

  it('finds identical calls regardless of key order and compares their outputs', () => {
    const a = analyze(session([
      call('a', 'Read', { path: 'a.ts', limit: 10 }), result('a', 'same'),
      call('b', 'Read', { limit: 10, path: 'a.ts' }), result('b', 'same'),
      call('x', 'Read', { path: 'other.ts' }), result('x', 'else'),
      call('c', 'Read', { path: 'a.ts', limit: 10 }), result('c', 'changed'),
      call('d', 'Write', { path: 'a.ts' }), call('e', 'Write', { path: 'a.ts' }),
    ]));
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0]).toMatchObject({ id: 'repeat:1', kind: 'repeat', count: 3, title: 'Read repeated 3×', eventId: 'e0', eventIds: ['e0', 'e2', 'e6'] });
    expect(a.notes[0].detail).toBe('Called 3 times with identical arguments, at events 1, 3, 7. 2 of 3 returned the same output.');
  });

  it('says nothing about outputs when some calls have no result', () => {
    const a = analyze(session([call('a', 'Poll', {}), result('a', '1'), call('b', 'Poll', {}), call('c', 'Poll', {})]));
    expect(a.notes[0].detail).toBe('Called 3 times with identical arguments, at events 1, 3, 4.');
  });

  it('labels long timestamp gaps as gaps, and ignores the human being away', () => {
    const a = analyze(session([
      { actor: 'user', text: 'start', ts: at(0) },
      { text: 'ok', ts: at(2) },
      call('c1', 'Bash', { command: 'sleep' }, { ts: at(4) }),
      result('c1', 'done', { ts: at(304), name: 'Bash' }), // 5 minutes later
      { text: 'finished', ts: at(306) },
      { actor: 'system', text: '<note>resumed</note>', ts: at(90_000) }, // a day later, the person returns
      { actor: 'user', text: 'next task', ts: at(90_001) },
      { text: 'sure', ts: at(90_003) },
    ]));
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0]).toMatchObject({ id: 'gap:1', kind: 'gap', title: 'Timestamp gap of 5m', eventId: 'e2', eventIds: ['e2', 'e2'] });
    expect(a.notes[0].detail).toBe('Between event 3 (Bash call) and event 4 (Bash result). From timestamps only: the source records no duration here, so this may include idle time.');
  });

  it('reports no gap when events are evenly spaced or carry no timestamps', () => {
    expect(analyze(session([0, 40, 80, 120, 160].map((s) => ({ text: 'x', ts: at(s) })))).notes).toEqual([]);
    expect(analyze(session([{ text: 'a' }, { text: 'b' }])).notes).toEqual([]);
  });

  it('never points a note at an abandoned branch', () => {
    const a = analyze(session([
      ...[0, 1, 2].map((i) => call(`o${i}`, 'Read', { path: 'a' }, { offPath: true })),
      result('o0', 'x', { isError: true, offPath: true }),
      { text: 'kept' },
    ]));
    expect(a.notes).toEqual([]);
    expect(a.searchIndex.size).toBe(5); // still searchable when the user chooses to show them
  });

  it('returns at most five notes with every kind represented', () => {
    const rows: Partial<TraceEvent>[] = [];
    let t = 0;
    for (let i = 0; i < 4; i++) {
      rows.push(call(`r${i}`, 'Read', { path: 'a' }, { ts: at(t++) }), result(`r${i}`, 'x', { isError: true, name: 'Read', ts: at(t++) }));
      rows.push(call(`g${i}`, 'Grep', { q: 'b' }, { ts: at(t++) }), result(`g${i}`, 'y', { isError: true, name: 'Grep', ts: at(t++) }));
    }
    rows.push({ text: 'slow one', ts: at((t += 600)) }, { text: 'slow two', ts: at((t += 900)) }, { text: 'end', ts: at(t + 1) });
    const a = analyze(session(rows));
    expect(a.notes.map((n) => n.id)).toEqual(['error:all', 'repeat:1', 'gap:1', 'error:streak', 'repeat:2']);
    expect(a.notes[2].title).toBe('Timestamp gap of 15m');
    const ids = new Set(session(rows).events.map((e) => e.id));
    for (const n of a.notes) {
      expect(ids.has(n.eventId)).toBe(true);
      for (const id of n.eventIds ?? []) expect(ids.has(id)).toBe(true);
    }
  });

  it('formats spans without false precision', () => {
    expect([29_600, 90_000, 3_600_000, 5_400_000, 90_000_000].map(formatSpan)).toEqual(['30s', '1m 30s', '1h', '1h 30m', '1d 1h']);
    // short recorded durations and TTFT keep their precision instead of rounding to whole seconds
    expect([850, 1000, 1240, 1500, 9940, 9960, 10_400].map(formatSpan)).toEqual(['850ms', '1s', '1.2s', '1.5s', '9.9s', '10s', '10s']);
  });
});

describe('performance', () => {
  it('analyzes a 50k-event session in one quick pass', () => {
    const { session: s } = parse(jsonl(ccSession(8400)));
    const t0 = performance.now();
    const a = analyze(s);
    const ms = performance.now() - t0;
    expect(a.searchIndex.size).toBe(s.events.length);
    expect(a.requestCount).toBe(16_800);
    console.info(`analyze: ${s.events.length} events in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

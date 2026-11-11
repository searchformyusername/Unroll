import type { Session, TraceEvent } from '../parse/types.ts';
import { excerptAround, firstMatch, fold } from './match.ts';

export { excerptAround, findRanges, firstMatch, fold, foldQuery, type Folded } from './match.ts';

export type NoteKind = 'repeat' | 'error' | 'gap';

/** One evidence-backed observation. Every note points at source events; nothing is inferred. */
export interface Note {
  id: string;
  title: string;
  detail: string;
  /** Event to jump to. Always a card the timeline shows (a paired tool_result maps to its call). */
  eventId: string;
  kind: NoteKind;
  /** Every source event behind the note, in order (capped at 50). */
  eventIds?: string[];
  /** How many occurrences the note counts. */
  count?: number;
}

export interface Analysis {
  /** Prompt tokens across all model requests, cached tokens included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Subset of inputTokens served from cache. */
  cacheReadTokens?: number;
  /** 'reported': the source's own session total. 'summed': added up from per-request usage events. */
  tokenSource?: 'reported' | 'summed';
  /** Number of per-request usage events behind a 'summed' total. */
  requestCount?: number;
  /** At most 5 notes. */
  notes: Note[];
  /** event id → lowercased searchable text. A tool_call entry includes the text of all its results. */
  searchIndex: Map<string, string>;
  /** tool_call event id → short one-line summary of its arguments (path, command, query…). */
  previews: Map<string, string>;
  /** callId → every result recorded for that call, in order. */
  results: Map<string, TraceEvent[]>;
}

const MAX_NOTES = 5;
const MAX_NOTE_EVENTS = 50;
const MIN_REPEATS = 3;
const MIN_STREAK = 3;
const MIN_GAP_MS = 30_000;
const GAP_FACTOR = 5;
const PREVIEW_KEYS = ['file_path', 'path', 'command', 'cmd', 'query', 'pattern', 'url', 'description', 'prompt'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);

/** Long unbroken strings are encoded binary (base64 images etc.), not something a person searches for. */
const isBlob = (s: string) => s.length > 4096 && !/\s/.test(s.slice(0, 256));

/** All keys and scalar values of a JSON value as plain text. Iterative, so depth is not a concern. */
export function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  const parts: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (!isBlob(v)) parts.push(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(String(v));
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isObj(v)) {
      if (typeof v.type === 'string' && typeof v.text === 'string') {
        parts.push(v.text); // a content part: index its text, not the words "type" and "text"
        continue;
      }
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push(v[keys[i]]);
        stack.push(keys[i]);
      }
    }
  }
  return parts.join(' ');
}

/** Key-order-independent serialization, so {a,b} and {b,a} count as the same arguments. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) {
    const keys = Object.keys(v).sort();
    let out = '{';
    for (let i = 0; i < keys.length; i++) out += (i ? ',' : '') + JSON.stringify(keys[i]) + ':' + stable(v[keys[i]]);
    return out + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

function preview(input: unknown): string {
  let s: string | undefined;
  if (typeof input === 'string') s = input;
  else if (isObj(input)) {
    for (const k of PREVIEW_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v) { s = v; break; }
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) { s = v.join(' '); break; }
    }
    if (s === undefined) {
      for (const k in input) {
        const v = input[k];
        if (typeof v === 'string' && v) { s = v; break; }
      }
    }
  }
  if (!s) return '';
  const nl = s.indexOf('\n');
  if (nl !== -1) s = s.slice(0, nl);
  s = s.trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

/** 850ms · 4.2s · 30s · 1m 30s · 1h 30m · 1d 1h. Sub-10-second values keep one decimal so short recorded durations are not rounded away. */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function describe(e: TraceEvent): string {
  switch (e.kind) {
    case 'tool_call': return `${e.name ?? 'tool'} call`;
    case 'tool_result': return `${e.name ?? 'tool'} result`;
    case 'thinking': return 'reasoning';
    case 'message': return `${e.actor} message`;
    default: return e.kind;
  }
}

const listEvents = (events: TraceEvent[]): string => {
  const shown = events.slice(0, 6).map((e) => e.idx + 1).join(', ');
  return events.length > 6 ? `${shown} and ${events.length - 6} more` : shown;
};

function tokens(session: Session, out: Analysis): void {
  const reported = session.meta.totalUsage;
  if (isObj(reported) && (typeof reported.input === 'number' || typeof reported.output === 'number')) {
    if (typeof reported.input === 'number') out.inputTokens = reported.input;
    if (typeof reported.output === 'number') out.outputTokens = reported.output;
    if (typeof reported.cacheRead === 'number') out.cacheReadTokens = reported.cacheRead;
    out.tokenSource = 'reported';
    return;
  }
  // Usage events are per model request (the parser already removes repeated and running-total records),
  // so a plain sum is the session total.
  let input = 0, output = 0, cache = 0, n = 0;
  let hasIn = false, hasOut = false, hasCache = false;
  for (const e of session.events) {
    const u = e.usage;
    if (e.kind !== 'usage' || !u) continue;
    if (u.input === undefined && u.output === undefined) continue;
    n++;
    if (u.input !== undefined) { input += u.input; hasIn = true; }
    if (u.output !== undefined) { output += u.output; hasOut = true; }
    if (u.cacheRead !== undefined) { cache += u.cacheRead; hasCache = true; }
  }
  if (!n) return;
  if (hasIn) out.inputTokens = input;
  if (hasOut) out.outputTokens = output;
  if (hasCache) out.cacheReadTokens = cache;
  out.tokenSource = 'summed';
  out.requestCount = n;
}

/**
 * Derive totals, notes and a search index from a parsed session in one pass over the events
 * (plus a sort over the handful of note candidates). Pure and synchronous.
 */
export function analyze(session: Session): Analysis {
  const events = session.events;
  const out: Analysis = { notes: [], searchIndex: new Map(), previews: new Map(), results: new Map() };
  tokens(session, out);

  // ---- pass 1: pair results with calls, and lowercase every result once.
  const callById = new Map<string, TraceEvent>();
  const resultsByCall = out.results;
  const lowerResult = new Map<string, string>(); // result event id → lowercased text
  for (const e of events) {
    if (e.callId === undefined) continue;
    if (e.kind === 'tool_call') callById.set(e.callId, e);
    else if (e.kind === 'tool_result') {
      const list = resultsByCall.get(e.callId);
      if (list) list.push(e);
      else resultsByCall.set(e.callId, [e]);
    }
  }
  /** The card the timeline shows for an event: a paired result is displayed inside its call. */
  const card = (e: TraceEvent): TraceEvent =>
    (e.kind === 'tool_result' && e.callId !== undefined ? callById.get(e.callId) : undefined) ?? e;

  // ---- pass 2: search index, previews, and note candidates.
  const errors: TraceEvent[] = [];
  const repeats = new Map<string, TraceEvent[]>();
  let streak: TraceEvent[] = [];
  let bestStreak: TraceEvent[] = [];
  const gaps: { ms: number; a: TraceEvent; b: TraceEvent }[] = [];
  const positive: number[] = [];
  let prev: TraceEvent | undefined;
  let prevT = NaN;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const name = e.name ? e.name + '\n' : '';
    let hay: string;
    if (e.kind === 'tool_result') {
      hay = (name + valueText(e.output)).toLowerCase();
      lowerResult.set(e.id, hay);
    } else if (e.kind === 'tool_call') {
      hay = (name + valueText(e.input)).toLowerCase();
      out.previews.set(e.id, preview(e.input));
    } else {
      hay = (name + (e.text ?? (e.kind === 'unknown' ? valueText(e.raw).slice(0, 20_000) : ''))).toLowerCase();
    }
    out.searchIndex.set(e.id, hay);

    if (e.offPath) continue; // abandoned branches are hidden by default; notes must point at visible events

    if (e.isError === true) errors.push(e);
    if (e.kind === 'tool_result') {
      if (e.isError === true) streak.push(e);
      else {
        if (streak.length > bestStreak.length) bestStreak = streak;
        streak = [];
      }
    } else if (e.kind === 'tool_call') {
      const key = (e.name ?? '') + '\u0000' + stable(e.input);
      const group = repeats.get(key);
      if (group) group.push(e);
      else repeats.set(key, [e]);
    }

    if (e.sidechain || e.kind === 'usage' || e.ts === undefined) continue; // usage markers are hidden by default
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (prev && t > prevT) {
      const ms = t - prevT;
      positive.push(ms);
      if (ms >= MIN_GAP_MS && !humanTurnStartsAt(events, i)) gaps.push({ ms, a: prev, b: e });
    }
    prev = e;
    prevT = t;
  }
  if (streak.length > bestStreak.length) bestStreak = streak;

  // A tool_call is searchable by everything it returned.
  for (const [callId, list] of resultsByCall) {
    const call = callById.get(callId);
    if (!call) continue;
    let hay = out.searchIndex.get(call.id) ?? '';
    for (const r of list) hay += '\n' + (lowerResult.get(r.id) ?? '');
    out.searchIndex.set(call.id, hay);
  }

  // ---- notes
  const errorNotes: Note[] = [];
  if (errors.length) {
    const byTool = new Map<string, number>();
    let toolErrors = 0;
    for (const e of errors) {
      if (e.kind !== 'tool_result') continue;
      toolErrors++;
      const k = e.name ?? 'unnamed tool';
      byTool.set(k, (byTool.get(k) ?? 0) + 1);
    }
    const top = [...byTool].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(', ');
    const other = errors.length - toolErrors;
    errorNotes.push({
      id: 'error:all', kind: 'error', count: errors.length,
      title: toolErrors === errors.length
        ? `${errors.length} tool ${plural(errors.length, 'error')} reported`
        : `${errors.length} ${plural(errors.length, 'error')} reported`,
      detail: `${top ? `By tool: ${top}${byTool.size > 4 ? ', …' : ''}. ` : ''}${other ? `${other} non-tool ${plural(other, 'error')} (aborts or API failures). ` : ''}Counted from the source's own error flags, at ${plural(errors.length, 'event')} ${listEvents(errors.map(card))}.`,
      eventId: card(errors[0]).id,
      eventIds: errors.slice(0, MAX_NOTE_EVENTS).map((e) => card(e).id),
    });
  }
  if (bestStreak.length >= MIN_STREAK) {
    const first = card(bestStreak[0]);
    const last = card(bestStreak[bestStreak.length - 1]);
    errorNotes.push({
      id: 'error:streak', kind: 'error', count: bestStreak.length,
      title: `${bestStreak.length} tool errors in a row`,
      detail: `Every tool result from event ${first.idx + 1} to event ${last.idx + 1} was flagged as an error by the source.`,
      eventId: first.id,
      eventIds: bestStreak.slice(0, MAX_NOTE_EVENTS).map((e) => card(e).id),
    });
  }

  const repeatNotes: Note[] = [];
  const groups = [...repeats.values()].filter((g) => g.length >= MIN_REPEATS)
    .sort((x, y) => y.length - x.length || x[0].idx - y[0].idx).slice(0, 2);
  groups.forEach((g, n) => {
    let detail = `Called ${g.length} times with identical arguments, at events ${listEvents(g)}.`;
    const outputs = new Map<string, number>();
    let answered = 0;
    for (const call of g) {
      const list = call.callId !== undefined ? resultsByCall.get(call.callId) : undefined;
      if (!list?.length) continue;
      answered++;
      const key = list.map((r) => (typeof r.output === 'string' ? r.output : stable(r.output))).join('\u0000');
      outputs.set(key, (outputs.get(key) ?? 0) + 1);
    }
    if (answered === g.length) {
      const same = Math.max(...outputs.values());
      detail += same === g.length ? ` All ${g.length} returned the same output.`
        : same > 1 ? ` ${same} of ${g.length} returned the same output.`
        : ' Each returned a different output.';
    }
    repeatNotes.push({
      id: `repeat:${n + 1}`, kind: 'repeat', count: g.length,
      title: `${g[0].name ?? 'Tool'} repeated ${g.length}×`,
      detail, eventId: g[0].id, eventIds: g.slice(0, MAX_NOTE_EVENTS).map((e) => e.id),
    });
  });

  const gapNotes: Note[] = [];
  if (gaps.length) {
    positive.sort((x, y) => x - y);
    const median = positive[positive.length >> 1];
    gaps.filter((g) => g.ms >= median * GAP_FACTOR).sort((x, y) => y.ms - x.ms).slice(0, 2).forEach((g, n) => {
      gapNotes.push({
        id: `gap:${n + 1}`, kind: 'gap',
        title: `Timestamp gap of ${formatSpan(g.ms)}`,
        detail: `Between event ${g.a.idx + 1} (${describe(g.a)}) and event ${g.b.idx + 1} (${describe(g.b)}). From timestamps only: the source records no duration here, so this may include idle time.`,
        eventId: card(g.a).id,
        eventIds: [card(g.a).id, card(g.b).id],
      });
    });
  }

  // One of each kind first, so a noisy category cannot crowd out the others.
  for (let round = 0; round < 2 && out.notes.length < MAX_NOTES; round++) {
    for (const bucket of [errorNotes, repeatNotes, gapNotes]) {
      if (bucket[round] && out.notes.length < MAX_NOTES) out.notes.push(bucket[round]);
    }
  }
  return out;
}

/** The pieces a search-index entry was built from, in original casing and in the same order. */
function segments(a: Analysis, e: TraceEvent): string[] {
  const name = e.name ? e.name + '\n' : '';
  if (e.kind === 'tool_call') {
    const segs = [name, valueText(e.input)];
    for (const r of (e.callId !== undefined ? a.results.get(e.callId) : undefined) ?? []) {
      segs.push('\n', r.name ? r.name + '\n' : '', valueText(r.output));
    }
    return segs;
  }
  if (e.kind === 'tool_result') return [name, valueText(e.output)];
  return [name, e.text ?? (e.kind === 'unknown' ? valueText(e.raw).slice(0, 20_000) : '')];
}

/**
 * Preview text around the first search match of an event, in the source's ORIGINAL casing.
 * The search index is lowercased, so it must never be shown to the user directly.
 * `query` is the same lowercased string used against searchIndex. Returns undefined when
 * the event does not match. Cost is one indexOf plus a slice; large outputs are not copied.
 */
export function matchExcerpt(a: Analysis, e: TraceEvent, query: string, max = 210): string | undefined {
  const hay = a.searchIndex.get(e.id);
  if (!hay || !query) return undefined;
  const at = hay.indexOf(query);
  if (at < 0) return undefined;
  const segs = segments(a, e);
  let total = 0;
  for (const s of segs) total += s.length;
  if (total === hay.length) {
    // Offsets line up with the original text: walk to the piece that holds the match.
    let off = at;
    for (const s of segs) {
      if (off < s.length) return excerptAround(s, off, max);
      off -= s.length;
    }
  }
  // A character changed length when lowercased: search each piece with a proper offset map.
  for (const s of segs) {
    const i = firstMatch(fold(s), query);
    if (i >= 0) return excerptAround(s, i, max);
  }
  return undefined;
}

/**
 * True when the stretch starting at `i` begins a human turn: a user message appears before the
 * agent does anything. Gaps that end this way are the person being away, not the run.
 */
function humanTurnStartsAt(events: TraceEvent[], i: number): boolean {
  for (let k = i; k < events.length && k < i + 8; k++) {
    const e = events[k];
    if (e.actor === 'user' && e.kind === 'message') return true;
    if (e.actor === 'assistant' || e.actor === 'tool') return false;
  }
  return false;
}

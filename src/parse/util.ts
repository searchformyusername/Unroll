import type {
  Actor, Diag, EventKind, ParseErrorCode, ParseResult, SessionMeta, TraceEvent, Usage,
} from './types.ts';

export type Rec = Record<string, unknown>;

/** One parsed JSONL record, with its 1-based source line when known. */
export interface LineRec {
  line?: number;
  v: Rec;
}

export class ParseError extends Error {
  code: ParseErrorCode;
  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

export const isObj = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** String or number as a string id. */
export const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? (v.length ? v : undefined) : typeof v === 'number' ? String(v) : undefined;

export function toIso(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v < 1e12 ? v * 1000 : v); // seconds vs milliseconds
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** JSON-string tool arguments become objects; anything else is returned untouched. */
export function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const c = v.charCodeAt(0);
  if (c !== 123 && c !== 91) return v; // not '{' or '['
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const TEXT_PART = new Set(['text', 'input_text', 'output_text', 'summary_text', 'reasoning_text']);

/** Readable text of one content part, or undefined if the part is not text-like. */
export function partText(p: unknown): string | undefined {
  if (typeof p === 'string') return p;
  if (!isObj(p)) return undefined;
  const t = p.type;
  if (typeof t !== 'string') return typeof p.text === 'string' ? p.text : undefined;
  if (TEXT_PART.has(t)) return typeof p.text === 'string' ? p.text : '';
  if (t === 'refusal') return str(p.refusal) ?? '';
  if (t === 'image' || t === 'image_url' || t === 'input_image') return '[image]';
  if (t === 'document' || t === 'file' || t === 'input_file') return '[file]';
  return undefined;
}

/** Flatten message content (string | part[] | part) into readable text. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const p of content) {
      const t = partText(p);
      if (t) out = out ? out + '\n\n' + t : t;
    }
    return out;
  }
  return partText(content) ?? '';
}

/** Tool output: a string when every part is text, otherwise the source value untouched. */
export function toolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let out = '';
  for (const p of content) {
    if (typeof p === 'string') {
      out = out ? out + '\n' + p : p;
      continue;
    }
    if (!isObj(p) || typeof p.type !== 'string' || !TEXT_PART.has(p.type) || typeof p.text !== 'string') {
      return content;
    }
    out = out ? out + '\n' + p.text : p.text;
  }
  return out;
}

/** Normalize any provider's usage object. See Usage for the meaning of each field. */
export function usageFrom(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const out: Usage = {};
  const inDetails = isObj(u.input_tokens_details) ? u.input_tokens_details
    : isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
  const outDetails = isObj(u.output_tokens_details) ? u.output_tokens_details
    : isObj(u.completion_tokens_details) ? u.completion_tokens_details : undefined;

  const inTok = num(u.input_tokens);
  const addRead = num(u.cache_read_input_tokens);
  const addWrite = num(u.cache_creation_input_tokens);
  let input: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  if (addRead !== undefined || addWrite !== undefined) {
    // Anthropic: input_tokens excludes cache tokens, so add them back.
    input = (inTok ?? 0) + (addRead ?? 0) + (addWrite ?? 0);
    cacheRead = addRead;
    cacheWrite = addWrite;
  } else {
    input = inTok ?? num(u.prompt_tokens);
    cacheRead = num(u.cached_input_tokens) ?? num(u.cached_tokens) ?? num(inDetails?.cached_tokens);
    cacheWrite = num(u.cache_write_input_tokens);
  }
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  const reasoning = num(u.reasoning_output_tokens) ?? num(outDetails?.reasoning_tokens);
  const total = num(u.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const costUsd = num(u.cost_usd) ?? num(u.cost);

  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  if (reasoning !== undefined) out.reasoning = reasoning;
  if (total !== undefined) out.total = total;
  if (costUsd !== undefined) out.costUsd = costUsd;
  for (const _ in out) return out;
  return undefined;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function usageText(u: Usage): string {
  const parts: string[] = [];
  if (u.input !== undefined) parts.push(`${fmt(u.input)} in`);
  if (u.output !== undefined) parts.push(`${fmt(u.output)} out`);
  if (u.cacheRead) parts.push(`${fmt(u.cacheRead)} cached`);
  if (u.reasoning) parts.push(`${fmt(u.reasoning)} reasoning`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}

const MS_KEYS = ['duration_ms', 'durationMs', 'latency_ms', 'elapsed_ms', 'wall_time_ms'];
const SEC_KEYS = ['duration_seconds', 'duration_sec', 'duration_s', 'wall_time_seconds'];
const TTFT_MS_KEYS = ['time_to_first_token_ms', 'ttft_ms', 'ttftMs', 'first_token_ms'];
const TTFT_SEC_KEYS = ['time_to_first_token_seconds', 'time_to_first_token_s', 'ttft_seconds', 'ttft_s'];
const nonNeg = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export interface Timing { durationMs?: number; ttftMs?: number }

/**
 * Explicitly recorded timing fields, normalized to milliseconds. Only keys whose name states
 * the unit are read (…_ms / …Ms as milliseconds, …_seconds / …_s as seconds); anything
 * ambiguous is left alone.
 */
export function timingFrom(o: unknown, into: Timing = {}): Timing {
  if (!isObj(o)) return into;
  if (into.durationMs === undefined) {
    for (const k of MS_KEYS) { const v = nonNeg(o[k]); if (v !== undefined) { into.durationMs = v; break; } }
  }
  if (into.durationMs === undefined) {
    for (const k of SEC_KEYS) { const v = nonNeg(o[k]); if (v !== undefined) { into.durationMs = Math.round(v * 1000); break; } }
  }
  if (into.ttftMs === undefined) {
    for (const k of TTFT_MS_KEYS) { const v = nonNeg(o[k]); if (v !== undefined) { into.ttftMs = v; break; } }
  }
  if (into.ttftMs === undefined) {
    for (const k of TTFT_SEC_KEYS) { const v = nonNeg(o[k]); if (v !== undefined) { into.ttftMs = Math.round(v * 1000); break; } }
  }
  return into;
}

/** Compact duration for marker text: 850ms, 4.2s, 3m 5s, 2h 4m. */
export function spanText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

export function timingText(t: Timing): string {
  const parts: string[] = [];
  if (t.durationMs !== undefined) parts.push(`took ${spanText(t.durationMs)}`);
  if (t.ttftMs !== undefined) parts.push(`first token after ${spanText(t.ttftMs)}`);
  return parts.join(' · ');
}

export interface NewEvent {
  id: string;
  actor: Actor;
  kind: EventKind;
  ts?: string;
  text?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  raw?: unknown;
  step?: number;
  usage?: Usage;
  durationMs?: number;
  ttftMs?: number;
  responseId?: string;
}

const MAX_DIAGS = 200;

/** Accumulates events + diagnostics and guarantees unique ids and dense idx. */
export class Builder {
  events: TraceEvent[] = [];
  diagnostics: Diag[] = [];
  private ids = new Set<string>();
  private dropped = 0;

  push(e: NewEvent): TraceEvent {
    let id = e.id;
    if (this.ids.has(id)) {
      let n = 2;
      while (this.ids.has(`${e.id}~${n}`)) n++;
      id = `${e.id}~${n}`;
    }
    this.ids.add(id);
    const ev: TraceEvent = { idx: this.events.length, id, actor: e.actor, kind: e.kind };
    if (e.ts !== undefined) ev.ts = e.ts;
    if (e.text !== undefined) ev.text = e.text;
    if (e.callId !== undefined) ev.callId = e.callId;
    if (e.name !== undefined) ev.name = e.name;
    if (e.input !== undefined) ev.input = e.input;
    if (e.output !== undefined) ev.output = e.output;
    if (e.isError !== undefined) ev.isError = e.isError;
    if (e.raw !== undefined) ev.raw = e.raw;
    if (e.step !== undefined) ev.step = e.step;
    if (e.usage !== undefined) ev.usage = e.usage;
    if (e.durationMs !== undefined) ev.durationMs = e.durationMs;
    if (e.ttftMs !== undefined) ev.ttftMs = e.ttftMs;
    if (e.responseId !== undefined) ev.responseId = e.responseId;
    this.events.push(ev);
    return ev;
  }

  diag(reason: string, line?: number): void {
    if (this.diagnostics.length >= MAX_DIAGS) {
      this.dropped++;
      return;
    }
    this.diagnostics.push(line === undefined ? { reason } : { line, reason });
  }

  /**
   * Make callId a reliable join key. Some agents reuse ids ("call_1" every step);
   * later reuses are renamed `id#2`, `id#3`… and each result follows its own call
   * (first unanswered call with that id, else the most recent one).
   */
  private linkCalls(): void {
    const pending = new Map<string, TraceEvent[]>();
    const latest = new Map<string, TraceEvent>();
    const seen = new Map<string, number>();
    let renamed = 0;
    let orphans = 0;
    for (const e of this.events) {
      const id = e.callId;
      if (id === undefined) continue;
      if (e.kind === 'tool_call') {
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n > 1) {
          e.callId = `${id}#${n}`;
          renamed++;
        }
        latest.set(id, e);
        const q = pending.get(id);
        if (q) q.push(e);
        else pending.set(id, [e]);
      } else if (e.kind === 'tool_result') {
        const call = pending.get(id)?.shift() ?? latest.get(id);
        if (!call) {
          orphans++;
          continue;
        }
        e.callId = call.callId;
        if (e.name === undefined && call.name !== undefined) e.name = call.name;
      }
    }
    if (renamed) this.diag(`${renamed} tool call id(s) were reused by the source; later uses were renamed (id#2, id#3…) so calls and results pair correctly.`);
    if (orphans) this.diag(`${orphans} tool result(s) reference a tool call that is not in this file.`);
  }

  finish(format: string, id: string | undefined, meta: SessionMeta): ParseResult {
    if (this.events.length === 0) {
      throw new ParseError('no_events', `This file was recognized as ${format}, but it contains no conversation events to show. It may be empty, metadata-only, or cut off before the first message.`);
    }
    this.linkCalls();
    let min = Infinity;
    let max = -Infinity;
    let minS: string | undefined;
    let maxS: string | undefined;
    for (const e of this.events) {
      if (e.ts === undefined) continue;
      const t = Date.parse(e.ts);
      if (Number.isNaN(t)) continue;
      if (t < min) { min = t; minS = e.ts; }
      if (t > max) { max = t; maxS = e.ts; }
    }
    if (minS !== undefined && meta.startedAt === undefined) meta.startedAt = minS;
    if (maxS !== undefined && meta.endedAt === undefined) meta.endedAt = maxS;
    if (this.dropped) this.diagnostics.push({ reason: `${this.dropped} more diagnostics were omitted.` });
    return {
      format,
      session: { id: id ?? 'session', format, meta, events: this.events },
      diagnostics: this.diagnostics,
    };
  }
}

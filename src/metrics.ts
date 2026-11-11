import type { Session, TraceEvent, Usage } from './parse/types.ts';

/**
 * Timing and usage numbers. Every field is in MILLISECONDS and is either a timestamp
 * difference or a value the source recorded. The two are never mixed:
 *
 *  startMs    Unix epoch ms of the first timestamp.                      [timestamp]
 *  elapsedMs  startMs minus the session's first timestamp.              [timestamp]
 *  nextGapMs  Next main-thread step's startMs minus this step's startMs. [timestamp]
 *             It covers everything between the two steps (model time, tools, idle time)
 *             and is NOT a tool or model duration.
 *  durationMs A duration the source recorded for exactly this item.     [recorded]
 *  ttftMs     Time to first token the source recorded.                  [recorded]
 *  usage      Token usage the source recorded.                          [recorded]
 */
export interface EventMetrics {
  startMs?: number;
  elapsedMs?: number;
  nextGapMs?: number;
  durationMs?: number;
  ttftMs?: number;
  usage?: Usage;
  /** Key of the step this event belongs to (StepTiming.key). Absent for abandoned-branch events. */
  stepKey?: string;
}

/**
 * How a step's events were grouped:
 *  'step'     the source's own step / message number (ATIF step_id, chat message index)
 *  'response' one model response id plus the results of its tool calls (Claude Code)
 *  'request'  one Codex model request: output items and tool results up to the usage record that closes it
 *  'event'    a single event (user turns, markers, anything with no reliable group)
 */
export type Grouping = 'step' | 'response' | 'request' | 'event';

export interface StepTiming extends EventMetrics {
  key: string;
  label: string;
  /** Event to jump to: the first visible card of the step. */
  eventId: string;
  grouping: Grouping;
  eventCount: number;
}

export interface Metrics {
  /** Steps on the active path, in order. Abandoned branches (offPath) are left out. */
  steps: StepTiming[];
  /** Metrics for every event, keyed by event id. */
  byEvent: Map<string, EventMetrics>;
  /** Last recorded timestamp minus the first. A timestamp span, not active time. */
  durationMs?: number;
  /** Every time-to-first-token the source recorded, in order. */
  ttftMs?: number[];
  /** Sum of turn durations the source recorded itself (Codex task_complete, Claude Code turn_duration). */
  recordedDurationMs?: number;
  /** Largest nextGapMs across steps, for scaling bars without spreading a large array. */
  maxNextGapMs?: number;
  /** Largest step durationMs across steps. */
  maxDurationMs?: number;
}

interface Group {
  key: string;
  grouping: Grouping;
  events: TraceEvent[];
  side: boolean;
  start: number; // epoch ms, NaN when the step has no timestamp
}

const TURN_MARKERS = new Set(['task_complete', 'turn_complete', 'turn_aborted', 'turn_duration']);

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  const out: Usage = { ...a };
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'costUsd'] as const) {
    const v = b[k];
    if (v !== undefined) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function eventLabel(e: TraceEvent): string {
  switch (e.kind) {
    case 'tool_call': return `${e.name ?? 'Tool'} call`;
    case 'tool_result': return `${e.name ?? 'Tool'} result`;
    case 'thinking': return 'Reasoning';
    case 'usage': return 'Token usage';
    case 'meta': return e.name ? cap(e.name.replace(/[_-]+/g, ' ')) : 'Marker';
    case 'message': return e.actor === 'system' && e.name ? e.name : `${cap(e.actor)} message`;
    default: return 'Unrecognized event';
  }
}

/**
 * Per-step and per-event timing for a parsed session. Single pass, no inference:
 * durations and TTFT appear only where the source recorded them, and timestamp
 * differences are only ever reported as startMs / elapsedMs / nextGapMs.
 */
export function buildMetrics(session: Session): Metrics {
  const events = session.events;
  const n = events.length;
  const codex = session.format === 'codex';
  const stepWord = session.format === 'chat' ? 'Message' : 'Step';

  // ---- timestamps, parsed once
  const ts = new Float64Array(n);
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = events[i].ts;
    const t = s === undefined ? NaN : Date.parse(s);
    ts[i] = t;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const hasTime = first !== Infinity;

  // ---- group events into steps
  const groups = new Map<string, Group>();
  const groupOf: (Group | undefined)[] = new Array(n);
  const callGroup = new Map<string, Group>();
  const callEvent = new Map<string, TraceEvent>();
  const results = new Map<string, TraceEvent[]>();
  let request = 1;
  let requestOpen = false;

  for (let i = 0; i < n; i++) {
    const e = events[i];
    if (e.callId !== undefined) {
      if (e.kind === 'tool_call') callEvent.set(e.callId, e);
      else if (e.kind === 'tool_result') {
        const list = results.get(e.callId);
        if (list) list.push(e);
        else results.set(e.callId, [e]);
      }
    }
    if (e.offPath) continue;

    let key: string;
    let grouping: Grouping;
    const viaCall = e.kind === 'tool_result' && e.callId !== undefined ? callGroup.get(e.callId) : undefined;
    if (e.step !== undefined) {
      key = `s:${e.step}`;
      grouping = 'step';
    } else if (e.responseId !== undefined) {
      key = `r:${e.responseId}`;
      grouping = 'response';
    } else if (viaCall) {
      key = viaCall.key;
      grouping = viaCall.grouping;
    } else if (codex && (e.actor === 'assistant' || e.actor === 'tool' || e.kind === 'usage')) {
      key = `q:${request}`;
      grouping = 'request';
      requestOpen = true;
    } else {
      key = `e:${e.id}`;
      grouping = 'event';
    }
    if (codex) {
      // A usage record closes the request it follows. A new human turn or a turn marker also
      // closes it, so output from different turns can never merge into one step.
      const closes = e.kind === 'usage' && grouping === 'request'
        || requestOpen && grouping === 'event' && ((e.actor === 'user' && e.kind === 'message') || (e.kind === 'meta' && TURN_MARKERS.has(e.name ?? '')));
      if (closes) {
        request++;
        requestOpen = false;
      }
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, grouping, events: [], side: e.sidechain === true, start: NaN };
      groups.set(key, g);
    }
    g.events.push(e);
    if (Number.isNaN(g.start) && !Number.isNaN(ts[i])) g.start = ts[i];
    groupOf[i] = g;
    if (e.kind === 'tool_call' && e.callId !== undefined) callGroup.set(e.callId, g);
  }

  // ---- steps
  const steps: StepTiming[] = [];
  const stepOf = new Map<Group, StepTiming>();
  let responses = 0;
  let requests = 0;
  let prevMain: StepTiming | undefined;
  let maxGap: number | undefined;
  let maxDuration: number | undefined;

  for (const g of groups.values()) {
    const ev = g.events;
    let anchor: TraceEvent | undefined;
    let usage: Usage | undefined;
    let scoped: TraceEvent | undefined; // a step-level record that carries recorded timing
    for (const e of ev) {
      if (e.usage) usage = addUsage(usage, e.usage);
      if (e.kind === 'usage') {
        if (e.durationMs !== undefined || e.ttftMs !== undefined) scoped = e;
        continue;
      }
      if (!anchor && !(e.kind === 'tool_result' && e.callId !== undefined && callEvent.has(e.callId))) anchor = e;
    }
    anchor ??= ev[0];
    const label = g.grouping === 'step' ? `${stepWord} ${ev[0].step}`
      : g.grouping === 'response' ? `Response ${++responses}`
      : g.grouping === 'request' ? `Request ${++requests}`
      : eventLabel(ev[0]);
    const step: StepTiming = { key: g.key, label, eventId: anchor.id, grouping: g.grouping, eventCount: ev.length };
    if (!Number.isNaN(g.start)) {
      step.startMs = g.start;
      step.elapsedMs = g.start - first;
    }
    // A step gets a duration or TTFT only from a record scoped to the whole step, or when the step IS
    // a single event. One event's duration never stands in for a multi-event step, and durations of
    // several events (parallel tools, reasoning plus tools) are never added up.
    const source = scoped ?? (g.grouping === 'event' && ev.length === 1 ? ev[0] : undefined);
    if (source?.durationMs !== undefined) {
      step.durationMs = source.durationMs;
      if (maxDuration === undefined || source.durationMs > maxDuration) maxDuration = source.durationMs;
    }
    if (source?.ttftMs !== undefined) step.ttftMs = source.ttftMs;
    if (usage) step.usage = usage;

    if (!g.side && step.startMs !== undefined) {
      if (prevMain && step.startMs >= prevMain.startMs!) {
        prevMain.nextGapMs = step.startMs - prevMain.startMs!;
        if (maxGap === undefined || prevMain.nextGapMs > maxGap) maxGap = prevMain.nextGapMs;
      }
      prevMain = step;
    }
    steps.push(step);
    stepOf.set(g, step);
  }

  // ---- per-event view
  const byEvent = new Map<string, EventMetrics>();
  const ttft: number[] = [];
  let recorded: number | undefined;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    const g = groupOf[i];
    const step = g ? stepOf.get(g) : undefined;
    const m: EventMetrics = {};
    if (step) m.stepKey = step.key;
    if (!Number.isNaN(ts[i])) {
      m.startMs = ts[i];
      m.elapsedMs = ts[i] - first;
    }
    if (step?.nextGapMs !== undefined) m.nextGapMs = step.nextGapMs;
    if (e.durationMs !== undefined) m.durationMs = e.durationMs;
    else if (e.kind === 'tool_call' && e.callId !== undefined) {
      // A call shows the run time its own (single) result recorded.
      const list = results.get(e.callId);
      if (list?.length === 1 && list[0].durationMs !== undefined) m.durationMs = list[0].durationMs;
    }
    const t = e.ttftMs ?? step?.ttftMs;
    if (t !== undefined) m.ttftMs = t;
    const u = e.usage ?? step?.usage;
    if (u) m.usage = u;
    byEvent.set(e.id, m);

    if (e.ttftMs !== undefined) ttft.push(e.ttftMs);
    if (e.kind === 'meta' && e.durationMs !== undefined && TURN_MARKERS.has(e.name ?? '')) recorded = (recorded ?? 0) + e.durationMs;
  }

  const out: Metrics = { steps, byEvent };
  if (hasTime) out.durationMs = last - first;
  if (ttft.length) out.ttftMs = ttft;
  if (recorded !== undefined) out.recordedDurationMs = recorded;
  if (maxGap !== undefined) out.maxNextGapMs = maxGap;
  if (maxDuration !== undefined) out.maxDurationMs = maxDuration;
  return out;
}

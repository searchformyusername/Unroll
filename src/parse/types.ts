/**
 * Unroll parser contract. Everything returned by parse() is plain JSON-like data:
 * structured-clone-safe (no Maps, Sets, class instances, functions).
 */

export type Actor = "user" | "assistant" | "tool" | "system";

export type EventKind =
  | "message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "meta"
  | "unknown";

/**
 * Token usage, normalized across providers.
 * `input` is ALL prompt tokens for the request, including cached ones.
 * `cacheRead` and `cacheWrite` are subsets of `input`, never added on top.
 */
export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning tokens. A subset of `output`, never added on top. */
  reasoning?: number;
  total?: number;
  /** Cost in US dollars, only when the source recorded one. Never computed from token counts. */
  costUsd?: number;
}

/**
 * An evaluation result the source states in a structured, explicitly named field
 * (`reward` or `score`) at a known location. Never read from message text or tool output.
 */
export interface EvaluationMetric {
  /** The field name exactly as written in the source. */
  label: string;
  value: number | boolean;
  /** JSON path of the field, e.g. "$.final_metrics.reward". */
  source: string;
}

export interface TraceEvent {
  /** Position in session.events (0-based, dense). */
  idx: number;
  /** Unique within the session. */
  id: string;
  /** ISO-8601 timestamp when the source has one. */
  ts?: string;
  actor: Actor;
  kind: EventKind;
  /** Readable content for message / thinking / meta events. */
  text?: string;
  /** Joins a tool_call to its tool_result(s). Unique per call within the session. */
  callId?: string;
  /** Tool name (tool_call, and tool_result when known) or a subtype label for meta. */
  name?: string;
  /** tool_call arguments. JSON-string arguments are parsed when valid. */
  input?: unknown;
  /** tool_result payload: a string when the source is text, otherwise the source value. */
  output?: unknown;
  isError?: boolean;
  /**
   * Source record this event came from. Sibling events may share one object by
   * reference, so store a session as a single value and stringify lazily.
   */
  raw?: unknown;
  /** Previous event in the source's own chain (Claude Code tree). Absent for linear formats. */
  parentId?: string;

  // Additive fields beyond the minimal UI contract. All optional.
  /** Source step / message ordinal, for formats that group events (ATIF step_id, chat message #). */
  step?: number;
  /** Present on kind === 'usage'. */
  usage?: Usage;
  /** True when the event sits on an abandoned branch (rewind / retry), not the active path. */
  offPath?: boolean;
  /** True for sub-agent (sidechain) events interleaved in the same file. */
  sidechain?: boolean;
  /**
   * Duration in milliseconds that the SOURCE recorded for this event: an explicit duration
   * field, a recorded start/end pair for this exact item, or the harness's wall-time header on
   * a tool output. Never derived from the gap between neighbouring timestamps.
   */
  durationMs?: number;
  /** Time to first token in milliseconds, only when the source recorded it. */
  ttftMs?: number;
  /** Provider response id shared by every event of one model response (Claude Code message.id). */
  responseId?: string;
}

/** Name required by the UI contract. Prefer TraceEvent in new code to avoid the DOM `Event` global. */
export type Event = TraceEvent;

export interface Diag {
  /** 1-based line number for JSONL sources. */
  line?: number;
  reason: string;
}

export interface SessionMeta {
  model?: string;
  startedAt?: string;
  endedAt?: string;
  /** Session totals the source reports itself (ATIF final_metrics). */
  totalUsage?: Usage;
  evaluationMetrics?: EvaluationMetric[];
  [key: string]: unknown;
}

export interface Session {
  id: string;
  format: string;
  meta: SessionMeta;
  events: TraceEvent[];
}

export interface ParseResult {
  format: string;
  session: Session;
  diagnostics: Diag[];
}

export type ParseErrorCode =
  | "empty"
  | "not_json"
  | "unknown_format"
  | "no_events";

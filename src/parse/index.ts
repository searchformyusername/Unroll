import type { ParseResult } from "./types.ts";
import { parseAtif } from "./atif.ts";
import { parseChat } from "./chat.ts";
import { parseClaudeCode } from "./claudeCode.ts";
import { parseCodex } from "./codex.ts";
import { ITEM_TYPE } from "./items.ts";
import { Builder, isObj, ParseError, type LineRec, type Rec } from "./util.ts";

export type {
  Actor,
  Diag,
  EvaluationMetric,
  Event,
  EventKind,
  ParseErrorCode,
  ParseResult,
  Session,
  SessionMeta,
  TraceEvent,
  Usage,
} from "./types.ts";
export { ParseError } from "./util.ts";

/** Human labels for ParseResult.format. */
export const FORMAT_LABELS: Record<string, string> = {
  atif: "ATIF trajectory",
  chat: "Chat transcript",
  "claude-code": "Claude Code session",
  codex: "Codex rollout",
};

const SUPPORTED =
  'Supported: ATIF trajectories (.json with a "steps" array), chat transcripts (OpenAI or Anthropic style "messages"), Claude Code session logs (.jsonl) and Codex rollouts (.jsonl).';

type Kind = "claude-code" | "codex" | "chat";
const CODEX_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
]);
const WRAPPER_KEYS = [
  "messages",
  "conversation",
  "conversations",
  "history",
  "chat",
  "input",
  "items",
  "turns",
  "dialogue",
  "dialog",
];

/** Decide the record family from structure alone (first 200 records). File names are never trusted. */
function sniff(values: unknown[]): Kind | undefined {
  let cc = 0;
  let cx = 0;
  let chat = 0;
  const n = Math.min(values.length, 200);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!isObj(v)) continue;
    const t = v.type;
    if (typeof t === "string" && CODEX_TYPES.has(t) && isObj(v.payload))
      cx += 2;
    else if (
      "parentUuid" in v ||
      (typeof v.uuid === "string" && typeof v.sessionId === "string")
    )
      cc += 2;
    else if (typeof v.sessionId === "string" && typeof t === "string") cc += 1;
    else if (
      typeof v.role === "string" ||
      (typeof v.from === "string" && "value" in v) ||
      (typeof t === "string" && ITEM_TYPE.test(t))
    )
      chat += 2;
  }
  if (cc === 0 && cx === 0 && chat === 0) return undefined;
  return cc >= cx && cc >= chat ? "claude-code" : cx >= chat ? "codex" : "chat";
}

function route(
  kind: Kind,
  recs: LineRec[],
  b: Builder,
  wrapper?: Rec,
): ParseResult {
  if (kind === "claude-code") return parseClaudeCode(recs, b);
  if (kind === "codex") return parseCodex(recs, b);
  return parseChat(recs, b, wrapper);
}

function toRecs(values: unknown[], b: Builder): LineRec[] {
  const recs: LineRec[] = [];
  let bad = 0;
  for (const v of values) {
    if (isObj(v)) recs.push({ v });
    else bad++;
  }
  if (bad)
    b.diag(
      `${bad} array entr${bad === 1 ? "y is" : "ies are"} not objects and were skipped.`,
    );
  return recs;
}

const keyList = (o: Rec): string => {
  const keys = Object.keys(o);
  return (
    keys.slice(0, 12).join(", ") + (keys.length > 12 ? ", …" : "") || "(none)"
  );
};

function looksAtif(doc: Rec): doc is Rec & { steps: unknown[] } {
  if (!Array.isArray(doc.steps)) return false;
  if (
    typeof doc.schema_version === "string" &&
    /^atif/i.test(doc.schema_version)
  )
    return true;
  for (let i = 0; i < doc.steps.length && i < 5; i++) {
    const s = doc.steps[i];
    if (isObj(s) && "source" in s && ("step_id" in s || "message" in s))
      return true;
  }
  return false;
}

function fromDocument(doc: unknown): ParseResult {
  const b = new Builder();
  if (Array.isArray(doc)) {
    if (doc.length === 0)
      throw new ParseError(
        "empty",
        "This file is an empty JSON array, so there is nothing to show.",
      );
    const kind = sniff(doc);
    if (kind) return route(kind, toRecs(doc, b), b);
    const first = doc.find(isObj);
    if (
      first &&
      "source" in first &&
      ("step_id" in first || "message" in first)
    )
      return parseAtif({}, doc, b);
    throw new ParseError(
      "unknown_format",
      `This JSON array is not a trajectory format Unroll recognizes. ${SUPPORTED} ${first ? `The first entry has keys: ${keyList(first)}.` : "Its entries are not objects."}`,
    );
  }
  if (!isObj(doc)) {
    throw new ParseError(
      "unknown_format",
      `This file holds a single JSON ${doc === null ? "null" : typeof doc}, not a trajectory. ${SUPPORTED}`,
    );
  }
  if (looksAtif(doc)) return parseAtif(doc, doc.steps, b);
  for (const key of WRAPPER_KEYS) {
    const arr = doc[key];
    if (Array.isArray(arr) && arr.length && sniff(arr) === "chat")
      return parseChat(toRecs(arr, b), b, doc);
  }
  const single = sniff([doc]); // a one-line JSONL file parses as a single document
  if (single) return route(single, [{ line: 1, v: doc }], b);
  if (Array.isArray(doc.steps) && doc.steps.length === 0) {
    throw new ParseError(
      "empty",
      'This trajectory has an empty "steps" array, so there is nothing to show.',
    );
  }
  throw new ParseError(
    "unknown_format",
    `This JSON object is not a trajectory format Unroll recognizes. ${SUPPORTED} Top-level keys found: ${keyList(doc)}.`,
  );
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

function fromLines(input: string, docError: string | undefined): ParseResult {
  const b = new Builder();
  const recs: LineRec[] = [];
  const len = input.length;
  let pos = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 0;
  let bad = 0;
  let scalars = 0;
  while (pos < len) {
    let nl = input.indexOf("\n", pos);
    if (nl === -1) nl = len;
    line++;
    let a = pos;
    let z = nl;
    while (a < z && isWs(input.charCodeAt(a))) a++;
    while (z > a && isWs(input.charCodeAt(z - 1))) z--;
    pos = nl + 1;
    if (a === z) continue;
    let v: unknown;
    try {
      v = JSON.parse(input.slice(a, z));
    } catch {
      bad++;
      if (recs.length === 0 && bad >= 20) break; // not JSONL at all; stop before reading megabytes of prose
      b.diag(
        nl >= len
          ? "Last line is cut off or not valid JSON (the session may still be writing); skipped."
          : "Line is not valid JSON; skipped.",
        line,
      );
      continue;
    }
    if (isObj(v)) recs.push({ line, v });
    else {
      scalars++;
      b.diag("Line is valid JSON but not an object; skipped.", line);
    }
  }
  if (recs.length === 0 && scalars) {
    throw new ParseError(
      "unknown_format",
      `This file is valid JSON but holds plain values rather than trajectory records. ${SUPPORTED}`,
    );
  }
  if (recs.length === 0) {
    throw new ParseError(
      "not_json",
      docError
        ? `This file looks like JSON but could not be read: ${docError}. It may be truncated or hand-edited. Re-export it, or check it with a JSON validator.`
        : `This file is not JSON or JSONL, so it cannot be read as a trajectory. ${SUPPORTED}`,
    );
  }
  const values = new Array<unknown>(Math.min(recs.length, 200));
  for (let i = 0; i < values.length; i++) values[i] = recs[i].v;
  const kind = sniff(values);
  if (!kind) {
    throw new ParseError(
      "unknown_format",
      `This JSONL file is not a trajectory format Unroll recognizes. ${SUPPORTED} The first record has keys: ${keyList(recs[0].v)}.`,
    );
  }
  return route(kind, recs, b);
}

/**
 * Parse a trajectory file's text into a normalized session.
 * Synchronous and dependency-free; run it in a worker for large inputs.
 * Throws ParseError (with an actionable message) when the input cannot be shown at all;
 * recoverable problems are reported in `diagnostics` instead.
 */
export function parse(input: string): ParseResult {
  if (typeof input !== "string")
    throw new ParseError(
      "empty",
      "Nothing to parse: expected the file contents as text.",
    );
  let start = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < input.length && isWs(input.charCodeAt(start))) start++;
  if (start >= input.length)
    throw new ParseError(
      "empty",
      "This file is empty, so there is nothing to show.",
    );
  const first = input.charCodeAt(start);
  let docError: string | undefined;
  if (first === 123 || first === 91) {
    // '{' or '['
    let doc: unknown;
    let ok = false;
    try {
      doc = JSON.parse(start ? input.slice(start) : input);
      ok = true;
    } catch (e) {
      docError = e instanceof Error ? e.message : String(e); // JSONL fails here right after its first record, so this is cheap
    }
    if (ok) return fromDocument(doc);
  }
  return fromLines(input, docError);
}

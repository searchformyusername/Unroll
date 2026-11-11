import type { ParseResult, SessionMeta } from './types.ts';
import { emitItem } from './items.ts';
import {
  Builder, contentText, idOf, isObj, num, str, timingText, toIso, usageFrom, usageText,
  type LineRec, type Rec,
} from './util.ts';

/** event_msg types worth surfacing as markers on the timeline. */
const MARKERS = new Set(['turn_aborted', 'error', 'stream_error', 'context_compacted', 'thread_rolled_back']);
/** event_msg duplicates of response_item content; only used when a file has no response_items. */
const LEGACY_MSG: Record<string, { actor: 'user' | 'assistant'; kind: 'message' | 'thinking' }> = {
  user_message: { actor: 'user', kind: 'message' },
  agent_message: { actor: 'assistant', kind: 'message' },
  agent_reasoning: { actor: 'assistant', kind: 'thinking' },
};

/** Codex CLI rollout: {timestamp, type, payload} per line. response_item is the source of truth. */
export function parseCodex(recs: LineRec[], b: Builder): ParseResult {
  const meta: SessionMeta = {};
  let sessionId: string | undefined;
  let hasItems = false;
  let hasTokenCount = false;
  /** item id (or call_id) → duration from the item's own recorded start/end pair. */
  const itemMs = new Map<string, number>();
  for (const r of recs) {
    const p = r.v.payload;
    if (r.v.type === 'response_item') hasItems = true;
    else if (r.v.type === 'event_msg' && isObj(p)) {
      if (p.type === 'token_count') hasTokenCount = true;
      else if (p.type === 'item_completed' && isObj(p.item)) {
        const id = idOf(p.item.id);
        const a = num(p.started_at_ms);
        const z = num(p.completed_at_ms);
        if (id !== undefined && a !== undefined && z !== undefined && z >= a) itemMs.set(id, z - a);
      }
    }
  }
  let hidden = 0;
  let hiddenMs = 0;
  let turns = 0;
  let lastTotal: number | undefined;
  const skipped: Record<string, number> = {};
  const skip = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };

  const pushUsage = (u: unknown, total: unknown, id: string, ts: string | undefined, raw: unknown) => {
    const usage = usageFrom(u);
    if (!usage) return;
    // token_count repeats until the next response; a changed running total marks a new request.
    const running = isObj(total) ? num(total.total_tokens) : undefined;
    if (running !== undefined) {
      if (running === lastTotal) return;
      lastTotal = running;
    }
    b.push({ id, actor: 'system', kind: 'usage', ts, text: usageText(usage), usage, raw });
  };

  for (const r of recs) {
    const v = r.v;
    const p: Rec = isObj(v.payload) ? v.payload : {};
    const ts = toIso(v.timestamp);
    const id = `L${r.line ?? b.events.length + 1}`;
    switch (v.type) {
      case 'session_meta': {
        sessionId ??= idOf(p.id) ?? idOf(p.session_id);
        if (str(p.cwd)) meta.cwd = p.cwd;
        if (str(p.cli_version)) meta.cliVersion = p.cli_version;
        if (str(p.model_provider)) meta.provider = p.model_provider;
        if (str(p.originator)) meta.originator = p.originator;
        if (isObj(p.git) && str(p.git.branch)) meta.gitBranch = p.git.branch;
        if (str(p.timestamp)) meta.startedAt = str(p.timestamp);
        break;
      }
      case 'turn_context': {
        const model = str(p.model);
        if (model && !meta.model) meta.model = model;
        else if (model && model !== meta.model) {
          b.push({ id, actor: 'system', kind: 'meta', ts, name: 'model_changed', text: `Model changed to ${model}`, raw: { model } });
          meta.model = model;
        }
        if (str(p.effort) && !meta.effort) meta.effort = p.effort;
        break;
      }
      case 'response_item': {
        const before = b.events.length;
        const res = emitItem(b, p, { id: idOf(p.id) ?? id, ts, raw: p });
        const own = idOf(p.id);
        if (res === 'hidden') {
          hidden++;
          if (own !== undefined) hiddenMs += itemMs.get(own) ?? 0;
        } else if (res === false) {
          skip(`response_item:${str(p.type) ?? '?'}`);
        } else if (b.events.length === before + 1) {
          // Attach the item's recorded start/end duration: by item id for model output,
          // by call_id for a tool result (the item describes the tool execution).
          const ev = b.events[before];
          const key = ev.kind === 'tool_result' ? idOf(p.call_id) : ev.kind === 'tool_call' ? undefined : own;
          const d = key !== undefined ? itemMs.get(key) : undefined;
          if (d !== undefined && ev.durationMs === undefined) ev.durationMs = d;
        }
        break;
      }
      case 'event_msg': {
        const pt = str(p.type) ?? '?';
        if (pt === 'token_count') {
          if (isObj(p.info)) pushUsage(p.info.last_token_usage, p.info.total_token_usage, id, ts, p.info);
        } else if (MARKERS.has(pt)) {
          const text = str(p.message) ?? str(p.reason) ?? pt.replace(/_/g, ' ');
          b.push({ id, actor: 'system', kind: 'meta', ts, name: pt, text, isError: pt.includes('error') || pt === 'turn_aborted' ? true : undefined, raw: p, durationMs: num(p.duration_ms) });
        } else if (pt === 'task_complete' || pt === 'turn_complete') {
          turns++;
          // Turn-level numbers recorded by the CLI itself; kept on their own marker, tied to no other event.
          const timing = { durationMs: num(p.duration_ms), ttftMs: num(p.time_to_first_token_ms) };
          const detail = timingText(timing);
          b.push({
            id, actor: 'system', kind: 'meta', ts, name: 'task_complete',
            text: detail ? `Turn completed · ${detail}` : 'Turn completed',
            raw: p, durationMs: timing.durationMs, ttftMs: timing.ttftMs,
          });
        } else if (!hasItems && LEGACY_MSG[pt]) {
          const text = str(p.message) ?? str(p.text) ?? '';
          if (text.trim()) b.push({ id, ts, text, raw: p, ...LEGACY_MSG[pt] });
        } else {
          skip(`event_msg:${pt}`);
        }
        break;
      }
      case 'token_usage_record':
        if (hasTokenCount) skip('token_usage_record');
        else pushUsage(p.usage, p.thread_token_usage, id, ts, p);
        break;
      case 'compacted': {
        const text = contentText(p.message);
        b.push({ id, actor: 'system', kind: 'meta', ts, name: 'compacted', text: text.trim() ? text : 'Context compacted', raw: p });
        break;
      }
      default:
        skip(str(v.type) ?? '?');
    }
  }
  if (hidden) meta.hiddenReasoningCount = hidden;
  if (hiddenMs) meta.hiddenReasoningMs = hiddenMs;
  if (turns) meta.turnCount = turns;
  meta.skippedRecords = skipped;
  return b.finish('codex', sessionId, meta);
}

import type { Actor } from './types.ts';
import { Builder, contentText, idOf, isObj, num, parseArgs, str, timingFrom, toolOutput, type Rec } from './util.ts';

/** Item types of the OpenAI Responses API, also used as Codex `response_item` payloads. */
export const ITEM_TYPE = /^(message|reasoning|[a-z_]+_call|[a-z_]+_call_output)$/;

const ROLE: Record<string, Actor> = {
  user: 'user', human: 'user',
  assistant: 'assistant', model: 'assistant', ai: 'assistant', gpt: 'assistant', bot: 'assistant',
  system: 'system', developer: 'system',
  tool: 'tool', function: 'tool', ipython: 'tool', observation: 'tool',
};
export const actorOf = (role: string): Actor | undefined => ROLE[role.toLowerCase()];

/** Harness-injected context that arrives with role=user, e.g. <environment_context>…</environment_context>. */
const INJECTED = /^\s*<([a-z][a-z0-9]*[_-][a-z0-9_-]*)[^>]*>[\s\S]*<\/\1>\s*$/;
export function injectedTag(text: string): string | undefined {
  if (text.charCodeAt(0) !== 60 && !/^\s*</.test(text.slice(0, 16))) return undefined;
  return INJECTED.exec(text)?.[1];
}

interface Out { output: unknown; isError?: boolean; durationMs?: number }

/** Codex prefixes tool output with a status header that states the wall time in seconds. */
const WALL = /^(?:Script [a-z]+\n)?Wall time:? (\d+(?:\.\d+)?) seconds?\b/;
function headerMs(text: string): number | undefined {
  const c = text.charCodeAt(0);
  if (c !== 83 /* S */ && c !== 87 /* W */) return undefined;
  const m = WALL.exec(text.slice(0, 96));
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Harness-written status line at the top of a tool output. Only a clear failure is reported. */
function failedHeader(text: string): true | undefined {
  const c = text.charCodeAt(0);
  if (c === 69 /* E */) {
    const m = /^Exit code: (-?\d+)/.exec(text);
    return m && m[1] !== '0' ? true : undefined;
  }
  return c === 83 /* S */ && text.startsWith('Script failed') ? true : undefined;
}

/** Unwrap the tool-output envelopes different CLI versions use. */
function normalizeOutput(v: unknown): Out {
  if (typeof v === 'string') {
    if (v.charCodeAt(0) === 123) {
      try {
        const j: unknown = JSON.parse(v);
        if (isObj(j) && typeof j.output === 'string') {
          const code = isObj(j.metadata) ? num(j.metadata.exit_code) : undefined;
          return { output: j.output, isError: code === undefined ? undefined : code !== 0, durationMs: timingFrom(j.metadata).durationMs };
        }
      } catch { /* plain text that happens to start with "{" */ }
    }
    return { output: v, isError: failedHeader(v), durationMs: headerMs(v) };
  }
  if (isObj(v) && typeof v.content === 'string' && typeof v.success === 'boolean') {
    return { output: v.content, isError: !v.success };
  }
  if (isObj(v) && typeof v.output === 'string') return { output: v.output };
  const out = toolOutput(v);
  return typeof out === 'string' ? { output: out, isError: failedHeader(out), durationMs: headerMs(out) } : { output: out };
}

export interface ItemCtx { id: string; ts?: string; raw?: unknown; step?: number }

/**
 * Emit events for one Responses-style item. Returns:
 *  'ok'     → handled (may emit nothing, e.g. empty text)
 *  'hidden' → reasoning with no readable summary (encrypted only)
 *  false    → not an item this function understands
 */
export function emitItem(b: Builder, p: Rec, c: ItemCtx): 'ok' | 'hidden' | false {
  const t = str(p.type);
  if (t === 'message' || (t === undefined && typeof p.role === 'string')) {
    const text = contentText(p.content);
    if (!text.trim()) return 'ok';
    let actor = actorOf(str(p.role) ?? 'assistant') ?? 'system';
    let name: string | undefined;
    if (actor === 'user') {
      name = injectedTag(text);
      if (name) actor = 'system';
    }
    b.push({ id: c.id, actor, kind: 'message', ts: c.ts, text, name, raw: c.raw, step: c.step });
    return 'ok';
  }
  if (t === 'reasoning') {
    const summary = contentText(p.summary);
    const body = contentText(p.content);
    const text = summary && body ? summary + '\n\n' + body : summary || body;
    if (!text.trim()) return 'hidden';
    let raw = c.raw;
    if (typeof p.encrypted_content === 'string' && raw === p) {
      raw = { ...p, encrypted_content: `[encrypted, ${p.encrypted_content.length} chars]` };
    }
    b.push({ id: c.id, actor: 'assistant', kind: 'thinking', ts: c.ts, text, raw, step: c.step });
    return 'ok';
  }
  if (t === undefined) return false;
  if (t === 'agent_message') {
    // Multi-agent sessions: a message passed between agent threads.
    const text = contentText(p.content);
    if (!text.trim()) return 'ok';
    const from = str(p.author);
    const to = str(p.recipient);
    b.push({
      id: c.id, actor: 'system', kind: 'message', ts: c.ts, text,
      name: from && to ? `${from} → ${to}` : from ?? to ?? 'agent_message', raw: c.raw, step: c.step,
    });
    return 'ok';
  }
  if (t.endsWith('_call_output')) {
    const o = normalizeOutput(p.output);
    b.push({
      id: c.id, actor: 'tool', kind: 'tool_result', ts: c.ts,
      callId: idOf(p.call_id), output: o.output, isError: o.isError, durationMs: o.durationMs, raw: c.raw, step: c.step,
    });
    return 'ok';
  }
  if (t.endsWith('_call')) {
    const base = str(p.name) ?? t.slice(0, -5);
    const ns = str(p.namespace);
    b.push({
      id: c.id, actor: 'assistant', kind: 'tool_call', ts: c.ts,
      callId: idOf(p.call_id) ?? idOf(p.id),
      name: ns ? `${ns}.${base}` : base,
      input: parseArgs(p.arguments ?? p.input ?? p.action),
      raw: c.raw, step: c.step,
    });
    return 'ok';
  }
  return false;
}

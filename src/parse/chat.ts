import type { ParseResult, SessionMeta } from './types.ts';
import { emitContent, nextId, type Ctx } from './blocks.ts';
import { actorOf, emitItem, injectedTag, ITEM_TYPE } from './items.ts';
import {
  Builder, contentText, idOf, isObj, parseArgs, str, toIso, toolOutput, usageFrom, usageText,
  type LineRec, type Rec,
} from './util.ts';

/**
 * Generic chat transcripts: OpenAI chat-completions messages, Anthropic messages,
 * OpenAI Responses items, and ShareGPT-style {from,value} turns.
 */
export function parseChat(recs: LineRec[], b: Builder, wrapper?: Rec): ParseResult {
  const meta: SessionMeta = {};
  if (wrapper) {
    const model = str(wrapper.model) ?? str(wrapper.model_name);
    if (model) meta.model = model;
    if (Array.isArray(wrapper.tools)) meta.toolCount = wrapper.tools.length;
    const sys = contentText(wrapper.system ?? wrapper.instructions);
    if (sys.trim()) b.push({ id: 'system', actor: 'system', kind: 'message', text: sys, raw: wrapper.system ?? wrapper.instructions });
  }
  /** Legacy `function_call` has no id, so results are matched to calls by function name. */
  const legacyCalls = new Map<string, string[]>();
  let unknown = 0;

  for (let i = 0; i < recs.length; i++) {
    const m = recs[i].v;
    const line = recs[i].line;
    const step = i + 1;
    const ts = toIso(m.timestamp ?? m.created_at ?? m.ts ?? m.time);
    const type = str(m.type);

    if (type !== undefined && type !== 'message' && ITEM_TYPE.test(type)) {
      if (emitItem(b, m, { id: `m${step}`, ts, raw: m, step })) continue;
    }
    const role = str(m.role) ?? str(m.from) ?? str(m.speaker) ?? (isObj(m.author) ? str(m.author.role) : undefined);
    if (role === undefined) {
      // A header line (e.g. old Codex rollouts start with {id, timestamp, instructions}) is not an error.
      if (i === 0 && recs.length > 1) {
        if (!meta.model && str(m.model)) meta.model = str(m.model);
        continue;
      }
      unknown++;
      b.push({ id: `m${step}`, actor: 'system', kind: 'unknown', ts, name: type, raw: m, step });
      continue;
    }
    const actor = actorOf(role);
    if (!actor) b.diag(`Message ${step} has an unrecognized role "${role.slice(0, 40)}"; shown as system.`, line);
    if (!meta.model && str(m.model)) meta.model = str(m.model);
    const c: Ctx = { id: `m${step}`, actor: actor ?? 'system', ts, raw: m, step, n: 0 };
    const content = m.content ?? m.value ?? m.text ?? m.parts;

    const reasoning = str(m.reasoning_content) ?? str(m.reasoning) ?? str(m.thinking);
    if (reasoning && reasoning.trim()) {
      b.push({ id: nextId(c), actor: 'assistant', kind: 'thinking', ts, text: reasoning, raw: m, step });
    }

    const hasBlocks = Array.isArray(content) && content.some((x) => isObj(x) && x.type === 'tool_result');
    if (c.actor === 'tool' && !hasBlocks) {
      const fn = str(m.name);
      const callId = idOf(m.tool_call_id) ?? idOf(m.call_id) ?? (fn ? legacyCalls.get(fn)?.shift() : undefined);
      b.push({
        id: nextId(c), actor: 'tool', kind: 'tool_result', ts, callId, name: fn,
        output: toolOutput(content), isError: m.is_error === true ? true : undefined, raw: m, step,
      });
    } else {
      const before = b.events.length;
      emitContent(b, content, c);
      // Harness context injected as a user turn reads as system, not as something the user typed.
      if (c.actor === 'user' && b.events.length === before + 1) {
        const ev = b.events[before];
        const tag = ev.kind === 'message' && ev.text ? injectedTag(ev.text) : undefined;
        if (tag) { ev.actor = 'system'; ev.name = tag; }
      }
    }

    if (Array.isArray(m.tool_calls)) {
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : tc;
        b.push({
          id: nextId(c), actor: 'assistant', kind: 'tool_call', ts,
          callId: idOf(tc.id) ?? idOf(tc.call_id) ?? `call:${step}:${j}`,
          name: str(fn.name) ?? 'unknown', input: parseArgs(fn.arguments ?? fn.input ?? fn.args), raw: m, step,
        });
      }
    }
    if (isObj(m.function_call)) {
      const fn = str(m.function_call.name) ?? 'unknown';
      const callId = `fn:${step}`;
      const q = legacyCalls.get(fn);
      if (q) q.push(callId);
      else legacyCalls.set(fn, [callId]);
      b.push({ id: nextId(c), actor: 'assistant', kind: 'tool_call', ts, callId, name: fn, input: parseArgs(m.function_call.arguments), raw: m, step });
    }
    const usage = usageFrom(m.usage);
    if (usage) b.push({ id: nextId(c), actor: 'system', kind: 'usage', ts, text: usageText(usage), usage, raw: m.usage, step });
  }
  if (unknown) b.diag(`${unknown} entr${unknown === 1 ? 'y has' : 'ies have'} no role and could not be interpreted; shown as unrecognized events.`);
  meta.messageCount = recs.length;
  return b.finish('chat', wrapper ? idOf(wrapper.id) ?? idOf(wrapper.session_id) ?? idOf(wrapper.conversation_id) : undefined, meta);
}

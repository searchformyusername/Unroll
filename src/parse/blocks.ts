import type { Actor } from "./types.ts";
import {
  Builder,
  contentText,
  idOf,
  isObj,
  parseArgs,
  partText,
  str,
  toolOutput,
} from "./util.ts";

/** Shared context for every event emitted from one source record / message. */
export interface Ctx {
  id: string;
  actor: Actor;
  ts?: string;
  raw?: unknown;
  step?: number;
  /** Events emitted so far for this record; drives stable sub-ids. */
  n: number;
}

export const nextId = (c: Ctx): string =>
  c.n++ === 0 ? c.id : `${c.id}:${c.n - 1}`;

function flushText(b: Builder, c: Ctx, text: string): void {
  if (!text.trim()) return;
  b.push({
    id: nextId(c),
    actor: c.actor,
    kind: "message",
    ts: c.ts,
    text,
    raw: c.raw,
    step: c.step,
  });
}

/**
 * Emit events for message content in source order. Understands plain strings,
 * OpenAI-style parts and Anthropic-style blocks (text, thinking, tool_use,
 * tool_result and their server/MCP variants). Adjacent text parts merge into
 * one message so the UI never shows fragmented bubbles.
 */
export function emitContent(b: Builder, content: unknown, c: Ctx): void {
  if (typeof content === "string") {
    flushText(b, c, content);
    return;
  }
  if (!Array.isArray(content)) {
    if (isObj(content)) emitContent(b, [content], c);
    return;
  }
  let text = "";
  for (const block of content) {
    const t = isObj(block) ? block.type : undefined;
    if (isObj(block) && typeof t === "string") {
      if (t === "thinking" || t === "reasoning" || t === "redacted_thinking") {
        flushText(b, c, text);
        text = "";
        const th =
          str(block.thinking) ?? str(block.text) ?? contentText(block.summary);
        if (th.trim())
          b.push({
            id: nextId(c),
            actor: "assistant",
            kind: "thinking",
            ts: c.ts,
            text: th,
            raw: c.raw,
            step: c.step,
          });
        continue;
      }
      if (t === "tool_use" || t === "server_tool_use" || t === "mcp_tool_use") {
        flushText(b, c, text);
        text = "";
        b.push({
          id: nextId(c),
          actor: "assistant",
          kind: "tool_call",
          ts: c.ts,
          callId: idOf(block.id),
          name: str(block.name) ?? "unknown",
          input: parseArgs(block.input),
          raw: c.raw,
          step: c.step,
        });
        continue;
      }
      if (t === "tool_result" || t.endsWith("_tool_result")) {
        flushText(b, c, text);
        text = "";
        b.push({
          id: nextId(c),
          actor: "tool",
          kind: "tool_result",
          ts: c.ts,
          callId: idOf(block.tool_use_id),
          output: toolOutput(block.content),
          isError: block.is_error === true ? true : undefined,
          raw: c.raw,
          step: c.step,
        });
        continue;
      }
    }
    const pt = partText(block);
    if (pt !== undefined) {
      if (pt) text = text ? text + "\n\n" + pt : pt;
    } else if (block !== null && block !== undefined) {
      flushText(b, c, text);
      text = "";
      b.push({
        id: nextId(c),
        actor: c.actor,
        kind: "unknown",
        ts: c.ts,
        name: typeof t === "string" ? t : undefined,
        raw: block,
        step: c.step,
      });
    }
  }
  flushText(b, c, text);
}

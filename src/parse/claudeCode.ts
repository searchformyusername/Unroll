import type { ParseResult, SessionMeta, TraceEvent } from "./types.ts";
import { emitContent, nextId, type Ctx } from "./blocks.ts";
import { injectedTag } from "./items.ts";
import {
  Builder,
  idOf,
  isObj,
  num,
  str,
  toIso,
  usageFrom,
  usageText,
  type LineRec,
} from "./util.ts";

interface Node {
  uuid: string;
  parent: string | undefined;
  logical: string | undefined;
  side: boolean;
  /** Range of events this record produced: [evStart, evEnd). */
  evStart: number;
  evEnd: number;
  /** Id of the record's last chain event (usage excluded); undefined if it produced none. */
  lastId: string | undefined;
  line: number | undefined;
}

/**
 * Claude Code session log. Records form a tree through parentUuid: rewinds and
 * retries leave abandoned branches in the file, and context compaction starts a
 * new root that points back through logicalParentUuid. Events are returned in
 * file order with parentId preserved; anything outside the active path is
 * flagged offPath so the UI can hide or dim it.
 */
export function parseClaudeCode(recs: LineRec[], b: Builder): ParseResult {
  const meta: SessionMeta = {};
  const nodes: Node[] = [];
  const pos = new Map<string, number>();
  const usageByMsg = new Map<string, TraceEvent>();
  const callNode = new Map<string, number>();
  const resultNodes: number[] = [];
  const resultCalls: string[] = [];
  const skipped: Record<string, number> = {};
  let sessionId: string | undefined;
  let leaf: string | undefined;
  let dupes = 0;
  let hidden = 0;
  let hiddenMs = 0;

  for (const r of recs) {
    const v = r.v;
    const type = str(v.type) ?? "?";
    sessionId ??= str(v.sessionId);
    if (meta.cwd === undefined && str(v.cwd)) meta.cwd = v.cwd;
    if (meta.gitBranch === undefined && str(v.gitBranch))
      meta.gitBranch = v.gitBranch;
    if (meta.version === undefined && str(v.version)) meta.version = v.version;

    const uuid = str(v.uuid);
    let node: Node | undefined;
    if (uuid !== undefined) {
      if (pos.has(uuid)) {
        dupes++;
        continue;
      }
      node = {
        uuid,
        parent: str(v.parentUuid),
        logical: str(v.logicalParentUuid),
        side: v.isSidechain === true,
        evStart: b.events.length,
        evEnd: b.events.length,
        lastId: undefined,
        line: r.line,
      };
      pos.set(uuid, nodes.length);
      nodes.push(node);
    }

    const ts = toIso(v.timestamp);
    if ((type === "user" || type === "assistant") && isObj(v.message)) {
      const msg = v.message;
      const system =
        type === "user" && (v.isMeta === true || v.isCompactSummary === true);
      const c: Ctx = {
        id: uuid ?? `L${r.line ?? nodes.length}`,
        actor: system ? "system" : type,
        ts,
        raw: v,
        n: 0,
      };
      const start = b.events.length;
      emitContent(b, msg.content, c);
      const end = b.events.length;
      if (type === "user" && !system && end === start + 1) {
        const ev = b.events[start];
        const tag =
          ev.kind === "message" && ev.text ? injectedTag(ev.text) : undefined;
        if (tag) {
          ev.actor = "system";
          ev.name = tag;
        }
      }
      if (v.isApiErrorMessage === true)
        for (let i = start; i < end; i++) b.events[i].isError = true;
      if (type === "assistant") {
        // thinkingDurationMs is recorded on the line that carries the thinking block.
        const mid = idOf(msg.id);
        const thinkMs = num(v.thinkingDurationMs);
        let shown: number | undefined;
        let shownCount = 0;
        for (let i = start; i < end; i++) {
          if (mid !== undefined) b.events[i].responseId = mid;
          if (b.events[i].kind === "thinking") {
            shown = i;
            shownCount++;
          }
        }
        if (shownCount === 1 && thinkMs !== undefined && thinkMs > 0)
          b.events[shown!].durationMs = thinkMs;
        else if (
          shownCount === 0 &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (x) =>
              isObj(x) &&
              (x.type === "thinking" || x.type === "redacted_thinking"),
          )
        ) {
          hidden++; // the provider returned reasoning without readable text
          if (thinkMs !== undefined && thinkMs > 0) hiddenMs += thinkMs;
        }
      } else if (isObj(v.toolUseResult)) {
        // A tool's own reported run time, only when this line holds exactly one result.
        const d =
          num(v.toolUseResult.durationMs) ??
          num(v.toolUseResult.totalDurationMs);
        if (
          d !== undefined &&
          d >= 0 &&
          end === start + 1 &&
          b.events[start].kind === "tool_result"
        )
          b.events[start].durationMs = d;
      }
      if (node) {
        const at = nodes.length - 1;
        for (let i = start; i < end; i++) {
          const ev = b.events[i];
          if (ev.callId === undefined) continue;
          if (ev.kind === "tool_call") callNode.set(ev.callId, at);
          else if (ev.kind === "tool_result") {
            resultNodes.push(at);
            resultCalls.push(ev.callId);
          }
        }
      }
      if (type === "assistant") {
        const model = str(msg.model);
        if (model && model !== "<synthetic>" && !meta.model) meta.model = model;
        const usage = usageFrom(msg.usage);
        if (usage) {
          // One API response is split across several lines that repeat the same message.id and usage.
          const mid = idOf(msg.id);
          const prev = mid ? usageByMsg.get(mid) : undefined;
          if (prev) {
            prev.usage = usage;
            prev.text = usageText(usage);
          } else {
            const ev = b.push({
              id: nextId(c),
              actor: "system",
              kind: "usage",
              ts,
              text: usageText(usage),
              usage,
              raw: msg.usage,
              responseId: mid,
            });
            if (mid) usageByMsg.set(mid, ev);
          }
        }
      }
    } else if (type === "system") {
      const durationMs =
        num(v.durationMs) ??
        (isObj(v.compactMetadata)
          ? num(v.compactMetadata.durationMs)
          : undefined);
      const text = str(v.content)?.trim()
        ? str(v.content)
        : v.subtype === "turn_duration" && durationMs !== undefined
          ? "Turn completed"
          : undefined;
      if (text) {
        b.push({
          id: uuid ?? `L${r.line ?? nodes.length}`,
          actor: "system",
          kind: "meta",
          ts,
          text,
          name: str(v.subtype),
          isError: v.level === "error" ? true : undefined,
          raw: v,
          durationMs,
        });
      }
    } else if (type === "summary") {
      if (!meta.title && str(v.summary)) meta.title = v.summary;
    } else if (type === "custom-title") {
      if (str(v.customTitle)) meta.title = v.customTitle;
    } else if (type === "agent-name") {
      if (str(v.agentName)) meta.agentName = v.agentName;
    } else if (type === "last-prompt") {
      if (str(v.leafUuid)) leaf = str(v.leafUuid);
    } else {
      skipped[type] = (skipped[type] ?? 0) + 1;
    }
    if (node) node.evEnd = b.events.length;
  }

  const ev = b.events;
  const n = nodes.length;
  // A sub-agent's own transcript marks every record as a sidechain. Inside that file it IS the
  // main thread, so the flag is dropped and recorded once on the session instead.
  let mainRecords = 0;
  let sideRecords = 0;
  for (const node of nodes) {
    if (node.evEnd === node.evStart) continue;
    if (node.side) sideRecords++;
    else mainRecords++;
  }
  if (sideRecords > 0 && mainRecords === 0) {
    for (const node of nodes) node.side = false;
    meta.subagentTranscript = true;
  }
  const parentPos = (i: number): number => {
    const p = nodes[i].parent ?? nodes[i].logical;
    return p === undefined ? -1 : (pos.get(p) ?? -1);
  };

  // ---- parentId: link each record's events to the nearest ancestor that produced events.
  const anchor = new Int32Array(n).fill(-2); // nearest ancestor-with-events position; -1 none; -2 unknown
  const resolve = (start: number): number => {
    const trail: number[] = [];
    let x = parentPos(start);
    let found = -1;
    for (let guard = 0; x >= 0 && guard <= n; guard++) {
      if (nodes[x].lastId !== undefined) {
        found = x;
        break;
      }
      if (anchor[x] !== -2) {
        found = anchor[x];
        break;
      }
      trail.push(x);
      x = parentPos(x);
    }
    for (const t of trail) anchor[t] = found;
    return found;
  };
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.evEnd === node.evStart) continue;
    let last: string | undefined;
    for (let k = node.evStart; k < node.evEnd; k++)
      if (ev[k].kind !== "usage") last = ev[k].id;
    node.lastId = last;
  }
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.evEnd === node.evStart) continue;
    const a = resolve(i);
    anchor[i] = a;
    let prev = a >= 0 ? nodes[a].lastId : undefined;
    for (let k = node.evStart; k < node.evEnd; k++) {
      if (prev !== undefined) ev[k].parentId = prev;
      if (ev[k].kind !== "usage") prev = ev[k].id;
      if (node.side) ev[k].sidechain = true;
    }
  }

  // ---- active path: walk from the active leaf back to the first record.
  let leafPos = leaf !== undefined ? (pos.get(leaf) ?? -1) : -1;
  const leafKnown = leafPos >= 0;
  if (leafPos < 0) {
    for (let i = n - 1; i >= 0; i--) {
      if (!nodes[i].side && nodes[i].evEnd > nodes[i].evStart) {
        leafPos = i;
        break;
      }
    }
  }
  if (leafPos >= 0) {
    const on = new Uint8Array(n);
    let broken = 0;
    let x = leafPos;
    while (x >= 0 && !on[x]) {
      on[x] = 1;
      const node = nodes[x];
      let p = node.parent !== undefined ? (pos.get(node.parent) ?? -1) : -1;
      if (p < 0 && node.logical !== undefined) p = pos.get(node.logical) ?? -1;
      if (p < 0) {
        // Compaction boundary without a usable link, or a dangling parentUuid:
        // the conversation continues from whatever main-thread record precedes it in the file.
        if (node.parent !== undefined) {
          broken++;
          b.diag(
            "Parent record is missing from this file; treated as a continuation of the preceding record.",
            node.line,
          );
        }
        p = x - 1;
        while (p >= 0 && nodes[p].side) p--;
      }
      x = p;
    }
    // Parallel tool results hang off their own tool_use record, so they sit on side forks
    // of the chain even though they are part of the conversation. Pull them back in.
    for (let i = 0; i < resultNodes.length; i++) {
      const c = callNode.get(resultCalls[i]);
      if (c !== undefined && on[c]) on[resultNodes[i]] = 1;
    }
    let off = 0;
    let main = 0;
    let branches = 0;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (node.side) continue;
      const count = node.evEnd - node.evStart;
      main += count;
      if (on[i]) continue;
      off += count;
      const p = parentPos(i);
      if (count && (p < 0 || on[p])) branches++;
    }
    if (off && !leafKnown && off * 2 > main) {
      b.diag(
        "Could not determine the active branch of this session; all branches are shown in file order.",
      );
    } else if (off) {
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (on[i] || node.side) continue;
        for (let k = node.evStart; k < node.evEnd; k++) ev[k].offPath = true;
      }
      meta.offPathEvents = off;
      b.diag(
        `${off} event(s) on ${branches || 1} abandoned branch(es) (rewinds or retries) are flagged offPath.`,
      );
    }
    if (broken) meta.brokenParentLinks = broken;
  }
  if (dupes)
    b.diag(`${dupes} duplicate record(s) (repeated uuid) were ignored.`);
  if (hidden) meta.hiddenReasoningCount = hidden;
  if (hiddenMs) meta.hiddenReasoningMs = hiddenMs;
  meta.skippedRecords = skipped;
  return b.finish("claude-code", sessionId, meta);
}

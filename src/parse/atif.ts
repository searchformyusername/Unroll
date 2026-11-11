import type { Actor, ParseResult, SessionMeta } from './types.ts';
import {
  Builder, contentText, idOf, isObj, num, parseArgs, str, timingFrom, timingText, toIso, toolOutput,
  usageFrom, usageText, type Rec,
} from './util.ts';

const SOURCE: Record<string, Actor> = { user: 'user', agent: 'assistant', assistant: 'assistant', system: 'system' };

/**
 * ATIF (Agent Trajectory Interchange Format). One step fans out, in reading order, to:
 * thinking → message → tool_call(s) → tool_result(s) → usage.
 */
export function parseAtif(doc: Rec, steps: unknown[], b: Builder): ParseResult {
  const agent = isObj(doc.agent) ? doc.agent : {};
  const meta: SessionMeta = {};
  const model = str(agent.model_name);
  if (model) meta.model = model;
  if (str(agent.name)) meta.agentName = agent.name;
  if (str(agent.version)) meta.agentVersion = agent.version;
  if (str(doc.schema_version)) meta.schemaVersion = doc.schema_version;
  if (idOf(doc.trajectory_id)) meta.trajectoryId = idOf(doc.trajectory_id);
  if (str(doc.notes)) meta.notes = doc.notes;
  meta.stepCount = steps.length;
  if (isObj(doc.final_metrics)) {
    meta.finalMetrics = doc.final_metrics;
    const f = doc.final_metrics;
    const total = usageFrom({
      prompt_tokens: f.total_prompt_tokens, completion_tokens: f.total_completion_tokens,
      cached_tokens: f.total_cached_tokens, cost_usd: f.total_cost_usd,
    });
    if (total) meta.totalUsage = total;
  }
  if (Array.isArray(doc.subagent_trajectories) && doc.subagent_trajectories.length) {
    meta.subagentTrajectoryCount = doc.subagent_trajectories.length;
    b.diag(`${doc.subagent_trajectories.length} embedded sub-agent trajectories are not expanded in this view yet.`);
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!isObj(s)) {
      b.diag(`Step at position ${i + 1} is not an object; skipped.`);
      continue;
    }
    const key = idOf(s.step_id) ?? String(i + 1);
    const step = num(s.step_id) ?? i + 1;
    const base = `s${key}`;
    const src = str(s.source);
    let actor = src ? SOURCE[src] : undefined;
    if (!actor) {
      b.diag(`Step ${key} has an unrecognized source "${String(s.source).slice(0, 40)}"; shown as system.`);
      actor = 'system';
    }
    const ts = toIso(s.timestamp);
    if (!meta.model && str(s.model_name)) meta.model = str(s.model_name);

    const reasoning = contentText(s.reasoning_content);
    if (reasoning.trim()) {
      b.push({ id: `${base}:think`, actor: 'assistant', kind: 'thinking', ts, text: reasoning, raw: s, step });
    }
    const message = contentText(s.message);
    if (message.trim()) {
      b.push({ id: `${base}:msg`, actor, kind: 'message', ts, text: message, raw: s, step });
    }

    if (Array.isArray(s.tool_calls)) {
      for (let j = 0; j < s.tool_calls.length; j++) {
        const c = s.tool_calls[j];
        if (!isObj(c)) {
          b.diag(`Step ${key}: tool call ${j + 1} is not an object; skipped.`);
          continue;
        }
        b.push({
          id: `${base}:call:${j}`, actor: 'assistant', kind: 'tool_call', ts,
          callId: idOf(c.tool_call_id) ?? idOf(c.id),
          name: str(c.function_name) ?? str(c.name) ?? 'unknown',
          input: parseArgs(c.arguments), raw: c, step,
        });
      }
    }
    const results = isObj(s.observation) ? s.observation.results : undefined;
    if (Array.isArray(results)) {
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (!isObj(r)) {
          b.diag(`Step ${key}: observation result ${j + 1} is not an object; skipped.`);
          continue;
        }
        b.push({
          id: `${base}:result:${j}`, actor: 'tool', kind: 'tool_result', ts,
          callId: idOf(r.source_call_id), output: toolOutput(r.content),
          isError: r.is_error === true ? true : undefined, raw: r, step,
          durationMs: timingFrom(r.extra).durationMs,
        });
      }
    }
    // Step-scoped numbers the source recorded: token usage plus any explicit duration / TTFT.
    const usage = usageFrom(s.metrics);
    const timing = timingFrom(s.extra, timingFrom(s.metrics));
    if (usage || timing.durationMs !== undefined || timing.ttftMs !== undefined) {
      const text = [usage ? usageText(usage) : '', timingText(timing)].filter(Boolean).join(' · ');
      b.push({
        id: `${base}:usage`, actor: 'system', kind: 'usage', ts, text, usage, raw: s.metrics ?? s.extra, step,
        durationMs: timing.durationMs, ttftMs: timing.ttftMs,
      });
    }
  }
  return b.finish('atif', idOf(doc.session_id) ?? idOf(doc.trajectory_id), meta);
}

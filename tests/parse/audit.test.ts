import { describe, expect, it } from "vitest";
import { parse } from "../../src/parse/index.ts";
import { analyze } from "../../src/analyze/index.ts";

describe("source preservation and pairing audit", () => {
  it.each([
    ["x#2", "x", "x"],
    ["x", "x", "x#2"],
    ["x", "x#2", "x", "x#3", "x"],
  ])("reserves all original call IDs before generating suffixes: %j", (...ids) => {
    const doc = { schema_version: "ATIF-v1.7", steps: ids.map((id, index) => ({
      step_id: index + 1, source: "agent",
      tool_calls: [{ tool_call_id: id, function_name: `tool${index}`, arguments: {} }],
      observation: { results: [{ source_call_id: id, content: `output${index}` }] },
    })) };
    const { session } = parse(JSON.stringify(doc));
    const calls = session.events.filter((e) => e.kind === "tool_call");
    const results = session.events.filter((e) => e.kind === "tool_result");
    expect(new Set(calls.map((e) => e.callId)).size).toBe(ids.length);
    results.forEach((result, index) => {
      expect(result.callId).toBe(calls[index].callId);
      expect(result.name).toBe(`tool${index}`);
      expect(result.output).toBe(`output${index}`);
    });
  });

  it("does not accidentally attach an orphan result to a generated ID", () => {
    const { session, diagnostics } = parse(JSON.stringify({
      schema_version: "ATIF-v1.7", steps: [{ step_id: 1, source: "agent",
        tool_calls: ["x", "x"].map((id) => ({ tool_call_id: id, function_name: "tool" })),
        observation: { results: [{ source_call_id: "x#2", content: "orphan" }] },
      }],
    }));
    expect(session.events.filter((e) => e.kind === "tool_call").map((e) => e.callId)).toEqual(["x", "x#3"]);
    expect(diagnostics.some((d) => /not in this file/.test(d.reason))).toBe(true);
  });

  it("retains root extensions, tool-only step metadata, and unknown content", () => {
    const doc = { schema_version: "ATIF-v1.7", agent: { extra: { config: { mode: "test" } } },
      extra: { provenance: "synthetic" }, continued_trajectory_ref: "next.json",
      steps: [
        { step_id: 1, source: "agent", extra: { custom: 42 }, tool_calls: [{ tool_call_id: "a", function_name: "read" }] },
        { step_id: 2, source: "agent", message: [{ type: "novel_part", payload: "retain me" }] },
        { step_id: 3, source: "agent", extra: { status: "waiting" } },
      ],
    };
    const result = parse(JSON.stringify(doc));
    expect(result.session.meta.sourceMetadata).toEqual({ ...doc, steps: undefined });
    expect(result.session.events.map((e) => e.sourceStep)).toEqual(doc.steps);
    expect(result.session.events[0].raw).toEqual(doc.steps[0].tool_calls![0]);
    expect(result.session.events[1].kind).toBe("meta");
    expect(result.session.events[1].raw).toEqual(doc.steps[1]);
    expect(result.diagnostics.some((d) => /unsupported content/.test(d.reason))).toBe(true);
    expect(structuredClone(result)).toEqual(result);
  });

  it("keeps unknown parts of a partially readable ATIF message in its complete source", () => {
    const step = { step_id: 1, source: "agent", message: [{ type: "text", text: "known" }, { type: "future", value: 1 }] };
    const result = parse(JSON.stringify({ steps: [step] }));
    expect(result.session.events[0].text).toBe("known");
    expect(result.session.events[0].sourceStep).toEqual(step);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("uses wrapper usage as total without double-counting per-message usage", () => {
    const { session } = parse(JSON.stringify({ messages: [{ role: "assistant", content: "hello", usage: { prompt_tokens: 100, completion_tokens: 20 } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }, input: ["unrelated context"], custom: 7,
    }));
    expect(session.meta.totalUsage).toEqual({ input: 100, output: 20, total: 120 });
    expect(session.meta.sourceMetadata).toMatchObject({ input: ["unrelated context"], custom: 7 });
    expect(session.meta.sourceMetadata).not.toHaveProperty("messages");
    const analysis = analyze(session);
    expect(analysis.inputTokens).toBe(100);
    expect(analysis.outputTokens).toBe(20);
  });
});

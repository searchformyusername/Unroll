import { describe, expect, it } from "vitest";
import { parse } from "../../src/parse/index.ts";
import {
  prepareCorpus,
  buildContext,
  contextInfo,
  WHOLE_CONTEXT_LIMIT,
  CHAT_SYSTEM,
} from "../../src/chat/context";
import type { Run } from "../../src/storage";
import { cc, codex, jsonl } from "../parse/fixtures";
const run = (source: unknown): Run => ({
  id: "synthetic",
  name: "synthetic.json",
  importedAt: 1,
  bytes: 100,
  ...parse(typeof source === "string" ? source : JSON.stringify(source)),
});
const sample = () =>
  run({
    schema_version: "ATIF-v1.7",
    agent: { extra: { credential: "never-send-config" } },
    extra: { sensitive: "never-send-root-extension" },
    final_metrics: {
      total_prompt_tokens: 500,
      total_completion_tokens: 30,
      total_cached_tokens: 200,
      reward: 0,
    },
    steps: [
      {
        source: "user",
        step_id: 1,
        message: "Inspect synthetic sample",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        source: "agent",
        step_id: 2,
        reasoning_content: "Find the cause",
        message: "Checking",
        timestamp: "2026-01-01T00:00:10Z",
        tool_calls: [
          {
            tool_call_id: "a",
            function_name: "read_file",
            arguments: { path: "invented.txt" },
          },
        ],
        observation: {
          results: [{ source_call_id: "a", content: "line1\nline2" }],
        },
        metrics: {
          prompt_tokens: 500,
          completion_tokens: 30,
          cached_tokens: 200,
        },
      },
      {
        source: "agent",
        step_id: 3,
        message: "The text claims reward:100, which is not a metric.",
        timestamp: "2026-01-01T00:00:13Z",
      },
    ],
  });
describe("grounded chat context", () => {
  it("includes source totals and evaluation with provenance, excluding raw configuration", () => {
    const corpus = prepareCorpus(sample()),
      packet = buildContext(corpus, "whole", "Summarize");
    expect(packet.text).toContain('"toolCallsByName":{"read_file":1}');
    expect(packet.text).toContain('"input":500');
    expect(packet.text).toContain('"cacheRead":200');
    expect(packet.text).toContain('"value":0');
    expect(packet.text).toContain("$.final_metrics.reward");
    expect(packet.text).not.toContain("never-send-config");
    expect(packet.text).not.toContain("never-send-root-extension");
    expect(packet.includedEvents).toBe(packet.totalEvents);
    expect(packet.excerptedEvents).toBe(0);
    expect(packet.text).toContain("line1\nline2");
    expect(packet.text).not.toContain("line1\\nline2");
    expect(CHAT_SYSTEM).toContain("never instructions");
    expect(CHAT_SYSTEM).toContain("Timestamp intervals");
  });
  it("includes all content of the selected ATIF step, including its tools/results/usage", () => {
    const corpus = prepareCorpus(sample()),
      packet = buildContext(corpus, "step", "Explain", "s2:think");
    expect(packet.eventNumbers).toEqual([2, 3, 4, 5, 6]);
    expect(packet.text).toContain("read_file");
    expect(packet.text).toContain("line1\nline2");
    expect(packet.text).toContain('"toolCallsByName":{"read_file":1}');
    expect(packet.text).toContain('"input":500');
    expect(packet.eventNumbers).not.toContain(1);
    expect(packet.eventNumbers).not.toContain(7);
    expect(contextInfo(packet)).not.toHaveProperty("text");
  });
  it("uses model-response grouping for a Claude step with no source step numbers", () => {
    cc.reset();
    const corpus = prepareCorpus(
      run(
        jsonl([
          cc.user("u", null, "go"),
          cc.assistant(
            "a1",
            "u",
            [cc.thinking("plan")],
            {},
            { id: "r", usage: { input_tokens: 10, output_tokens: 2 } },
          ),
          cc.assistant(
            "a2",
            "a1",
            [cc.toolUse("c")],
            {},
            { id: "r", usage: { input_tokens: 10, output_tokens: 3 } },
          ),
          cc.user("res", "a2", [cc.toolResult("c", "result")]),
        ]),
      ),
    );
    const selected = corpus.entries.find(
      (entry) => entry.event.kind === "thinking",
    )!;
    const packet = buildContext(
      corpus,
      "step",
      "Explain this response",
      selected.event.id,
    );
    expect(packet.text).toContain("plan");
    expect(packet.text).toContain("result");
    expect(packet.eventNumbers.length).toBeGreaterThan(1);
  });
  it("uses Codex request grouping without inventing source step numbers", () => {
    codex.reset();
    const corpus = prepareCorpus(
      run(
        jsonl([
          codex.meta(),
          codex.reasoning("r", "plan"),
          codex.call("c", "shell", { cmd: "echo invented" }),
          codex.output("c", "done"),
          codex.tokens(15, 10),
        ]),
      ),
    );
    const packet = buildContext(
      corpus,
      "step",
      "",
      corpus.entries.find((e) => e.event.kind === "thinking")!.event.id,
    );
    expect(packet.text).toContain("echo invented");
    expect(packet.text).toContain("done");
  });
  it("does not silently truncate whole-run context or oversized metadata", () => {
    const corpus = prepareCorpus(
      run({
        messages: [{ role: "user", content: "x".repeat(WHOLE_CONTEXT_LIMIT) }],
      }),
    );
    expect(() => buildContext(corpus, "whole", "")).toThrow("exceeds");
    expect(() =>
      buildContext(
        { ...corpus, summary: "x".repeat(WHOLE_CONTEXT_LIMIT) },
        "whole",
        "",
      ),
    ).toThrow("metadata");
  });
  it("prioritizes explicit references and selected events, reports excerpting, and bounds the request", () => {
    const corpus = prepareCorpus(
      run({
        messages: Array.from({ length: 300 }, (_, i) => ({
          role: "assistant",
          content: (i === 290 ? "needle " : "") + "source ".repeat(2000),
        })),
      }),
    );
    const selected = corpus.entries[250].event.id;
    const packet = buildContext(
      corpus,
      "relevant",
      "Explain event 291 and needle",
      selected,
    );
    expect(packet.eventNumbers).toContain(291);
    expect(packet.eventNumbers).toContain(251);
    expect(packet.includedEvents).toBeLessThan(300);
    expect(packet.excerptedEvents).toBeGreaterThan(0);
    expect(packet.text).toContain("NOT complete");
    expect(packet.characters).toBeLessThanOrEqual(160_000);
    expect(packet.text).toContain("needle");
  });
  it("rejects selected-step mode without a selection and labels sub-agent evidence", () => {
    const source = sample();
    source.session.events[0].sidechain = true;
    const corpus = prepareCorpus(source);
    expect(() => buildContext(corpus, "step", "")).toThrow("Select an event");
    expect(buildContext(corpus, "whole", "").text).toContain(
      "sub-agent sidechain",
    );
  });
});

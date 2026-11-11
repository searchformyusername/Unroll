import { describe, expect, it } from "vitest";
import { exportTrajectory } from "../../src/download";
import { parse } from "../../src/parse/index";
import type { Run } from "../../src/storage";
import { MAX_NESTING_DEPTH } from "../../src/parse/util";
const nested = (levels: number): unknown => {
  let value: unknown = "leaf";
  for (let i = 0; i < levels; i++) value = { child: value };
  return value;
};
const fromSource = (source: string): Run => ({
  id: "synthetic",
  name: "synthetic.json",
  bytes: source.length,
  importedAt: 1,
  ...parse(source),
});
const normalized = (source = run()) =>
  JSON.parse(exportTrajectory(source).text);
const original = '{"messages":[{"role":"user","content":"Synthetic café"}]}\n';
const run = (): Run => ({
  id: "synthetic",
  name: "renamed",
  bytes: 100,
  importedAt: 1,
  ...parse(original),
});
describe("trajectory downloads", () => {
  it("preserves imported text and original filename after rename", () => {
    const result = exportTrajectory({
      ...run(),
      originalText: original,
      originalName: "original.json",
    });
    expect(result).toEqual({
      text: original,
      filename: "original.json",
      mime: "application/json",
      original: true,
    });
    expect(parse(result.text).session.events[0].text).toBe("Synthetic café");
  });
  it("labels legacy exports as normalized and reopens them without dropping source records", () => {
    const source = run();
    source.session.events[0].raw = { inventedExtension: { keep: true } };
    const result = exportTrajectory(source),
      restored = parse(result.text);
    expect(result.original).toBe(false);
    expect(result.filename).toBe("renamed.unroll.json");
    expect(restored.session).toEqual(source.session);
    expect(result.text).not.toContain("apiKey");
  });
  it("continues to reopen older inline exports", () => {
    const source = run();
    source.session.events[0].sourceStep = { nested: ["kept"] };
    const restored = parse(
      JSON.stringify({
        schema_version: "unroll-v1",
        session: source.session,
        diagnostics: source.diagnostics,
      }),
    );
    expect(restored.session).toEqual(source.session);
  });
  it("deduplicates object fields by identity and restores shared references exactly", () => {
    const source = run(),
      shared = { synthetic: ["value"] };
    source.session.events[0].raw = shared;
    source.session.events[0].sourceStep = shared;
    source.session.events[0].input = shared;
    source.session.events[0].output = shared;
    source.session.events.push({
      idx: 1,
      id: "second",
      actor: "assistant",
      kind: "message",
      text: "second",
      sourceStep: shared,
    });
    const document = normalized(source),
      restored = parse(JSON.stringify(document));
    expect(
      document.sourceRecords.filter(
        (record: string) => record === JSON.stringify(shared),
      ),
    ).toHaveLength(1);
    expect(document.session.events[0].raw).toBeUndefined();
    expect(document.session.events[0].rawRef).toBe(
      document.session.events[0].sourceStepRef,
    );
    expect(restored.session).toEqual(source.session);
    const first = restored.session.events[0];
    expect(first.raw).toBe(first.sourceStep);
    expect(first.input).toBe(first.output);
    expect(restored.session.events[1].sourceStep).toBe(first.raw);
  });
  it("keeps a many-call ATIF export linear in source size while preserving the complete session", () => {
    const sourceText = JSON.stringify({
      schema_version: "ATIF-v1.7",
      extra: { keep: true },
      steps: [
        {
          source: "agent",
          step_id: 1,
          tool_calls: Array.from({ length: 80 }, (_, i) => ({
            tool_call_id: String(i),
            function_name: "synthetic",
            arguments: { input: "x".repeat(100) },
          })),
          observation: {
            results: Array.from({ length: 80 }, (_, i) => ({
              source_call_id: String(i),
              content: "y".repeat(100),
            })),
          },
        },
      ],
    });
    const source = fromSource(sourceText),
      result = exportTrajectory(source),
      restored = parse(result.text);
    expect(source.session.events).toHaveLength(160);
    expect(result.text.length).toBeLessThan(sourceText.length * 10);
    expect(restored.session).toEqual(source.session);
    expect(restored.session.events[0].sourceStep).toBe(
      restored.session.events[159].sourceStep,
    );
  });
  it("round-trips accepted depth-200 event source data without extra wrapper depth", () => {
    const source = fromSource(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: "synthetic",
            extra: nested(MAX_NESTING_DEPTH - 3),
          },
        ],
      }),
    );
    expect(parse(exportTrajectory(source).text).session).toEqual(
      source.session,
    );
  });
  it("round-trips depth-200 root metadata without relaxing decoded record limits", () => {
    const source = fromSource(
      JSON.stringify({
        messages: [{ role: "user", content: "synthetic" }],
        extra: nested(MAX_NESTING_DEPTH - 1),
      }),
    );
    const document = normalized(source);
    expect(document.session.meta.sourceMetadata).toBeUndefined();
    expect(document.session.metadataRefs.sourceMetadata).toEqual(
      expect.any(Number),
    );
    expect(parse(JSON.stringify(document)).session).toEqual(source.session);
  });
  it("safely reconstructs metadata field names including __proto__", () => {
    const source = run();
    source.session.meta = Object.fromEntries([
      ["__proto__", { synthetic: true }],
      ["constructor", { keep: true }],
      ["model", "synthetic"],
    ]);
    const restored = parse(exportTrajectory(source).text);
    expect(restored.session).toEqual(source.session);
    expect(Object.getPrototypeOf(restored.session.meta)).toBe(Object.prototype);
    expect(
      Object.prototype.hasOwnProperty.call(restored.session.meta, "__proto__"),
    ).toBe(true);
  });
  it.each([-1, 0.5, 999, null, "0"])(
    "rejects invalid record index %j rather than dropping source data",
    (index) => {
      const document = normalized();
      document.session.events[0].rawRef = index;
      expect(() => parse(JSON.stringify(document))).toThrow(
        "invalid rawRef source reference",
      );
    },
  );
  it("rejects missing tables, malformed tables and invalid referenced JSON without echoing it", () => {
    const missing = normalized();
    delete missing.sourceRecords;
    expect(() => parse(JSON.stringify(missing))).toThrow("source reference");
    const table = normalized();
    table.sourceRecords = [{}];
    expect(() => parse(JSON.stringify(table))).toThrow(
      "invalid source records table",
    );
    const invalid = normalized(),
      index = invalid.session.events[0].rawRef;
    invalid.sourceRecords[index] = "SYNTHETIC_PRIVATE_PAYLOAD invalid JSON";
    expect(() => parse(JSON.stringify(invalid))).toThrow(
      "invalid JSON in source record",
    );
    try {
      parse(JSON.stringify(invalid));
    } catch (error) {
      expect((error as Error).message).not.toContain(
        "SYNTHETIC_PRIVATE_PAYLOAD",
      );
    }
  });
  it("rejects decoded records over the depth limit and non-object records", () => {
    const document = normalized(),
      index = document.session.events[0].rawRef;
    document.sourceRecords[index] = JSON.stringify(
      nested(MAX_NESTING_DEPTH + 1),
    );
    expect(() => parse(JSON.stringify(document))).toThrow(
      expect.objectContaining({ code: "too_deep" }),
    );
    document.sourceRecords[index] = "42";
    expect(() => parse(JSON.stringify(document))).toThrow(
      "non-object source record",
    );
  });
  it("rejects conflicting inline and referenced fields and malformed metadata references", () => {
    const event = normalized();
    event.session.events[0].raw = { ambiguous: true };
    expect(() => parse(JSON.stringify(event))).toThrow("both inline raw");
    const metadata = normalized();
    metadata.session.metadataRefs = [];
    expect(() => parse(JSON.stringify(metadata))).toThrow(
      "invalid metadata source references",
    );
    const conflict = normalized();
    conflict.session.meta.sourceMetadata = {};
    expect(() => parse(JSON.stringify(conflict))).toThrow(
      "both inline metadata",
    );
    const invalid = normalized();
    invalid.session.metadataRefs.sourceMetadata = -1;
    expect(() => parse(JSON.stringify(invalid))).toThrow(
      "invalid metadata source reference",
    );
  });
  it("preserves NDJSON content and prevents path characters in filenames", () => {
    const text =
      '{"role":"user","content":"one"}\n{"role":"assistant","content":"two"}\n';
    const result = exportTrajectory({
      ...run(),
      originalText: text,
      originalName: "../invented?.jsonl",
    });
    expect(result.mime).toBe("application/x-ndjson");
    expect(result.filename).not.toMatch(/[\\/?]/);
    expect(result.text).toBe(text);
    expect(parse(result.text).session.events).toHaveLength(2);
  });
  it("rejects malformed normalized records while keeping healthy controls", () => {
    const document = JSON.parse(exportTrajectory(run()).text);
    document.session.events.push({
      actor: "invalid",
      kind: "message",
      text: "skip",
    });
    const result = parse(JSON.stringify(document));
    expect(result.session.events).toHaveLength(1);
    expect(result.diagnostics[0].reason).toContain("invalid actor");
  });
});

it("rejects compact references that multiply readable payloads beyond the import budget", () => {
  const sourceRecords = [JSON.stringify({ payload: "x".repeat(1024 * 1024) })];
  const document = {
    schema_version: "unroll-v1",
    sourceRecords,
    session: {
      id: "synthetic",
      format: "chat",
      meta: {},
      events: Array.from({ length: 30 }, (_, index) => ({
        id: `e${index}`,
        actor: "assistant",
        kind: "tool_call",
        name: "inspect",
        inputRef: 0,
      })),
    },
  };
  const text = JSON.stringify(document);
  expect(text.length).toBeLessThan(2 * 1024 * 1024);
  expect(() => parse(text)).toThrow("readable event size limit");
  document.session.events.length = 2;
  expect(parse(JSON.stringify(document)).session.events).toHaveLength(2);
});

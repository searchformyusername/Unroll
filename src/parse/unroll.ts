import type { Actor, EventKind, ParseResult, Usage } from "./types.ts";
import {
  assertNestingDepth,
  Builder,
  idOf,
  isObj,
  num,
  ParseError,
  str,
  type Rec,
} from "./util.ts";
const actors = new Set(["user", "assistant", "tool", "system"]);
const kinds = new Set([
  "message",
  "thinking",
  "tool_call",
  "tool_result",
  "usage",
  "meta",
  "unknown",
]);
/** Reopen a clearly labeled normalized export, without interpreting it as a vendor's original file. */
export function parseUnroll(doc: Rec, b: Builder): ParseResult {
  if (!isObj(doc.session) || !Array.isArray(doc.session.events))
    throw new ParseError(
      "unknown_format",
      "This normalized Unroll export has no session events array. Export the original run again.",
    );
  const session = doc.session;
  const fail = (detail: string): never => {
    throw new ParseError(
      "unknown_format",
      `This normalized Unroll export ${detail}. Download it again from the original trajectory.`,
    );
  };
  if (
    doc.sourceRecords !== undefined &&
    (!Array.isArray(doc.sourceRecords) ||
      doc.sourceRecords.some((record) => typeof record !== "string"))
  )
    fail("has an invalid source records table");
  const records = Array.isArray(doc.sourceRecords)
    ? (doc.sourceRecords as string[])
    : [];
  const decoded = new Map<number, object>();
  const decode = (index: unknown, referenceField: string): object => {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= records.length
    )
      return fail(`has an invalid ${referenceField} source reference`);
    if (decoded.has(index)) return decoded.get(index)!;
    let value: unknown;
    try {
      value = JSON.parse(records[index]);
    } catch {
      return fail(`has invalid JSON in source record ${index + 1}`);
    }
    // Decoding is lazy, but every used record crosses the same explicit safety boundary
    // as a document or string-encoded tool argument. Never fall back to lost inline data.
    assertNestingDepth(value, `Normalized source record ${index + 1}`);
    if (typeof value !== "object" || value === null)
      return fail(`has a non-object source record ${index + 1}`);
    decoded.set(index, value);
    return value;
  };
  const resolve = (owner: Rec, field: string): unknown => {
    const referenceField = field + "Ref";
    if (!Object.prototype.hasOwnProperty.call(owner, referenceField))
      return owner[field];
    if (Object.prototype.hasOwnProperty.call(owner, field))
      return fail(`has both inline ${field} and a source reference`);
    return decode(owner[referenceField], referenceField);
  };
  if (session.meta !== undefined && !isObj(session.meta))
    fail("has invalid session metadata");
  if (session.metadataRefs !== undefined && !isObj(session.metadataRefs))
    fail("has invalid metadata source references");
  const inlineMetadata = isObj(session.meta) ? session.meta : {};
  const metadata = Object.fromEntries([
    ...Object.entries(inlineMetadata),
    ...Object.entries(
      isObj(session.metadataRefs) ? session.metadataRefs : {},
    ).map(([field, index]) => {
      if (Object.prototype.hasOwnProperty.call(inlineMetadata, field))
        fail(
          "has both inline metadata and a source reference for the same field",
        );
      return [field, decode(index, "metadata")];
    }),
  ]);
  // Compact references must not let a small file expand into gigabytes of searchable
  // input/output. Raw records stay shared; only readable event payloads count here.
  let expandedCharacters = 0;
  const readableSize = (
    owner: Rec,
    field: string,
    payload: unknown,
  ): number => {
    const ref = owner[field + "Ref"];
    return typeof ref === "number"
      ? records[ref].length
      : JSON.stringify(payload)?.length || 0;
  };
  for (const [index, value] of (session.events as unknown[]).entries()) {
    if (
      !isObj(value) ||
      !actors.has(String(value.actor)) ||
      !kinds.has(String(value.kind))
    ) {
      b.diag(
        `Normalized event ${index + 1} has an invalid actor or kind; skipped.`,
      );
      continue;
    }
    const usage: Usage = {};
    if (isObj(value.usage))
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "total",
        "costUsd",
      ] as const) {
        const v = num(value.usage[key]);
        if (v !== undefined) usage[key] = v;
      }
    const input = resolve(value, "input"),
      output = resolve(value, "output");
    expandedCharacters +=
      (str(value.text)?.length || 0) +
      readableSize(value, "input", input) +
      readableSize(value, "output", output);
    if (expandedCharacters > 25 * 1024 * 1024)
      fail(
        "expands beyond the readable event size limit; use the original trajectory or a smaller export",
      );
    const event = b.push({
      id: idOf(value.id) || `event-${index + 1}`,
      actor: value.actor as Actor,
      kind: value.kind as EventKind,
      ts: str(value.ts),
      text: str(value.text),
      callId: idOf(value.callId),
      name: str(value.name),
      input,
      output,
      raw: resolve(value, "raw"),
      step: num(value.step),
      usage: Object.keys(usage).length ? usage : undefined,
      isError: value.isError === true ? true : undefined,
      durationMs: num(value.durationMs),
      ttftMs: num(value.ttftMs),
      responseId: idOf(value.responseId),
    });
    const sourceStep = resolve(value, "sourceStep");
    if (sourceStep !== undefined) event.sourceStep = sourceStep;
    if (str(value.parentId)) event.parentId = str(value.parentId);
    if (value.offPath === true) event.offPath = true;
    if (value.sidechain === true) event.sidechain = true;
  }
  if (Array.isArray(doc.diagnostics))
    for (const value of doc.diagnostics)
      if (isObj(value) && str(value.reason))
        b.diag(value.reason as string, num(value.line));
  return b.finish(
    str(session.format) || "unroll",
    idOf(session.id),
    isObj(metadata) ? metadata : {},
  );
}

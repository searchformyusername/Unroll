import type { Run } from "./storage";
export interface TrajectoryExport {
  text: string;
  filename: string;
  mime: string;
  original: boolean;
}
export function exportTrajectory(run: Run): TrajectoryExport {
  const safe = (name: string) =>
    name.replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").slice(0, 160) ||
    "trajectory";
  if (run.originalText !== undefined) {
    const filename = safe(run.originalName || run.name);
    return {
      text: run.originalText,
      filename,
      mime: /\.(?:jsonl|ndjson)$/i.test(filename)
        ? "application/x-ndjson"
        : "application/json",
      original: true,
    };
  }
  // JSON strings keep source payloads at their original nesting depth. References preserve
  // shared step/record objects instead of repeating a whole step for every sibling event.
  const sourceRecords: string[] = [];
  const records = new Map<object, number>();
  const reference = (value: object): number => {
    const known = records.get(value);
    if (known !== undefined) return known;
    const index = sourceRecords.length;
    records.set(value, index);
    sourceRecords.push(JSON.stringify(value));
    return index;
  };
  const { meta, events, ...session } = run.session;
  // Normalization adds a metadata wrapper above the source. Encode its object values
  // separately so an accepted depth-200 source still fits the decoded-record guard.
  const metadataRefs: Record<string, number> = Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => typeof value === "object" && value !== null)
      .map(([field, value]) => [field, reference(value as object)]),
  );
  const inlineMeta = Object.fromEntries(
    Object.entries(meta).filter(
      ([, value]) => typeof value !== "object" || value === null,
    ),
  );
  const normalized = {
    ...session,
    meta: inlineMeta,
    metadataRefs,
    events: events.map((event) => {
      const encoded: Record<string, unknown> = { ...event };
      for (const field of ["raw", "sourceStep", "input", "output"] as const) {
        const value = event[field];
        if (typeof value !== "object" || value === null) continue;
        delete encoded[field];
        encoded[field + "Ref"] = reference(value);
      }
      return encoded;
    }),
  };
  return {
    text: JSON.stringify(
      {
        schema_version: "unroll-v1",
        sourceRecords,
        session: normalized,
        diagnostics: run.diagnostics,
      },
      null,
      2,
    ),
    filename:
      safe(run.name.replace(/\.(jsonl?|ndjson|traj)$/i, "")) + ".unroll.json",
    mime: "application/json",
    original: false,
  };
}
export function downloadTrajectory(run: Run): void {
  const exported = exportTrajectory(run);
  const url = URL.createObjectURL(
    new Blob([exported.text], { type: exported.mime + ";charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = exported.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

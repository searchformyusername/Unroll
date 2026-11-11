import type { Run } from "./storage";
export const MAX_BYTES = 25 * 1024 * 1024;
export function parseRun(
  text: string,
  name: string,
  bytes: number,
  signal: AbortSignal,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import.worker.ts", import.meta.url), {
      type: "module",
    });
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      worker.terminate();
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      done();
      reject(new DOMException("Import cancelled.", "AbortError"));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      done();
      reject(new Error("Parsing timed out. Try a smaller trajectory."));
    }, 30000);
    worker.onmessage = ({ data }) => {
      done();
      if (data.error) reject(new Error(data.error));
      else
        resolve({
          id: crypto.randomUUID(),
          name,
          bytes,
          importedAt: Date.now(),
          ...data.result,
        });
    };
    worker.onerror = () => {
      done();
      reject(
        new Error("The parser could not start. Please reload and try again."),
      );
    };
    worker.postMessage({ text });
  });
}
export async function fetchText(
  input: string,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number; name: string }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a complete http:// or https:// URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "Could not fetch this URL. Check the address and make sure the source allows browser access (CORS), or download the file and open it locally.",
    );
  }
  if (!response.ok)
    throw new Error(
      `The source returned HTTP ${response.status}. Check the URL or open a local file.`,
    );
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error(
      "This file is too large. The limit is 25 MB per trajectory.",
    );
  if (!response.body) throw new Error("The source returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          "This file is too large. The limit is 25 MB per trajectory.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let name = "Remote trajectory";
  try {
    name = decodeURIComponent(
      url.pathname.split("/").filter(Boolean).pop() || name,
    );
  } catch {
    /* Keep a safe fallback for malformed URL escapes. */
  }
  return { text, bytes, name };
}

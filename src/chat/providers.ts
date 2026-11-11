/** Native browser transports. No SDK telemetry, proxy, automatic retry, or provider-side history. */
export type Provider = "anthropic" | "openai" | "gemini";
export type ProviderConfig = { provider: Provider; apiKey: string; model: string };
export type ChatTurn = { role: "user" | "assistant"; content: string };
type ReplyInput = { system: string; messages: ChatTurn[] };
type ReplyOptions = { signal: AbortSignal; onText: (delta: string) => void; maxOutputTokens?: number };
type RecordValue = Record<string, unknown>;

const OUTPUT_TOKENS = 4096;
const MAX_FRAME_CHARS = 1_048_576;
const MAX_STREAM_BYTES = 16 * 1_048_576;
const MAX_TEXT_CHARS = 1_048_576;
const isObject = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
class SafeError extends Error {}
function fail(message: string): never { throw new SafeError(message); }
const aborted = () => new DOMException("Request cancelled.", "AbortError");
const incomplete = () => fail("The reply stream ended before completion. The partial reply may be incomplete; send again only if you want a new request.");
const truncated = () => fail("The reply reached its output limit and is incomplete. Ask a narrower question or request a continuation.");
const refused = () => fail("The provider declined or blocked this reply. Try rephrasing the question.");

function validate(config: ProviderConfig, input: ReplyInput): ProviderConfig {
  if (!config || !["anthropic", "openai", "gemini"].includes(config.provider)) fail("Choose a supported chat provider.");
  if (typeof config.apiKey !== "string" || !config.apiKey.trim()) fail("Enter an API key for this provider.");
  const apiKey = config.apiKey.trim();
  if (apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey)) fail("The API key contains invalid characters. Paste the key without quotes or line breaks.");
  if (typeof config.model !== "string") fail("Enter a model ID for this provider.");
  const model = config.provider === "gemini" ? config.model.trim().replace(/^models\//, "") : config.model.trim();
  const pattern = config.provider === "gemini" ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  if (!pattern.test(model)) fail("Enter a valid model ID, not a URL or endpoint.");
  if (!input || typeof input.system !== "string" || !Array.isArray(input.messages) || !input.messages.length || input.messages.some(turn => !turn || !["user", "assistant"].includes(turn.role) || typeof turn.content !== "string" || !turn.content.trim())) fail("The chat request must contain nonempty user or assistant messages.");
  return { provider: config.provider, apiKey, model };
}

function request(config: ProviderConfig, input: ReplyInput, maxOutputTokens: number): { url: string; headers: Record<string, string>; body: unknown } {
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (config.provider === "anthropic") return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { ...headers, "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: { model: config.model, max_tokens: maxOutputTokens, stream: true, system: input.system, messages: input.messages },
  };
  if (config.provider === "openai") return {
    url: "https://api.openai.com/v1/responses",
    headers: { ...headers, Authorization: `Bearer ${config.apiKey}` },
    body: { model: config.model, instructions: input.system, input: input.messages, max_output_tokens: maxOutputTokens, stream: true, store: false, truncation: "disabled", ...(config.model === "gpt-6-luna" ? { reasoning: { effort: "none" } } : {}) },
  };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`,
    headers: { ...headers, "x-goog-api-key": config.apiKey },
    body: {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: input.messages.map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })),
      generationConfig: { maxOutputTokens, candidateCount: 1 },
    },
  };
}

function httpFailure(status: number): never {
  if (status === 401 || status === 403) fail("Authentication or browser access was denied. Check the API key, project permissions, and provider browser-access settings.");
  if (status === 429) fail("The provider's rate or quota limit was reached. Check your account limits before sending another request.");
  if (status === 413) fail("The request context is too large for the provider. Reduce the included trajectory context.");
  if (status === 400 || status === 422) fail("The provider rejected this request. Check the model ID, supported options, and context length.");
  if (status === 404) fail("The requested model is unavailable. Check the model ID and your account's access.");
  if (status === 408 || status === 504) fail("The provider timed out. No retry was sent automatically.");
  if (status >= 500) fail("The provider is temporarily unavailable. No retry was sent automatically.");
  fail("The provider could not accept this request. Check your provider account and settings.");
}

/** Only known error codes influence wording. Provider messages, request IDs and payloads are never echoed. */
function streamFailure(value: unknown): never {
  const source = isObject(value) ? value : {};
  const nested = isObject(source.error) ? source.error : source;
  const code = typeof nested.code === "string" ? nested.code : typeof nested.type === "string" ? nested.type : typeof nested.status === "string" ? nested.status : "";
  if (["context_length_exceeded", "request_too_large", "CONTEXT_LENGTH_EXCEEDED"].includes(code)) fail("The provider's context limit was reached. Reduce the included trajectory context.");
  if (["rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "RESOURCE_EXHAUSTED"].includes(code)) httpFailure(429);
  if (["authentication_error", "invalid_api_key", "UNAUTHENTICATED", "PERMISSION_DENIED"].includes(code)) httpFailure(401);
  if (code === "overloaded_error") httpFailure(529);
  fail("The provider reported a streaming error. The partial reply may be incomplete; no retry was sent automatically.");
}

type Frame = { event: string; data: string };
/** A small SSE reader supporting split UTF-8, CRLF/LF/CR, multiline data, comments and bounded frames. */
async function consume(body: ReadableStream<Uint8Array>, signal: AbortSignal, onFrame: (frame: Frame) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", event = "", data: string[] = [], frameChars = 0, skipLF = false, bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const line = (value: string): boolean => {
    if (value === "") {
      const frame = { event, data: data.join("\n") };
      event = ""; data = []; frameChars = 0;
      return frame.data !== "" || frame.event === "error" ? onFrame(frame) : false;
    }
    frameChars += value.length;
    if (frameChars > MAX_FRAME_CHARS) fail("The provider sent a streaming event too large to read safely.");
    if (value.startsWith(":")) return false;
    const colon = value.indexOf(":"), field = colon === -1 ? value : value.slice(0, colon);
    let content = colon === -1 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") event = content;
    if (field === "data") data.push(content);
    return false;
  };
  try {
    while (true) {
      if (signal.aborted) throw aborted();
      const next = await reader.read();
      if (signal.aborted) throw aborted();
      let decoded: string;
      try { decoded = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }); }
      catch { fail("The provider sent invalid UTF-8 streaming data. The partial reply may be incomplete."); }
      bytes += next.value?.byteLength ?? 0;
      if (bytes > MAX_STREAM_BYTES) fail("The provider reply exceeded the safe streaming size limit.");
      buffer += decoded;
      if (skipLF && buffer.length) { if (buffer[0] === "\n") buffer = buffer.slice(1); skipLF = false; }
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== "\n" && buffer[index] !== "\r") continue;
        const value = buffer.slice(start, index);
        if (buffer[index] === "\r") {
          if (buffer[index + 1] === "\n") index++;
          else if (index === buffer.length - 1) skipLF = true;
        }
        start = index + 1;
        if (line(value)) return;
      }
      buffer = buffer.slice(start);
      if (buffer.length + frameChars > MAX_FRAME_CHARS) fail("The provider sent a streaming event too large to read safely.");
      if (next.done) { incomplete(); }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try { await reader.cancel(); } catch { /* transport cleanup must not replace the real outcome */ }
    reader.releaseLock();
  }
}

/**
 * Send exactly one request to the selected official endpoint. Partial deltas remain with the
 * caller on refusal/truncation/network failure, but the Promise never marks them complete.
 * Official schemas: OpenAI Responses streaming; Anthropic Messages SSE; Gemini streamGenerateContent.
 */
export async function streamReply(config: ProviderConfig, input: ReplyInput, options: ReplyOptions): Promise<{ finishReason?: string }> {
  const safe = validate(config, input);
  if (options.signal.aborted) throw aborted();
  const maxOutputTokens = options.maxOutputTokens ?? OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > OUTPUT_TOKENS) fail("Choose an output limit from 1 to 4096 tokens.");
  const transport = request(safe, input, maxOutputTokens);
  let finishReason: string | undefined, textChars = 0, anthropicStarted = false;
  const openaiParts = new Map<string, string>();
  const emit = (text: string) => {
    textChars += text.length;
    if (textChars > MAX_TEXT_CHARS) fail("The provider reply exceeded the safe text size limit.");
    if (text) options.onText(text);
  };
  const partKey = (value: RecordValue) => `${typeof value.output_index === "number" ? value.output_index : 0}:${typeof value.content_index === "number" ? value.content_index : 0}`;
  const completePart = (key: string, text: string) => {
    const previous = openaiParts.get(key) ?? "";
    if (!text.startsWith(previous)) fail("The provider returned inconsistent streamed text. The partial reply may be incomplete.");
    emit(text.slice(previous.length)); openaiParts.set(key, text);
  };
  const frame = ({ event, data }: Frame): boolean => {
    if (options.signal.aborted) throw aborted();
    if (data === "[DONE]") return false; // a generic sentinel alone does not prove a Responses message completed
    let value: unknown;
    try { value = JSON.parse(data); } catch { fail("The provider returned malformed streaming data. The partial reply may be incomplete."); }
    if (!isObject(value)) fail("The provider returned an unexpected streaming response.");
    if (event === "error" || value.type === "error" || value.error) streamFailure(value);
    if (safe.provider === "anthropic") {
      const type = value.type ?? event;
      if (type === "message_start") anthropicStarted = true;
      if (type === "content_block_start" && isObject(value.content_block) && value.content_block.type === "text") {
        if (typeof value.content_block.text !== "string") fail("The provider returned malformed text data.");
        emit(value.content_block.text);
      }
      if (type === "content_block_delta" && isObject(value.delta) && value.delta.type === "text_delta") {
        if (typeof value.delta.text !== "string") fail("The provider returned malformed text data.");
        emit(value.delta.text);
      }
      if (type === "message_delta" && isObject(value.delta) && value.delta.stop_reason != null) {
        const reason = value.delta.stop_reason;
        if (reason === "max_tokens") truncated();
        if (reason === "model_context_window_exceeded") fail("The provider's context limit ended this reply. Reduce the included trajectory context.");
        if (reason === "refusal") refused();
        if (reason !== "end_turn" && reason !== "stop_sequence") fail("The provider did not finish a text reply. The partial reply may be incomplete.");
        finishReason = reason;
      }
      if (type === "message_stop") {
        if (!anthropicStarted || !finishReason) incomplete();
        if (!textChars) fail("The provider completed without a readable text reply.");
        return true;
      }
    } else if (safe.provider === "openai") {
      const type = value.type ?? event;
      if (type === "response.refusal.delta" || type === "response.refusal.done" || (isObject(value.part) && value.part.type === "refusal")) refused();
      if (type === "response.output_text.delta") {
        if (typeof value.delta !== "string") fail("The provider returned malformed text data.");
        const key = partKey(value); openaiParts.set(key, (openaiParts.get(key) ?? "") + value.delta); emit(value.delta);
      }
      if (type === "response.output_text.done") {
        if (typeof value.text !== "string") fail("The provider returned malformed text data.");
        completePart(partKey(value), value.text);
      }
      if (type === "response.incomplete") {
        const response = isObject(value.response) ? value.response : {};
        const reason = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
        if (reason === "content_filter") refused();
        if (reason === "max_output_tokens") truncated();
        incomplete();
      }
      if (type === "response.failed") streamFailure(isObject(value.response) ? value.response : value);
      if (type === "response.completed") {
        const response = isObject(value.response) ? value.response : {};
        if (response.status !== "completed") incomplete();
        if (Array.isArray(response.output)) response.output.forEach((item, outputIndex) => {
          if (!isObject(item) || !Array.isArray(item.content)) return;
          item.content.forEach((part, contentIndex) => {
            if (!isObject(part)) return;
            if (part.type === "refusal") refused();
            if (part.type === "output_text" && typeof part.text === "string") completePart(`${outputIndex}:${contentIndex}`, part.text);
          });
        });
        if (!textChars) fail("The provider completed without a readable text reply.");
        finishReason = "completed"; return true;
      }
    } else {
      const feedback = isObject(value.promptFeedback) ? value.promptFeedback : undefined;
      if (feedback?.blockReason && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") refused();
      if (Array.isArray(feedback?.safetyRatings) && feedback.safetyRatings.some(rating => isObject(rating) && rating.blocked === true)) refused();
      const candidates = Array.isArray(value.candidates) ? value.candidates : [];
      const candidate = candidates.find(candidate => isObject(candidate) && (candidate.index === undefined || candidate.index === 0));
      if (!isObject(candidate)) return false;
      if (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some(rating => isObject(rating) && rating.blocked === true)) refused();
      const reason = candidate.finishReason;
      if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"].includes(String(reason))) refused();
      if (reason && reason !== "FINISH_REASON_UNSPECIFIED" && reason !== "STOP" && reason !== "MAX_TOKENS") incomplete();
      const content = isObject(candidate.content) ? candidate.content : {};
      if (Array.isArray(content.parts)) content.parts.forEach(part => {
        if (isObject(part) && part.thought !== true && typeof part.text === "string") emit(part.text);
      });
      if (reason === "MAX_TOKENS") truncated();
      if (reason === "STOP") {
        if (!textChars) fail("The provider completed without a readable text reply.");
        finishReason = "STOP"; return true;
      }
    }
    return false;
  };
  try {
    const response = await fetch(transport.url, {
      method: "POST", headers: transport.headers, body: JSON.stringify(transport.body), signal: options.signal,
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", mode: "cors",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      httpFailure(response.status);
    }
    if (!response.body) fail("The provider returned no reply stream.");
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      void response.body.cancel().catch(() => {});
      fail("The provider did not return a streaming response. Check the model and provider settings.");
    }
    await consume(response.body, options.signal, frame);
    return { finishReason };
  } catch (error) {
    if (options.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw aborted();
    if (error instanceof SafeError) throw error;
    fail("The provider connection was interrupted or blocked by the browser. Check connectivity and provider browser access; no retry was sent automatically.");
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamReply,
  type Provider,
  type ProviderConfig,
} from "../../src/chat/providers";

const KEY = "AQ.synthetic-only-not-a-real-key";
const PRIVATE = "confidential-synthetic-trajectory-sentinel";
const input = {
  system: PRIVATE,
  messages: [{ role: "user" as const, content: "What happened?" }],
};
const config = (provider: Provider): ProviderConfig => ({
  provider,
  apiKey: KEY,
  model: provider === "gemini" ? "gemini-test" : "test-model",
});
const frame = (value: unknown, event?: string) =>
  (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(value)}\n\n`;
const anthropic = (text = "Hello café 🧠") =>
  frame({ type: "message_start", message: { content: [] } }) +
  frame({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  }) +
  frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  frame({ type: "message_stop" });
const openai = (text = "Hello café 🧠") =>
  frame({
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: text,
  }) +
  frame({
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    text,
  }) +
  frame({
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    },
  });
const gemini = (text = "Hello café 🧠") =>
  frame({
    candidates: [
      { index: 0, content: { parts: [{ text }] }, finishReason: "STOP" },
    ],
  });
function response(text: string, chunkSize = 1024) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunkSize)
          controller.enqueue(bytes.slice(at, at + chunkSize));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}
function install(text: string, chunkSize?: number) {
  const fetch = vi.fn().mockResolvedValue(response(text, chunkSize));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function reply(
  provider: Provider,
  onText = vi.fn(),
  signal = new AbortController().signal,
) {
  const result = await streamReply(config(provider), input, { signal, onText });
  return { result, text: onText.mock.calls.map((call) => call[0]).join("") };
}
afterEach(() => vi.unstubAllGlobals());

describe("official streaming provider requests", () => {
  it.each([
    ["anthropic", anthropic, "end_turn"],
    ["openai", openai, "completed"],
    ["gemini", gemini, "STOP"],
  ] as const)(
    "streams %s through split UTF-8 and CRLF without duplicate done text",
    async (provider, make, finishReason) => {
      const fetch = install(make().replace(/\n/g, "\r\n"), 1);
      const output = await reply(provider);
      expect(output).toEqual({
        result: { finishReason },
        text: "Hello café 🧠",
      });
      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = fetch.mock.calls[0];
      expect(url).not.toContain(KEY);
      expect(url).not.toContain(PRIVATE);
      expect(options).toMatchObject({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        cache: "no-store",
        mode: "cors",
      });
      const body = JSON.parse(options.body);
      expect(body.temperature).toBeUndefined();
      if (provider === "anthropic") {
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(options.headers).toMatchObject({
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        });
        expect(body).toMatchObject({
          max_tokens: 4096,
          stream: true,
          system: PRIVATE,
          messages: input.messages,
        });
      } else if (provider === "openai") {
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(options.headers.Authorization).toBe(`Bearer ${KEY}`);
        expect(body).toMatchObject({
          store: false,
          max_output_tokens: 4096,
          stream: true,
          truncation: "disabled",
          instructions: PRIVATE,
          input: input.messages,
        });
      } else {
        expect(url).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
        );
        expect(options.headers["x-goog-api-key"]).toBe(KEY);
        expect(options.headers.Authorization).toBeUndefined();
        expect(body).toMatchObject({
          systemInstruction: { parts: [{ text: PRIVATE }] },
          contents: [{ role: "user", parts: [{ text: "What happened?" }] }],
          generationConfig: { maxOutputTokens: 4096, candidateCount: 1 },
        });
      }
    },
  );
  it("sends Gemini assistant history as model and accepts opaque auth keys without a prefix assumption", async () => {
    const fetch = install(gemini());
    await streamReply(
      {
        ...config("gemini"),
        apiKey: "opaque.auth-token",
        model: "models/gemini-test",
      },
      {
        ...input,
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
      },
      { signal: new AbortController().signal, onText: vi.fn() },
    );
    expect(
      JSON.parse(fetch.mock.calls[0][1].body).contents.map(
        (item: { role: string }) => item.role,
      ),
    ).toEqual(["user", "model", "user"]);
    expect(fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe(
      "opaque.auth-token",
    );
  });
  it("handles SSE comments, CR-only newlines, multiline data, and unknown event types", async () => {
    const data =
      ": ping\r\r" +
      'event: future-event\rdata: {"type":"future"}\r\r' +
      'data: {"type":"response.output_text.delta",\rdata: "delta":"safe text"}\r\r' +
      frame({
        type: "response.completed",
        response: { status: "completed" },
      }).replace(/\n/g, "\r");
    install(data, 2);
    expect((await reply("openai")).text).toBe("safe text");
  });
  it("fills text from done-only parts and excludes Gemini thought text", async () => {
    install(
      frame({
        type: "response.output_text.done",
        text: "first",
        output_index: 0,
        content_index: 0,
      }) +
        frame({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                content: [
                  { type: "output_text", text: "first" },
                  { type: "output_text", text: "second" },
                ],
              },
            ],
          },
        }),
    );
    expect((await reply("openai")).text).toBe("firstsecond");
    install(
      frame({
        candidates: [
          {
            content: {
              parts: [
                { text: "hidden thought", thought: true },
                { text: "answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );
    expect((await reply("gemini")).text).toBe("answer");
  });
});

describe("validation before any transmission", () => {
  it.each([
    { provider: "other", apiKey: KEY, model: "test" },
    { provider: "gemini", apiKey: "", model: "test" },
    { provider: "openai", apiKey: "secret\nInjected: yes", model: "test" },
    { provider: "anthropic", apiKey: KEY, model: "" },
    { provider: "gemini", apiKey: KEY, model: "test?key=secret" },
    { provider: "gemini", apiKey: KEY, model: "../evil" },
    { provider: "openai", apiKey: KEY, model: "https://proxy.example/model" },
  ])("rejects invalid config without calling fetch: %j", async (bad) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      streamReply(bad as ProviderConfig, input, {
        signal: new AbortController().signal,
        onText: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects empty or invalid messages before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const messages of [
      [],
      [{ role: "system", content: "bad" }],
      [{ role: "user", content: "" }],
    ])
      await expect(
        streamReply(config("openai"), { ...input, messages } as never, {
          signal: new AbortController().signal,
          onText: vi.fn(),
        }),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not send when already aborted and never exposes the abort reason", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort(KEY + PRIVATE);
    await expect(
      streamReply(config("gemini"), input, {
        signal: controller.signal,
        onText: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Request cancelled.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("failed, incomplete and refused replies", () => {
  it.each([
    [401, "Authentication"],
    [403, "Authentication"],
    [429, "quota"],
    [413, "context"],
    [400, "context"],
    [404, "model"],
    [504, "timed out"],
    [503, "unavailable"],
  ] as const)(
    "handles HTTP %s safely without retries or echoing the body",
    async (status, message) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(KEY + PRIVATE, { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(reply("openai")).rejects.toThrow(message);
      expect(fetch).toHaveBeenCalledOnce();
      try {
        await reply("openai");
      } catch (error) {
        expect(String(error)).not.toContain(KEY);
        expect(String(error)).not.toContain(PRIVATE);
      }
    },
  );
  it.each(["anthropic", "openai", "gemini"] as const)(
    "rejects a midstream error from %s without leaking its message",
    async (provider) => {
      install(
        frame(
          { type: "error", error: { code: "made_up", message: KEY + PRIVATE } },
          "error",
        ),
      );
      try {
        await reply(provider);
        throw new Error("Expected failure");
      } catch (error) {
        expect(String(error)).toContain("streaming error");
        expect(String(error)).not.toContain(KEY);
        expect(String(error)).not.toContain(PRIVATE);
      }
    },
  );
  it("maps known streaming context-limit errors without echoing provider text", async () => {
    install(
      frame({
        type: "response.failed",
        response: { error: { code: "context_length_exceeded", message: KEY } },
      }),
    );
    await expect(reply("openai")).rejects.toThrow("context limit");
  });
  it.each([
    [
      "anthropic",
      frame({ type: "message_start" }) +
        frame({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        }),
    ],
    [
      "openai",
      frame({ type: "response.output_text.delta", delta: "partial" }) +
        "data: [DONE]\n\n",
    ],
    [
      "gemini",
      frame({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }),
    ],
  ] as const)(
    "requires the real %s terminal event, even with partial text or [DONE]",
    async (provider, stream) => {
      install(stream);
      const onText = vi.fn();
      await expect(reply(provider, onText)).rejects.toThrow(
        "before completion",
      );
      expect(onText).toHaveBeenCalledWith("partial");
    },
  );
  it("does not accept an unterminated final SSE event as a complete reply", async () => {
    install(
      frame({ type: "response.output_text.delta", delta: "partial" }) +
        'data: {"type":"response.completed","response":{"status":"completed"}}',
    );
    await expect(reply("openai")).rejects.toThrow("before completion");
  });
  it.each([
    [
      "anthropic",
      frame({ type: "message_start" }) +
        frame({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        }) +
        frame({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    ],
    [
      "openai",
      frame({ type: "response.output_text.delta", delta: "partial" }) +
        frame({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
    ],
    [
      "gemini",
      frame({
        candidates: [
          {
            content: { parts: [{ text: "partial" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
    ],
  ] as const)(
    "marks %s output-limit completion as incomplete and preserves partial text",
    async (provider, stream) => {
      install(stream);
      const onText = vi.fn();
      await expect(reply(provider, onText)).rejects.toThrow("output limit");
      expect(onText).toHaveBeenCalledWith("partial");
    },
  );
  it.each([
    [
      "anthropic",
      frame({ type: "message_delta", delta: { stop_reason: "refusal" } }),
    ],
    ["openai", frame({ type: "response.refusal.delta", delta: KEY })],
    ["gemini", frame({ promptFeedback: { blockReason: "SAFETY" } })],
    [
      "gemini",
      frame({
        candidates: [
          {
            finishReason: "SAFETY",
            content: { parts: [{ text: "withheld" }] },
          },
        ],
      }),
    ],
  ] as const)(
    "handles %s refusal/safety without presenting blocked content as an answer",
    async (provider, stream) => {
      install(stream);
      const onText = vi.fn();
      await expect(reply(provider, onText)).rejects.toThrow(
        "declined or blocked",
      );
      expect(onText).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed JSON and inconsistent final text without echoing data", async () => {
    install(`data: {${KEY}${PRIVATE}\n\n`);
    await expect(reply("openai")).rejects.toThrow("malformed streaming");
    install(
      frame({ type: "response.output_text.delta", delta: "first" }) +
        frame({ type: "response.output_text.done", text: "different" }),
    );
    await expect(reply("openai")).rejects.toThrow("inconsistent");
  });
  it("handles missing bodies and non-stream responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    await expect(reply("openai")).rejects.toThrow("no reply stream");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(KEY + PRIVATE, {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(reply("openai")).rejects.toThrow("did not return a streaming");
  });
  it("redacts thrown network errors and aborts a pending reader cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(KEY + PRIVATE)));
    try {
      await reply("openai");
    } catch (error) {
      expect(String(error)).toContain("connection");
      expect(String(error)).not.toContain(KEY);
      expect(String(error)).not.toContain(PRIVATE);
    }
    let cancel = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancel = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    const controller = new AbortController();
    const pending = reply("openai", vi.fn(), controller.signal);
    controller.abort(KEY);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toBe(true);
  });
  it("rejects oversized unterminated frames instead of buffering without a bound", async () => {
    install("data: " + "x".repeat(1_048_577), 4000);
    await expect(reply("gemini")).rejects.toThrow("too large");
  });
});

describe("explicit inexpensive request budgets", () => {
  it.each(["anthropic", "openai", "gemini"] as const)(
    "uses an optional512-token output cap for %s",
    async (provider) => {
      const streams = { anthropic, openai, gemini };
      const fetch = install(streams[provider]());
      await streamReply(config(provider), input, {
        signal: new AbortController().signal,
        onText: vi.fn(),
        maxOutputTokens: 512,
      });
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(
        provider === "anthropic"
          ? body.max_tokens
          : provider === "openai"
            ? body.max_output_tokens
            : body.generationConfig.maxOutputTokens,
      ).toBe(512);
    },
  );
  it.each([0, -1, 4097, 1.5, NaN])(
    "rejects invalid output cap%s before fetch",
    async (maxOutputTokens) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        streamReply(config("openai"), input, {
          signal: new AbortController().signal,
          onText: vi.fn(),
          maxOutputTokens,
        }),
      ).rejects.toThrow("output limit");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("turns off reasoning only for the documented low-cost Luna default, leaving custom models unchanged", async () => {
    const fetch = install(openai());
    await streamReply({ ...config("openai"), model: "gpt-6-luna" }, input, {
      signal: new AbortController().signal,
      onText: vi.fn(),
      maxOutputTokens: 512,
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning).toEqual({
      effort: "none",
    });
    fetch.mockClear();
    fetch.mockResolvedValue(response(openai()));
    await streamReply({ ...config("openai"), model: "custom-model" }, input, {
      signal: new AbortController().signal,
      onText: vi.fn(),
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty(
      "reasoning",
    );
  });
  it("does not mislabel unknown incomplete reasons as output-token exhaustion", async () => {
    install(
      frame({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "future_reason" } },
      }),
    );
    await expect(reply("openai")).rejects.toThrow("before completion");
  });
  it("honors an explicit Gemini safety block even when a malformed stream claims STOP", async () => {
    install(
      frame({
        candidates: [
          {
            safetyRatings: [{ blocked: true }],
            finishReason: "STOP",
            content: { parts: [{ text: "blocked" }] },
          },
        ],
      }),
    );
    const onText = vi.fn();
    await expect(reply("gemini", onText)).rejects.toThrow(
      "declined or blocked",
    );
    expect(onText).not.toHaveBeenCalled();
  });
});

it("rejects invalid UTF-8 without silently replacing corrupted output characters", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xff]));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  );
  await expect(reply("openai")).rejects.toThrow("invalid UTF-8");
});

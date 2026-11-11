import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Run } from "../storage";
import { Content, Copy, Markdown } from "../reading";
import { downloadTrajectory } from "../download";
import { buildContext, contextLabel, prepareCorpus } from "./context";
import type { ContextScope } from "./types";
import { PROVIDERS, type ChatWorkspace } from "./useChatWorkspace";
import type { Provider } from "./providers";
import "./chat.css";

function WaitingDots() {
  return (
    <span className="chat-waiting" role="status" aria-label="Waiting for reply">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export default function ChatAgent({
  run,
  selectedId,
  visible,
  workspace,
  onEvent,
}: {
  run: Run;
  selectedId?: string | null;
  visible: boolean;
  workspace: ChatWorkspace;
  onEvent: (index: number) => void;
}) {
  const { provider, setProvider, configs, configure } = workspace;
  const config = configs[provider],
    thread = workspace.threads[run.id];
  const [settings, setSettings] = useState(!config.apiKey);
  const [reveal, setReveal] = useState(false);
  const [scope, setScope] = useState<ContextScope>("whole");
  const [customProviders, setCustomProviders] = useState<Set<Provider>>(
    new Set(),
  );
  const [reviewContext, setReviewContext] = useState(false);
  const [localError, setLocalError] = useState("");
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const savedScroll = useRef(0);
  const draft = thread?.draft || "";
  const deferredDraft = useDeferredValue(draft);
  const corpus = useMemo(() => prepareCorpus(run), [run]);
  const preview = useMemo(() => {
    try {
      return {
        packet: buildContext(
          corpus,
          scope,
          deferredDraft,
          selectedId || undefined,
        ),
        error: "",
      };
    } catch (error) {
      return {
        packet: undefined,
        error:
          error instanceof Error
            ? error.message
            : "Context could not be prepared.",
      };
    }
  }, [corpus, scope, deferredDraft, selectedId]);
  const busy = thread?.messages.some((m) => m.status === "streaming") || false;
  const providerInfo = PROVIDERS.find((p) => p.id === provider)!;
  const modelLabel = providerInfo.label;
  const modelChoice =
    !customProviders.has(provider) &&
    providerInfo.models.some((model) => model.id === config.model)
      ? config.model
      : "custom";
  const modelOptions = (
    <>
      {providerInfo.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
      <option value="custom">Custom model…</option>
    </>
  );
  function chooseModel(model: string) {
    setCustomProviders((previous) => {
      const next = new Set(previous);
      if (model === "custom") next.add(provider);
      else next.delete(provider);
      return next;
    });
    configure(provider, { model: model === "custom" ? "" : model });
    if (model === "custom") setSettings(true);
  }
  useEffect(() => {
    setLocalError("");
    stick.current = true;
    setFollow(true);
  }, [run.id]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!visible || !element) return;
    element.scrollTop = stick.current
      ? element.scrollHeight
      : savedScroll.current;
  }, [thread?.messages, visible, settings, reviewContext]);
  useEffect(() => {
    const element = scroll.current;
    if (!visible || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, run.id]);
  async function submit(question = draft, retryUserId?: string) {
    if (busy || !question.trim()) return;
    setLocalError("");
    if (!config.apiKey.trim()) {
      setSettings(true);
      setLocalError("Add your API key to start chatting.");
      return;
    }
    try {
      const old = retryUserId
        ? thread?.messages.find((m) => m.id === retryUserId)
        : undefined;
      const packet = buildContext(
        corpus,
        old?.context?.scope || scope,
        question,
        old ? old.context?.selectedEventId : selectedId || undefined,
      );
      stick.current = true;
      setFollow(true);
      await workspace.send(run.id, question, packet, retryUserId);
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "Could not send this message.",
      );
    }
  }
  const lastUser = [...(thread?.messages || [])]
    .reverse()
    .find((m) => m.role === "user");
  return (
    <div className="chat-agent" hidden={!visible}>
      <div className="chat-toolbar">
        <span
          className={`chat-connection ${config.apiKey ? "configured" : ""}`}
          title={
            config.apiKey
              ? "Key added; verified only when a request succeeds"
              : "No key added"
          }
        />
        <select
          className="chat-model"
          aria-label="Chat model"
          title={config.model}
          value={modelChoice}
          onChange={(event) => chooseModel(event.target.value)}
        >
          {modelOptions}
        </select>
        <button
          className="icon-button"
          title={
            run.originalText !== undefined
              ? "Download original trajectory"
              : "Download normalized trajectory"
          }
          aria-label="Download trajectory"
          onClick={() => {
            try {
              downloadTrajectory(run);
            } catch {
              setLocalError(
                "The trajectory could not be downloaded. Please retry.",
              );
            }
          }}
        >
          <Download size={14} />
        </button>
        <button
          className="icon-button"
          title="Provider settings"
          aria-label="Configure Chat Agent"
          aria-expanded={settings}
          onClick={() => {
            setSettings(!settings);
            setReveal(false);
          }}
        >
          <Settings2 size={14} />
        </button>
      </div>
      {settings && (
        <div className="chat-settings">
          <div className="chat-settings-title">
            <KeyRound size={13} />
            <strong>Provider key</strong>
            <button
              className="icon-button"
              aria-label="Close provider settings"
              onClick={() => {
                setSettings(false);
                setReveal(false);
              }}
            >
              <X size={14} />
            </button>
          </div>
          <div className="chat-settings-fields">
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as Provider);
                  setReveal(false);
                }}
              >
                {PROVIDERS.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reply limit
              <select
                value={workspace.replyLimit}
                onChange={(event) =>
                  workspace.setReplyLimit(Number(event.target.value))
                }
              >
                <option value={512}>512 tokens</option>
                <option value={2048}>2,048 tokens</option>
                <option value={4096}>4,096 tokens</option>
              </select>
            </label>
          </div>
          {modelChoice === "custom" && (
            <label className="chat-key-label">
              Custom model ID
              <input
                aria-label="Custom model ID"
                value={config.model}
                onChange={(event) =>
                  configure(provider, { model: event.target.value })
                }
                autoComplete="off"
                spellCheck={false}
                placeholder="Provider model ID"
                maxLength={160}
              />
            </label>
          )}
          <label className="chat-key-label">
            API key
            <div className="chat-key-field">
              <input
                aria-label={`${modelLabel} API key`}
                type={reveal ? "text" : "password"}
                value={config.apiKey}
                onChange={(event) =>
                  configure(provider, { apiKey: event.target.value })
                }
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
                placeholder="Paste your API key"
              />
              <div className="chat-key-actions">
                <button
                  className="icon-button"
                  disabled={!config.apiKey}
                  aria-label={reveal ? "Hide API key" : "Show API key"}
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Clear ${modelLabel} API key`}
                  title="Remove key from this browser"
                  disabled={!config.apiKey && !workspace.hasSavedKey(provider)}
                  onClick={() => {
                    const cleared = workspace.clearKey(provider);
                    setReveal(false);
                    setLocalError(
                      cleared
                        ? ""
                        : "Could not remove the saved key. Check browser storage access and try again.",
                    );
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </label>
          <p>
            {workspace.keySaved(provider)
              ? "Saved on this browser · unencrypted."
              : "Save on this browser · unencrypted."}
          </p>
          <div className="chat-settings-actions">
            <button
              className="chat-use-key"
              disabled={!config.apiKey.trim() || !config.model.trim()}
              onClick={() => {
                if (!workspace.saveKey(provider)) {
                  setLocalError(
                    "Could not save the key. Check for spaces or line breaks and browser storage access.",
                  );
                  return;
                }
                setLocalError("");
                setSettings(false);
                setReveal(false);
                composer.current?.focus();
              }}
            >
              <Check size={12} /> Save key
            </button>
          </div>
        </div>
      )}
      <div
        className="chat-messages"
        ref={scroll}
        role="log"
        aria-label={`Chat about ${run.name}`}
        aria-relevant="additions"
        onScroll={() => {
          const element = scroll.current;
          if (!element || !visible || !element.clientHeight) return;
          savedScroll.current = element.scrollTop;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            70;
          setFollow(stick.current);
        }}
      >
        {!workspace.loaded[run.id] ? (
          <p className="chat-muted" role="status">
            Loading conversation…
          </p>
        ) : !thread?.messages.length ? (
          <div className="chat-empty">
            <h3>Ask about this trajectory</h3>
            <p>
              Compare steps, inspect a tool result, or make sense of the run.
            </p>
            <div className="chat-prompts">
              {[
                "Summarize this run",
                "Where did errors occur?",
                "Explain the selected step",
              ].map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    workspace.setDraft(run.id, prompt);
                    if (prompt.includes("selected")) setScope("step");
                    composer.current?.focus();
                  }}
                >
                  {prompt}
                  <ArrowUp size={12} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          thread.messages.map((message, index) => (
            <article
              key={message.id}
              className={`chat-message ${message.role} ${message.status}`}
            >
              <div className="chat-message-label">
                <strong>
                  {message.role === "user" ? "You" : "Chat Agent"}
                </strong>
                {message.role === "assistant" && (
                  <span title={message.model}>
                    {PROVIDERS.find((p) => p.id === message.provider)?.label}
                  </span>
                )}
                {message.status === "complete" && message.content && (
                  <Copy text={message.content} />
                )}
              </div>
              {message.content ? (
                message.role === "assistant" ? (
                  <div className="prose chat-prose">
                    <Markdown text={message.content} onEvent={onEvent} />
                  </div>
                ) : (
                  <p className="chat-user-text">{message.content}</p>
                )
              ) : message.status === "streaming" ? (
                <WaitingDots />
              ) : null}
              {message.context && (
                <small className="chat-sent-context">
                  {message.context.scope === "whole"
                    ? "Whole run"
                    : message.context.scope === "step"
                      ? "Selected step"
                      : "Relevant context"}{" "}
                  · {contextLabel(message.context)}
                </small>
              )}
              {(message.status === "error" || message.status === "stopped") && (
                <div className="chat-recovery">
                  <p role={message.status === "error" ? "alert" : undefined}>
                    {message.error}
                    {message.content && message.status === "error"
                      ? " Text above is incomplete."
                      : ""}
                  </p>
                  {index === thread.messages.length - 1 && lastUser && (
                    <button
                      disabled={busy}
                      onClick={() => void submit(lastUser.content, lastUser.id)}
                    >
                      <RotateCcw size={12} /> Retry
                    </button>
                  )}
                </div>
              )}
              {message.status === "streaming" && message.content && (
                <span className="chat-stream-status" role="status">
                  Generating…
                </span>
              )}
            </article>
          ))
        )}
      </div>
      {!follow && (
        <button
          className="chat-latest"
          onClick={() => {
            stick.current = true;
            setFollow(true);
            if (scroll.current)
              scroll.current.scrollTop = scroll.current.scrollHeight;
          }}
        >
          Latest reply <ArrowDown size={12} />
        </button>
      )}
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="chat-context-row">
          <select
            aria-label="Chat context"
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value as ContextScope)}
          >
            <option value="relevant">Relevant events</option>
            <option value="whole">Whole run</option>
            <option value="step">Selected step</option>
          </select>
          <span title="Includes the run overview and source-scoped metrics">
            {preview.packet
              ? contextLabel(preview.packet)
              : "Context unavailable"}
          </span>
        </div>
        <details
          className="chat-context-preview"
          onToggle={(event) => setReviewContext(event.currentTarget.open)}
        >
          <summary>Review context</summary>
          <p>
            Readable event content and source-scoped metrics; raw source
            extensions and embedded media are excluded. Relevant context is
            selected locally from your question. Each request also includes up
            to 30 recent chat messages (80,000 characters).
          </p>
          {reviewContext && preview.packet && (
            <Content text={preview.packet.text} />
          )}
        </details>
        <div className="chat-input-wrap">
          <textarea
            ref={composer}
            aria-label="Message Chat Agent"
            placeholder="Ask about this trajectory…"
            value={draft}
            maxLength={12_000}
            rows={3}
            disabled={!workspace.loaded[run.id]}
            onChange={(event) => workspace.setDraft(run.id, event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            className={`chat-send ${busy ? "stop" : ""}`}
            type={busy ? "button" : "submit"}
            aria-label={busy ? "Stop reply" : "Send message"}
            title={busy ? "Stop reply" : "Send · Enter"}
            disabled={
              !busy &&
              (!draft.trim() || !workspace.loaded[run.id] || !!preview.error)
            }
            onClick={busy ? () => workspace.stop(run.id) : undefined}
          >
            {busy ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </div>
        {(localError || preview.error) && (
          <p className="chat-error" role="alert">
            {localError || preview.error}
          </p>
        )}
        {workspace.storageError && (
          <p className="chat-error">
            Conversation storage is unavailable. Keep this tab open to retain
            the chat.
          </p>
        )}
        <div className="chat-compose-note">
          <span>
            {config.apiKey
              ? `Messages + context → ${modelLabel} · API charges apply`
              : "Add an API key in settings to send"}
          </span>
          <span>⇧ Enter for newline</span>
        </div>
      </form>
    </div>
  );
}

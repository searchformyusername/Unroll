import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy as CopyIcon, FileText, Info } from "lucide-react";
import {
  excerptAround,
  findRanges,
  firstMatch,
  fold,
  type Folded,
} from "./analyze";

export const stringify = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");

/** Most <mark> elements one view will render. Keeps a pathological query ("e" in 5 MB) from flooding the DOM. */
const MAX_MARKS = 5000;
/** Characters shown per "Show more" step in the reading pane, and in a compact inline preview. */
const PAGE = 40_000;
const COMPACT = 6000;
/** How far a clip edge may move to land on a line break. */
const SNAP = 2000;
/** Context kept before a match when the view has to start mid-text. */
const LEAD = 1000;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text` with <mark> around each [start, end) range. Ranges are in `text` coordinates, sorted, non-overlapping. */
function withMarks(text: string, ranges: [number, number][]): ReactNode {
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let n = 0; n < ranges.length; n++) {
    const [a, b] = ranges[n];
    if (a > from) parts.push(text.slice(from, a));
    parts.push(<mark key={n}>{text.slice(a, b)}</mark>);
    from = b;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Literal, case-insensitive highlighting. The marked text is always a slice of the original
 * string, so casing is preserved and matches stay aligned after characters such as "İ" whose
 * lowercase form has a different length.
 */
export const Highlight = memo(function Highlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const ranges = useMemo(
    () => (query ? findRanges(fold(text), query, { limit: MAX_MARKS }) : []),
    [text, query],
  );
  return <>{withMarks(text, ranges)}</>;
});

/** One-line excerpt of `text`, centered on the first match of `query` when there is one. */
export function excerpt(text: string, query: string, max = 180): string {
  const at = query ? firstMatch(fold(text), query) : -1;
  return excerptAround(text, at < 0 ? 0 : at, max);
}

/**
 * The part of a long text to render: at most `cap` characters, containing the match when there
 * is one. Both edges move to a nearby line break when one is within reach, so the view does
 * not open or close on half a line, and neither edge ever splits a surrogate pair.
 */
export function clipWindow(
  text: string,
  match: number,
  matchLength: number,
  cap: number,
): { start: number; end: number } {
  const length = text.length;
  if (length <= cap) return { start: 0, end: length };
  let start = 0;
  if (match >= 0 && match + matchLength > cap) {
    start = Math.max(0, match - LEAD);
    const lineBreak = text.lastIndexOf("\n", start);
    if (lineBreak >= 0 && start - lineBreak <= SNAP) start = lineBreak + 1;
    else if (isLowSurrogate(text.charCodeAt(start))) start--;
  }
  let end = Math.min(length, start + cap);
  if (end < length) {
    const matchEnd = match >= start ? match + matchLength : start;
    const lineBreak = text.lastIndexOf("\n", end);
    if (lineBreak > start && lineBreak >= matchEnd && end - lineBreak <= SNAP)
      end = lineBreak;
    else if (isLowSurrogate(text.charCodeAt(end))) end--;
  }
  return { start, end };
}

/** True when `offset` falls inside a fenced code block, so a clipped view can keep it rendering as code. */
export function insideFence(text: string, offset: number): boolean {
  if (offset <= 0) return false;
  const fence = /^ {0,3}(?:```|~~~)/gm;
  let open = false;
  for (let m = fence.exec(text); m && m.index < offset; m = fence.exec(text))
    open = !open;
  return open;
}

type HNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
};

/**
 * rehype plugin: wraps matches in <mark> inside text nodes only, so Markdown structure is
 * untouched. Raw HTML from the source is turned into a plain text node first (exactly what
 * react-markdown does with it afterwards), so it can be highlighted and is still never executed.
 */
function highlighter(query: string) {
  return () => (tree: HNode) => {
    if (!query) return;
    let budget = MAX_MARKS;
    const walk = (node: HNode) => {
      if (!node.children || node.tagName === "mark") return;
      const next: HNode[] = [];
      for (const child of node.children) {
        const literal = child.type === "text" || child.type === "raw";
        if (!literal || !child.value || budget <= 0) {
          if (!literal) walk(child);
          next.push(child);
          continue;
        }
        const text = child.value;
        const ranges = findRanges(fold(text), query, { limit: budget });
        if (!ranges.length) {
          next.push(child);
          continue;
        }
        budget -= ranges.length;
        let from = 0;
        for (const [a, b] of ranges) {
          if (a > from) next.push({ type: "text", value: text.slice(from, a) });
          next.push({
            type: "element",
            tagName: "mark",
            properties: {},
            children: [{ type: "text", value: text.slice(a, b) }],
          });
          from = b;
        }
        if (from < text.length)
          next.push({ type: "text", value: text.slice(from) });
      }
      node.children = next;
    };
    walk(tree);
  };
}

const MARKDOWN_COMPONENTS = {
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Remote images are never requested: the trajectory decides nothing about what this page loads.
  img: ({ alt }: { alt?: string }) => (
    <span className="attachment">
      <FileText size={13} />
      Image attachment{alt ? `: ${alt}` : ""}
    </span>
  ),
};
const REMARK_PLUGINS = [remarkGfm];

/** Markdown for messages and reasoning. Memoized: parsing runs again only when the text or query changes. */
export const Markdown = memo(function Markdown({
  text,
  query = "",
}: {
  text: string;
  query?: string;
}) {
  const plugins = useMemo(() => [highlighter(query)], [query]);
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={plugins}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});

export function Copy({ text }: { text: string }) {
  const [state, setState] = useState("Copy");
  const copy = () =>
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setState("Copied");
        setTimeout(() => setState("Copy"), 1800);
      })
      .catch(() => {
        setState("Copy failed");
        setTimeout(() => setState("Copy"), 2200);
      });
  return (
    <button
      className="quiet-button copy-button"
      aria-label={state}
      onClick={copy}
    >
      {state === "Copied" ? <Check size={13} /> : <CopyIcon size={13} />}
      <span>{state}</span>
    </button>
  );
}

/**
 * Event content, rendered in bounded pieces. Tool output stays literal (<pre>); only messages
 * and reasoning go through Markdown. With a search active the view opens on the first match,
 * wherever it is in the text. Lowercasing and match finding are memoized per text and query,
 * so re-renders and keystrokes on other parts of the page do no work here.
 */
export const Content = memo(function Content({
  text,
  query = "",
  markdown = false,
  compact = false,
}: {
  text: string;
  query?: string;
  markdown?: boolean;
  compact?: boolean;
}) {
  // "Show more" progress belongs to one text; a different event starts again at one page.
  const [more, setMore] = useState<{ text: string; pages: number }>({
    text,
    pages: 1,
  });
  const pages = more.text === text ? more.pages : 1;
  const cap = compact ? COMPACT : PAGE * pages;
  const searching = query !== "";

  const folded: Folded | undefined = useMemo(
    () => (searching ? fold(text) : undefined),
    [text, searching],
  );
  const match = useMemo(
    () => (folded ? firstMatch(folded, query) : -1),
    [folded, query],
  );
  const { start, end } = useMemo(
    () => clipWindow(text, match, query.length, cap),
    [text, match, query.length, cap],
  );

  const body = useMemo(() => {
    const part =
      start === 0 && end === text.length ? text : text.slice(start, end);
    if (markdown) {
      // A view that opens inside a fenced block keeps rendering as code instead of as stray prose.
      return (
        <Markdown
          text={start > 0 && insideFence(text, start) ? "```\n" + part : part}
          query={query}
        />
      );
    }
    if (!folded) return <pre>{part}</pre>;
    const ranges = findRanges(folded, query, {
      from: start,
      to: end,
      limit: MAX_MARKS,
    });
    return (
      <pre>
        {withMarks(
          part,
          start
            ? ranges.map(([a, b]) => [a - start, b - start] as [number, number])
            : ranges,
        )}
      </pre>
    );
  }, [text, start, end, markdown, folded, query]);

  return (
    <>
      <div className={markdown ? "prose" : "plain-output"}>
        {start > 0 && (
          <div className="clip-note">
            Showing content around the search match · character{" "}
            {start.toLocaleString()}
          </div>
        )}
        {body}
      </div>
      {end < text.length && (
        <div className="content-limit">
          <Info size={13} />
          <span>
            {compact
              ? "Preview truncated. Select the event to read more."
              : `${end.toLocaleString()} of ${text.length.toLocaleString()} characters`}
          </span>
          {!compact && (
            <button
              className="text-button"
              onClick={() => setMore({ text, pages: pages + 1 })}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </>
  );
});

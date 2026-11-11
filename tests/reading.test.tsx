import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clipWindow,
  Content,
  excerpt,
  Highlight,
  insideFence,
  Markdown,
} from "../src/reading";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const marks = (markup: string) =>
  [...markup.matchAll(/<mark>(.*?)<\/mark>/gs)].map((m) => m[1]);
/** A lone surrogate means a character was cut in half. */
const brokenSurrogate =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("visible search matches and safe reading", () => {
  it("highlights literal, case-insensitive terms without treating them as regex", () => {
    expect(html(<Highlight text="a.b A.B aXb" query="a.b" />)).toBe(
      "<mark>a.b</mark> <mark>A.B</mark> aXb",
    );
    expect(html(<Highlight text="cost (USD) [x]*" query="(usd) [x]*" />)).toBe(
      "cost <mark>(USD) [x]*</mark>",
    );
    expect(html(<Highlight text="nothing to mark" query="" />)).toBe(
      "nothing to mark",
    );
  });

  it("centers a compact excerpt on a match deep inside an output", () => {
    const text = "a".repeat(10000) + "unique needle" + "b".repeat(10000);
    expect(excerpt(text, "needle", 180)).toContain("unique needle");
    expect(excerpt(text, "needle", 180).length).toBeLessThan(190);
    expect(excerpt("Short Text", "", 180)).toBe("Short Text");
    expect(excerpt("A  spaced\n\nvalue", "absent", 180)).toBe("A spaced value");
  });

  it("highlights prose, code and arguments without removing Markdown structure", () => {
    const out = html(
      <Markdown
        text={'**Needle** in prose\n\n```json\n{"path":"needle.txt"}\n```'}
        query="needle"
      />,
    );
    expect(out).toContain("<strong><mark>Needle</mark></strong>");
    expect(out).toContain('<pre><code class="language-json">');
    expect(out).toContain("<mark>needle</mark>.txt");
  });

  it("shows a search match beyond the normal 40k output preview", () => {
    const out = html(
      <Content
        text={"a".repeat(50000) + "findme" + "b".repeat(100)}
        query="findme"
      />,
    );
    expect(out).toContain("<mark>findme</mark>");
    expect(out).toContain("Showing content around the search match");
  });

  it("does not load remote images, execute raw HTML, or preserve javascript links", () => {
    const source =
      '![secret](https://tracker.invalid/private)\n\n<script>alert(1)</script>\n\n<img src="https://tracker.invalid/pixel.gif">\n\n[click](javascript:alert(1))';
    for (const query of ["", "alert", "tracker", "script"]) {
      const out = html(<Markdown text={source} query={query} />);
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<script");
      expect(out).not.toContain('href="javascript:');
      expect(out).not.toMatch(/(src|href)="https:\/\/tracker\.invalid/);
    }
    // Raw HTML stays visible as escaped text and can be searched like any other text.
    const searched = html(<Markdown text={source} query="alert" />);
    expect(searched).toContain(
      "&lt;script&gt;<mark>alert</mark>(1)&lt;/script&gt;",
    );
  });

  it("keeps tool output as literal source instead of interpreting Markdown", () => {
    const out = html(
      <Content text={"# header\n*glob*\n<script>nope</script>"} />,
    );
    expect(out).toContain("# header\n*glob*");
    expect(out).toContain("&lt;script&gt;nope&lt;/script&gt;");
    expect(out).not.toContain("<h1>");
    const searched = html(
      <Content text={"# header\n*GLOB*\n<script>nope</script>"} query="glob" />,
    );
    expect(searched).toContain(
      "# header\n*<mark>GLOB</mark>*\n&lt;script&gt;nope&lt;/script&gt;",
    );
    expect(searched).not.toContain("<em>");
  });
});

describe("highlighting keeps the source text exactly", () => {
  it("marks the original casing, not the lowercased query", () => {
    expect(
      marks(html(<Highlight text="Error, ERROR and error" query="error" />)),
    ).toEqual(["Error", "ERROR", "error"]);
    expect(
      marks(
        html(<Content text="FAIL src/B.test.ts: Timeout" query="timeout" />),
      ),
    ).toEqual(["Timeout"]);
    expect(
      marks(html(<Markdown text="A **Timeout** occurred" query="TIMEOUT" />)),
    ).toEqual(["Timeout"]);
  });

  it("stays aligned after İ, whose lowercase form is longer", () => {
    const text = "İstanbul İzmir: Error near İ";
    expect(text.toLowerCase().length).toBeGreaterThan(text.length);
    expect(html(<Highlight text={text} query="error" />)).toBe(
      "İstanbul İzmir: <mark>Error</mark> near İ",
    );
    expect(html(<Content text={text} query="error" />)).toContain(
      "İstanbul İzmir: <mark>Error</mark> near İ",
    );
    expect(html(<Markdown text={text} query="near" />)).toContain(
      "Error <mark>near</mark> İ",
    );
    expect(marks(html(<Highlight text={text} query="İzmir" />))).toEqual([
      "İzmir",
    ]);
  });

  it("matches Greek regardless of final sigma, and leaves emoji and CJK intact", () => {
    expect(
      marks(html(<Highlight text="ΟΔΟΣ και οδός" query="οδοσ" />)),
    ).toEqual(["ΟΔΟΣ"]);
    expect(marks(html(<Highlight text="ΟΔΟΣ" query="οδος" />))).toEqual([
      "ΟΔΟΣ",
    ]);
    expect(html(<Highlight text="done 👋 你好 DONE 👋" query="done" />)).toBe(
      "<mark>done</mark> 👋 你好 <mark>DONE</mark> 👋",
    );
    // a mark never stops inside one visible character: skin tones, joined emoji and combining accents stay whole
    expect(html(<Highlight text="👋🏽 wave 👋" query="👋" />)).toBe(
      "<mark>👋🏽</mark> wave <mark>👋</mark>",
    );
    expect(marks(html(<Highlight text="family 👨‍👩‍👧 here" query="👨" />))).toEqual(
      ["👨‍👩‍👧"],
    );
    expect(
      marks(html(<Highlight text={"cafe\u0301 and CAFE"} query="cafe" />)),
    ).toEqual(["cafe\u0301", "CAFE"]);
    expect(
      marks(html(<Highlight text="plain cafe latte" query="cafe" />)),
    ).toEqual(["cafe"]);
    expect(
      marks(html(<Markdown text="你好，世界。Hello 世界" query="世界" />)),
    ).toEqual(["世界", "世界"]);
  });

  it("keeps marks on the right characters inside a clipped window that follows an İ", () => {
    const text =
      "İ line\n".repeat(12_000) + "the Needle is here\n" + "tail\n".repeat(10);
    const out = html(<Content text={text} query="needle" />);
    expect(marks(out)).toEqual(["Needle"]);
    expect(out).toContain("the <mark>Needle</mark> is here");
    expect(out).toContain("Showing content around the search match");
  });
});

describe("clipping is bounded and lands on line breaks", () => {
  const lines = Array.from(
    { length: 4000 },
    (_, i) => `line ${i} of ordinary output`,
  ).join("\n"); // ~110k chars

  it("returns the whole text when it fits", () => {
    expect(clipWindow("short", -1, 0, 40_000)).toEqual({ start: 0, end: 5 });
    expect(html(<Content text="short" />)).not.toContain("content-limit");
  });

  it("ends on a line break instead of mid-line", () => {
    const { start, end } = clipWindow(lines, -1, 0, 40_000);
    expect(start).toBe(0);
    expect(end).toBeLessThanOrEqual(40_000);
    expect(end).toBeGreaterThan(38_000);
    expect(lines[end]).toBe("\n");
    const out = html(<Content text={lines} />);
    expect(out).toMatch(/line \d+ of ordinary output<\/pre>/); // last visible line is complete
    expect(out).toContain(
      `${end.toLocaleString()} of ${lines.length.toLocaleString()} characters`,
    );
  });

  it("opens on the start of a line near the match and always contains the match", () => {
    const at = lines.indexOf("line 3500 of");
    const { start, end } = clipWindow(lines, at, 9, 40_000);
    expect(start).toBeGreaterThan(0);
    expect(lines[start - 1]).toBe("\n");
    expect(at).toBeGreaterThanOrEqual(start);
    expect(at + 9).toBeLessThanOrEqual(end);
    expect(end - start).toBeLessThanOrEqual(40_000);
    const compact = clipWindow(lines, at, 9, 6000);
    expect(at).toBeGreaterThanOrEqual(compact.start);
    expect(at + 9).toBeLessThanOrEqual(compact.end);
    expect(compact.end - compact.start).toBeLessThanOrEqual(6000);
  });

  it("falls back to a plain cut when there are no line breaks, without splitting a character", () => {
    const minified = '{"k":"' + "👋".repeat(40_000) + '"}';
    for (const match of [-1, 50_001, 50_002, 70_003]) {
      const { start, end } = clipWindow(minified, match, 2, 40_000);
      expect(end - start).toBeLessThanOrEqual(40_000);
      expect(minified.slice(start, end)).not.toMatch(brokenSurrogate);
    }
    expect(html(<Content text={minified} query="" />)).not.toMatch(
      brokenSurrogate,
    );
  });

  it("keeps the render bounded however large the text or however common the query", () => {
    const big = "e ".repeat(600_000); // 1.2 MB, 600k matches
    const out = html(<Content text={big} query="e" />);
    expect(marks(out).length).toBe(5000);
    expect(out.length).toBeLessThan(200_000);
    const compact = html(<Content text={big} compact />);
    expect(compact.length).toBeLessThan(7000);
    expect(compact).toContain("Preview truncated");
    expect(
      marks(html(<Markdown text={"e ".repeat(20_000)} query="e" />)).length,
    ).toBe(5000);
  });

  it("keeps code rendering as code when a clipped Markdown view opens inside a fenced block", () => {
    const text =
      "Intro paragraph.\n\n```ts\n" +
      "const filler = 1;\n".repeat(4000) +
      'const target = "NEEDLE";\n```\n\nAfter the block.';
    expect(insideFence(text, text.indexOf("NEEDLE"))).toBe(true);
    expect(insideFence(text, text.indexOf("After"))).toBe(false);
    expect(insideFence(text, 5)).toBe(false);
    const out = html(<Content text={text} query="needle" markdown />);
    expect(out).toContain("Showing content around the search match");
    expect(out).toMatch(/<pre><code>const filler = 1;/);
    expect(out).toContain("&quot;<mark>NEEDLE</mark>&quot;");
    expect(out).toContain("<p>After the block.</p>");
  });
});

/**
 * Case-insensitive matching that reports positions in the ORIGINAL text.
 *
 * `text.toLowerCase()` is not always the same length as `text` (İ becomes two code units),
 * so positions found in a lowercased copy cannot be applied to the original blindly.
 * fold() lowercases once and keeps an offset map only in that rare case; every search
 * after that is a plain indexOf with no further allocation.
 */
export interface Folded {
  text: string;
  /** Lowercased text, with final sigma (ς) folded to σ so Greek matches regardless of word position. */
  lower: string;
  /** Present only when lowercasing changed the length: lower offset → offset in `text`. */
  map?: Int32Array;
}

const FINAL_SIGMA = /ς/g;
const foldSigma = (s: string) => (s.includes('ς') ? s.replace(FINAL_SIGMA, 'σ') : s);

export function foldQuery(query: string): string {
  return foldSigma(query.toLowerCase());
}

export function fold(text: string): Folded {
  const lower = text.toLowerCase();
  // No character gets shorter when lowercased, so equal length means offsets line up one to one.
  if (lower.length === text.length) return { text, lower: foldSigma(lower) };
  const offsets: number[] = [];
  let out = '';
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    const low = foldSigma(String.fromCodePoint(cp).toLowerCase());
    for (let k = 0; k < low.length; k++) offsets.push(i);
    out += low;
    i += size;
  }
  offsets.push(text.length);
  return { text, lower: out, map: Int32Array.from(offsets) };
}

/** First lower offset whose original offset is >= `from`. */
function lowerOffset(map: Int32Array, from: number): number {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Original end offset for a match ending at lower offset `j`, widened to a whole source character. */
function originalEnd(map: Int32Array, j: number): number {
  let k = j;
  while (k < map.length - 1 && map[k] === map[j - 1]) k++;
  return map[k];
}

const EXTENDER = /^(?:\p{M}|[\ufe00-\ufe0f]|[\u{1F3FB}-\u{1F3FF}])/u; // combining mark, variation selector, emoji skin tone
const ZWJ = 0x200d;

/**
 * Widen a match end so it never stops in the middle of what the reader sees as one character:
 * a base letter plus combining accents, an emoji plus its skin tone, or a joined emoji sequence.
 * A <mark> boundary inside such a cluster makes browsers draw the pieces separately.
 */
function clusterEnd(text: string, end: number): number {
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code < 0x300) break; // ASCII and Latin-1 never extend a cluster: the common case exits here
    if (code === ZWJ && end + 1 < text.length) {
      end += 1 + (text.codePointAt(end + 1)! > 0xffff ? 2 : 1);
    } else if (EXTENDER.test(text.slice(end, end + 2))) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    } else break;
  }
  return end;
}

/** Offset in the original text of the first match, or -1. */
export function firstMatch(f: Folded, query: string): number {
  const q = foldQuery(query);
  if (!q) return -1;
  const i = f.lower.indexOf(q);
  return i < 0 ? -1 : f.map ? f.map[i] : i;
}

/**
 * Non-overlapping matches as [start, end) offsets in the original text, in order.
 * `from` / `to` restrict the search to a window of the original text (for clipped views),
 * so highlighting a 40k-character window of a 5 MB output never walks the whole string.
 */
export function findRanges(f: Folded, query: string, opts: { from?: number; to?: number; limit?: number } = {}): [number, number][] {
  const q = foldQuery(query);
  const out: [number, number][] = [];
  if (!q) return out;
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(f.text.length, opts.to ?? f.text.length);
  const limit = opts.limit ?? 5000;
  const { lower, map } = f;
  let pos = map ? lowerOffset(map, from) : from;
  let lastEnd = from;
  while (out.length < limit) {
    const i = lower.indexOf(q, pos);
    if (i < 0) break;
    const start = map ? map[i] : i;
    if (start >= to) break;
    pos = i + q.length;
    if (start < lastEnd) continue; // already covered by the previous match's cluster
    const end = Math.min(clusterEnd(f.text, map ? originalEnd(map, i + q.length) : i + q.length), to);
    out.push([start, end]);
    lastEnd = end;
  }
  return out;
}

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * A one-line excerpt of `text` around offset `at`: about `lead` characters of context before
 * it, at most `max` in total, whitespace collapsed, ellipses where it was cut. Never splits
 * a surrogate pair.
 */
export function excerptAround(text: string, at: number, max = 180, lead = 55): string {
  const before = Math.min(lead, Math.floor(max / 3)); // a short excerpt must still show the match itself
  let start = at > before ? at - before : 0;
  if (start > 0 && isLow(text.charCodeAt(start))) start--;
  let end = Math.min(text.length, start + max);
  if (end < text.length && isLow(text.charCodeAt(end))) end--;
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

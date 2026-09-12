/**
 * The same normalisation the pipeline applies, reimplemented here on purpose.
 *
 * `pipeline/ground.py` finds a quotation inside a contract by dropping whitespace and
 * applying NFKC to both sides, then maps the match back to a range of the original
 * text. This file exists so the app can check that answer instead of trusting it: given
 * a span, does `text.slice(start, end)` actually normalise to the quote the producer
 * says it does?
 *
 * Reimplementing rather than sharing is the deliberate part. If the app reused the
 * producer's arithmetic, the check would be the code agreeing with itself. Two
 * independent implementations that agree on a committed artifact is a real check, and
 * when it fails it means the two repositories' idea of "the same passage" has diverged
 * -- which is precisely the failure that puts the wrong sentence under the highlight
 * while the field above it looks fine.
 *
 * One hazard is structural rather than logical and worth naming: Python indexes strings
 * by code point and JavaScript by UTF-16 code unit, so a span crossing an astral
 * character (𠮷, an emoji) would land in a different place here than the producer meant.
 * The corpus is entirely in the BMP, where the two agree. The span check in
 * `bundle.ts` is what would catch it if that stopped being true, which is the reason
 * that check compares the sliced text rather than just the bounds.
 */

/** Whitespace dropped before comparing. U+3000 (the ideographic space) is in the set
 *  because the signature blocks separate 甲 from the address with one. */
const DROPPED = /[\s\u3000]/u;

/**
 * NFKC-normalised text with whitespace removed.
 *
 * Applied per character, matching the pipeline: whole-string NFKC can change length
 * (㍿ becomes 株式会社) and then no character-level correspondence exists at all. The
 * limitation is the same on both sides -- combining sequences that normalise across
 * character boundaries are not handled -- which is the point of mirroring it exactly.
 */
export function normalise(text: string): string {
  let out = '';
  for (const ch of text) {
    if (DROPPED.test(ch)) continue;
    out += ch.normalize('NFKC');
  }
  return out;
}

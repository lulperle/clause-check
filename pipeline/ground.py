"""Locate a model's quotation inside the document it claims to have read.

This is the check the whole project rests on, so it is pure functions with no network
and no model: an extracted value is only reviewable if the reviewer can see the
sentence it came from, and a quotation that cannot be found in the document is not
evidence -- it is the model writing what the clause probably said.

Exact string matching does not work here and the reason is mundane. Contracts are
wrapped for width, so a clause spans several lines with indentation in the middle of
it; the model quotes the clause as one continuous sentence, correctly. Compare the raw
strings and every multi-line quote fails, which would report the model as fabricating
when it did not. So both sides are normalised -- whitespace dropped, NFKC applied --
and the match is done there.

Normalising to compare means the offsets found are offsets into the normalised text,
which is useless for highlighting. Hence the index map: `normalise` returns the
normalised text alongside, for each of its characters, the position in the original it
came from. That is what turns a match back into a range the UI can highlight in the
document as written.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

# Characters dropped before comparing. Line breaks and the indentation that follows
# them are layout, not content; the ideographic space is here because it appears inside
# 「甲　東京都...」 in the signature blocks.
_DROPPED = {" ", "\t", "\n", "\r", "　"}


@dataclass(frozen=True)
class Span:
    """A range of the original document, half-open, as `text[start:end]`."""

    start: int
    end: int


def normalise(text: str) -> tuple[str, list[int]]:
    """Normalised text, plus the original index each normalised character came from.

    NFKC is applied per character rather than to the whole string, because a
    whole-string normalisation can change the length -- ㍿ becomes 株式会社, four
    characters from one -- and then no index map exists at all. Per character, one
    input character maps to one or more output characters and every one of them can
    point back at its source. The difference from true NFKC only shows up for combining
    sequences that normalise across character boundaries, which do not occur in this
    corpus; it is a limitation, not a subtlety being glossed over.
    """
    out: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        if ch in _DROPPED:
            continue
        for norm in unicodedata.normalize("NFKC", ch):
            out.append(norm)
            origin.append(i)
    return "".join(out), origin


def locate(document: str, quote: str) -> Span | None:
    """Where `quote` appears in `document`, or None if it does not.

    None is a finding, not an error. It means the model returned a value attributed to
    a sentence that is not in the document, and the UI shows that value with its
    evidence struck out rather than hiding the field.
    """
    if not quote.strip():
        return None
    haystack, origin = normalise(document)
    needle, _ = normalise(quote)
    if not needle:
        return None
    at = haystack.find(needle)
    if at == -1:
        return None
    # `origin[j]` is the first original index of the j-th normalised character, so the
    # end of the span is one past the origin of the last matched character.
    return Span(origin[at], origin[at + len(needle) - 1] + 1)


def occurrences(document: str, quote: str) -> int:
    """How many times the quote appears. Used to flag ambiguous evidence.

    A quotation matching in three places is technically grounded and practically
    useless -- 「甲の負担とする。」 appears in most of these contracts -- so the count
    travels with the span and the UI says so instead of silently highlighting the first
    one.
    """
    haystack, _ = normalise(document)
    needle, _ = normalise(quote)
    if not needle:
        return 0
    count = 0
    at = haystack.find(needle)
    while at != -1:
        count += 1
        at = haystack.find(needle, at + 1)
    return count

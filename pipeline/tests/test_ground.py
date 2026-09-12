"""Locating a quotation in the document it came from."""

from __future__ import annotations

from ground import locate, normalise, occurrences

CONTRACT = """第5条（委託料及び支払）
1. 本業務の委託料は、個別契約において定める。
2. 甲は、前条の検収完了後、乙の請求に基づき、請求書を受領した月の翌月末日までに、
   乙が指定する銀行口座に振込送金の方法により委託料を支払う。振込手数料は甲の
   負担とする。
"""


def test_a_quote_spanning_wrapped_lines_is_found():
    """The case that makes exact matching useless. The clause is wrapped for width with
    indentation in the middle of it; the model quotes it as one continuous sentence,
    correctly. Comparing raw strings would report a fabrication."""
    quote = (
        "甲は、前条の検収完了後、乙の請求に基づき、請求書を受領した月の翌月末日までに、"
        "乙が指定する銀行口座に振込送金の方法により委託料を支払う。"
    )
    span = locate(CONTRACT, quote)
    assert span is not None
    # And the span points at the original text, not the normalised copy, so the same
    # offsets highlight the document as written.
    assert CONTRACT[span.start] == "甲"
    assert CONTRACT[span.end - 1] == "。"


def test_the_span_covers_the_quote_and_nothing_after_it():
    span = locate(CONTRACT, "振込手数料は甲の負担とする。")
    assert span is not None
    assert CONTRACT[span.start : span.end].replace("\n", "").replace(" ", "") == (
        "振込手数料は甲の負担とする。"
    )


def test_a_quote_that_is_not_in_the_document_is_not_found():
    """The finding this function exists for: a value attributed to a sentence the
    contract does not contain."""
    assert locate(CONTRACT, "損害賠償の額は委託料の総額を上限とする。") is None


def test_full_width_digits_match_half_width_ones():
    assert locate("支払は１０営業日以内とする。", "支払は10営業日以内とする。") is not None


def test_an_empty_or_whitespace_quote_is_not_a_match():
    """Otherwise `find` returns 0 for the empty string and every blank quote reports as
    grounded at the top of the document."""
    assert locate(CONTRACT, "") is None
    assert locate(CONTRACT, "   \n ") is None


def test_occurrences_counts_a_repeated_sentence():
    """Ambiguous evidence is technically grounded and practically useless: a highlight on
    the first of three identical sentences implies a precision that is not there."""
    doubled = CONTRACT + "\n第6条\n振込手数料は甲の負担とする。\n"
    assert occurrences(doubled, "振込手数料は甲の負担とする。") == 2
    assert occurrences(CONTRACT, "振込手数料は甲の負担とする。") == 1


def test_normalise_maps_every_character_back_to_its_source():
    text = "甲　乙\n丙"
    normalised, origin = normalise(text)
    assert normalised == "甲乙丙"
    assert [text[i] for i in origin] == ["甲", "乙", "丙"]

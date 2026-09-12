"""Judging an extracted value against a label."""

from __future__ import annotations

from score import judge, score_bundle, tally

STATED = {"contains": ["翌月末日"]}
ABSENT: dict[str, object] = {}


def test_a_stated_field_read_correctly():
    assert judge("請求書を受領した月の翌月末日", STATED) == "correct"


def test_a_stated_field_answered_from_the_wrong_clause():
    """The failure the field questions exist to prevent: 検収期限 is in the document, is a
    number of days, and is not the payment date."""
    assert judge("納入後10営業日以内", STATED) == "wrong"


def test_a_stated_field_left_empty_is_missed_not_wrong():
    assert judge(None, STATED) == "missed"


def test_an_absent_field_reported_as_null():
    assert judge(None, ABSENT) == "correct_absent"


def test_an_absent_field_answered_anyway_is_invented():
    """The expensive error. A reviewer skimming reads 「30日前で解約できる」 and believes a
    contract that cannot be cancelled mid-term can be."""
    assert judge("期間満了の30日前まで", ABSENT) == "invented"


def test_an_absent_field_reported_in_prose_is_its_own_outcome():
    """Observed, not hypothetical: the naive run wrote 「定めなし（…）」 into a field whose
    schema says null means not stated. The model knew the answer, so blaming the reading
    would send the fix to the wrong place -- the interface is what let a sentence meaning
    "absent" arrive where a consumer reads it as a found clause."""
    value = "定めなし（再委託・第三者委託に関する条項はないが、再販売は禁止されている）"
    assert judge(value, ABSENT) == "absent_as_prose"


def test_a_clause_mentioning_absence_is_still_scored_on_its_content():
    """The absent-in-prose phrases are only consulted when the label expects absence, so a
    real clause containing 「定めがない場合」 is not swept up by them."""
    label = {"contains": ["協議"]}
    assert judge("本契約に定めがない事項は甲乙協議の上で決定する", label) == "correct"


def test_orthographic_variants_of_a_month_are_the_same_answer():
    assert judge("6ヶ月前", {"contains": ["6か月"]}) == "correct"
    assert judge("６ケ月前", {"contains": ["6か月"]}) == "correct"


def test_a_forbidden_substring_makes_an_otherwise_matching_answer_wrong():
    """saas-riyo names no court. 「甲の本店所在地を管轄する地方裁判所（東京地方裁判所）」 is
    partly right and the parenthesis is invented, which is the part that would be relied
    on."""
    label = {"contains": ["本店所在地"], "not_contains": ["東京"]}
    assert judge("甲の本店所在地を管轄する地方裁判所（東京地方裁判所）", label) == "wrong"


def test_a_whitespace_only_value_counts_as_nothing():
    assert judge("   ", STATED) == "missed"
    assert judge("   ", ABSENT) == "correct_absent"


def test_tally_reports_the_zeroes():
    """An omitted key reads as the check not having run."""
    counts = tally(["correct", "correct"])
    assert counts["correct"] == 2
    assert counts["invented"] == 0
    assert set(counts) == {
        "correct",
        "correct_absent",
        "absent_as_prose",
        "missed",
        "wrong",
        "invented",
    }


def test_score_bundle_reads_a_whole_bundle_without_a_model():
    """Scoring is a pure function of the committed artifact, which is what made adding a
    sixth outcome after both runs existed cost nothing."""
    bundle = {
        "generated": "2026-09-12T00:00:00+00:00",
        "run": {"prompt": "guarded"},
        "documents": [
            {
                "id": "doc",
                "fields": [
                    {"key": "payment_due", "value": "翌月末日", "quote": "x", "span": None},
                    {"key": "liability_cap", "value": None, "quote": None, "span": None},
                ],
            }
        ],
    }
    labels = {"doc": {"payment_due": STATED, "liability_cap": None}}
    scored = score_bundle(bundle, labels)
    assert scored["tally"]["correct"] == 1
    assert scored["tally"]["correct_absent"] == 1
    # A value whose quote is not locatable is counted, separately from whether the value
    # itself was right.
    assert scored["ungrounded_quotes"] == 1

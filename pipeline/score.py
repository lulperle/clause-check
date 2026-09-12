"""Score an extraction against the hand-written labels.

Deliberately six outcomes, not two. "Accuracy" over a field set like this hides the
distinctions that decide whether the tool is usable:

- `correct`         the field is stated and was read correctly
- `correct_absent`  the field is not stated and the model returned null
- `absent_as_prose` the field is not stated and the model said so **in the value**
- `missed`          the field is stated and the model returned nothing
- `wrong`           the field is stated and the model returned something else
- `invented`        the field is **not** stated and the model returned a value

A missed field costs the reviewer a lookup. An invented field costs them the belief
that they can skim, and in a contract review that is the whole value of the tool. They
are not the same error, and averaging them together is how a tool ships with the
expensive one uncounted.

`absent_as_prose` exists because the naive run produced it: 「定めなし（再委託・第三者委託に
関する条項はないが…）」 written into a field whose schema says null means not stated. The
model knew the answer. Folding that into `invented` would blame the reading when the
fault is in the interface -- a consumer cannot distinguish that string from a real
value, so it renders as a found clause -- and the fix is the schema and the prompt,
not a better reader. Separating the two says which of those to go and fix.

Outcomes are scored separately from grounding, because the two catch different things:
a value can be a faithful quotation of a passage that answers a different question. See
the `not_contains` label on saas-riyo's jurisdiction.
"""

from __future__ import annotations

import unicodedata
from typing import Any

Outcome = str

OUTCOMES = ("correct", "correct_absent", "absent_as_prose", "missed", "wrong", "invented")

# Phrases that mean "this contract does not say", written where a null belonged. Matched
# only when the label expects absence, so a real clause containing 「定めがない場合」 is not
# swept up by it.
_ABSENT_IN_PROSE = (
    "定めなし",
    "定めがな",
    "記載なし",
    "記載がな",
    "規定なし",
    "該当なし",
    "なし（",
)


def _fold(text: str) -> str:
    """NFKC, minus the variation that is spelling rather than meaning.

    ヶ and か: 「6ヶ月」 and 「6か月」 are the same term and the model picks either. Folding
    them is not leniency about the answer, only about the orthography.
    """
    folded = unicodedata.normalize("NFKC", text)
    return folded.replace("ヶ", "か").replace("ケ月", "か月")


def judge(value: str | None, label: dict[str, Any]) -> Outcome:
    """Compare one extracted value against one label."""
    expects_absent = "contains" not in label
    stated = value is not None and value.strip() != ""

    if expects_absent:
        if not stated:
            return "correct_absent"
        folded = _fold(value or "")
        if any(phrase in folded for phrase in _ABSENT_IN_PROSE):
            return "absent_as_prose"
        return "invented"
    if not stated:
        return "missed"

    folded = _fold(value or "")
    if any(_fold(str(s)) not in folded for s in label["contains"]):
        return "wrong"
    if any(_fold(str(s)) in folded for s in label.get("not_contains", ())):
        return "wrong"
    return "correct"


def tally(outcomes: list[Outcome]) -> dict[str, int]:
    """Counts for every outcome, including the zeroes.

    Zeroes are included so a run that invented nothing reports `invented: 0` rather
    than omitting the key, which reads as the check not having run.
    """
    return {o: sum(1 for x in outcomes if x == o) for o in OUTCOMES}


def score_bundle(bundle: dict[str, Any], labels: dict[str, Any]) -> dict[str, Any]:
    """Judge a whole extraction bundle.

    A pure function of the bundle, so a scoring change is re-run against the committed
    artifacts instead of against the model. That matters more than it sounds: the sixth
    outcome above was added *after* both runs existed, and re-deriving the numbers cost
    nothing and called nothing, which is the only reason it was worth adding at all.
    """
    details: list[dict[str, Any]] = []
    for document in bundle["documents"]:
        for entry in document["fields"]:
            label = labels[document["id"]][entry["key"]] or {}
            details.append(
                {
                    "document": document["id"],
                    "field": entry["key"],
                    "outcome": judge(entry["value"], label),
                    "value": entry["value"],
                    "grounded": entry["span"] is not None,
                }
            )
    return {
        "generated": bundle.get("generated"),
        "run": bundle.get("run", {}),
        "tally": tally([d["outcome"] for d in details]),
        "ungrounded_quotes": sum(
            1
            for document in bundle["documents"]
            for entry in document["fields"]
            if entry["quote"] and entry["span"] is None
        ),
        "details": details,
    }

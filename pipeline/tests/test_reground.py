"""Re-deriving spans after a document is edited.

The reason this file exists: a contract is a fixture that occasionally has to change --
a party name that turns out to belong to a real company, a typo -- and every span in the
committed bundles is a character offset into it. Editing the text by two characters
invalidates every offset after that point, and the failure is silent in the worst way: the
bundle still parses, the span still points at *something*, and a reviewer reads the wrong
clause as the evidence for a value.
"""

from __future__ import annotations

import json
from pathlib import Path

from ground import locate
from reground import reground, rename_in

PUBLIC = Path(__file__).resolve().parents[2] / "public"

CONTRACT = """業務委託基本契約書

株式会社ノーエグジスト（以下「甲」という。）と乙とは、以下のとおり契約する。

第1条（委託料）
1. 委託料は、月額50万円とする。振込手数料は甲の負担とする。
"""


def bundle_with(quote: str, text: str = CONTRACT) -> dict:
    return {
        "run": {"ungrounded_quotes": 0, "ambiguous_quotes": 0},
        "documents": [
            {
                "id": "doc",
                "title": "wrong title",
                "text": "stale text",
                "fields": [
                    {
                        "key": "fee",
                        "value": "月額50万円",
                        "quote": quote,
                        "span": None,
                        "occurrences": 0,
                    }
                ],
            }
        ],
    }


def test_a_stale_span_is_recomputed_from_the_document():
    quote = "委託料は、月額50万円とする。"
    bundle = bundle_with(quote)
    changes = reground(bundle, {"doc": CONTRACT})
    field = bundle["documents"][0]["fields"][0]
    # Stated as a position in the text rather than as a literal number, because a literal
    # would be asserting my arithmetic about this fixture and not the behaviour.
    start = CONTRACT.index(quote)
    assert field["span"] == {"start": start, "end": start + len(quote)}
    assert CONTRACT[field["span"]["start"] : field["span"]["end"]] == quote
    assert any("span" in c for c in changes)


def test_the_text_and_title_are_taken_from_the_document_file():
    bundle = bundle_with("委託料は、月額50万円とする。")
    reground(bundle, {"doc": CONTRACT})
    assert bundle["documents"][0]["text"] == CONTRACT
    assert bundle["documents"][0]["title"] == "業務委託基本契約書"


def test_a_quotation_that_is_not_in_the_document_stays_ungrounded():
    """The finding the naive run exists to show, so a script that "repaired" it into a
    span would be erasing the measurement rather than fixing an index."""
    bundle = bundle_with("委託料は、月額80万円とする。")
    reground(bundle, {"doc": CONTRACT})
    assert bundle["documents"][0]["fields"][0]["span"] is None
    assert bundle["run"]["ungrounded_quotes"] == 1


def test_a_field_with_no_quotation_gets_no_span():
    bundle = bundle_with(None)
    reground(bundle, {"doc": CONTRACT})
    field = bundle["documents"][0]["fields"][0]
    assert field["span"] is None
    assert field["occurrences"] == 0
    # And it is not counted as ungrounded: "the contract does not say" is an answer, and
    # conflating it with a fabricated citation is the distinction this repository is about.
    assert bundle["run"]["ungrounded_quotes"] == 0


def test_a_repeated_quotation_is_counted():
    text = CONTRACT + "2. 振込手数料は甲の負担とする。\n"
    bundle = bundle_with("振込手数料は甲の負担とする。", text)
    reground(bundle, {"doc": text})
    assert bundle["documents"][0]["fields"][0]["occurrences"] == 2
    assert bundle["run"]["ambiguous_quotes"] == 1


def test_a_document_with_no_file_is_left_alone_and_reported():
    bundle = bundle_with("委託料は、月額50万円とする。")
    changes = reground(bundle, {})
    assert bundle["documents"][0]["text"] == "stale text"
    assert any("no document file" in c for c in changes)


def test_renaming_touches_values_and_quotations_but_not_the_document():
    bundle = bundle_with("株式会社ノーエグジストは、委託料を支払う。")
    bundle["documents"][0]["fields"][0]["value"] = "甲: 株式会社ノーエグジスト"
    hits = rename_in(bundle, "ノーエグジスト", "noexist")
    assert hits == 2
    field = bundle["documents"][0]["fields"][0]
    assert field["value"] == "甲: 株式会社noexist"
    assert field["quote"].startswith("株式会社noexist")
    # The document text is the pipeline's input, not the bundle's to edit: it comes back
    # from documents/*.txt on the next reground.
    assert bundle["documents"][0]["text"] == "stale text"


def test_regrounding_the_committed_bundles_changes_nothing():
    """The contract test that makes the tool trustworthy: run it against what Bedrock
    actually produced and no span moves. If `locate` and this script ever disagree with
    the extraction, the numbers in the README were produced by something else."""
    documents = {
        p.stem: p.read_text(encoding="utf-8")
        for p in sorted((Path(__file__).resolve().parents[1] / "documents").glob("*.txt"))
    }
    for name in ("extraction.json", "extraction-naive.json"):
        bundle = json.loads((PUBLIC / name).read_text(encoding="utf-8"))
        assert reground(bundle, documents) == [], name


def test_every_span_in_the_committed_bundles_covers_its_quotation():
    """Independent of reground: read the bundles as a consumer would and check the claim
    each span makes. This is the assertion that would have caught the renamed party."""
    for name in ("extraction.json", "extraction-naive.json"):
        bundle = json.loads((PUBLIC / name).read_text(encoding="utf-8"))
        for document in bundle["documents"]:
            for field in document["fields"]:
                if not field["span"]:
                    continue
                start, end = field["span"]["start"], field["span"]["end"]
                assert locate(document["text"][start:end], field["quote"]) is not None, (
                    f"{name} {document['id']}.{field['key']}"
                )

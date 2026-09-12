"""Extract nine clauses from each contract, locate the evidence, score the result.

Run:

    python pipeline/extract.py                  # all four documents
    python pipeline/extract.py --doc saas-riyo  # one, for about a cent

Two files come out and the split is deliberate:

- `public/extraction.json` is what the review screen loads. It carries every value, the
  quotation behind it, and where that quotation sits in the document. It does **not**
  carry the labels, because a screen that shows the reviewer the right answer is not
  measuring review, it is measuring reading.
- `pipeline/out/score.json` is the same run judged against `labels.yaml`, written
  separately so the numbers in the README are recomputable without the app.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any

import yaml

from bedrock import Bedrock, ToolCallMissing
from fields import FIELDS
from ground import locate, occurrences
from score import score_bundle

HERE = Path(__file__).parent
DOCUMENTS = HERE / "documents"
LABELS = HERE / "labels.yaml"

SYSTEM = """あなたは契約書を読んで所定の項目を抜き出す担当者です。

厳守事項:
- 各項目について、根拠となる原文をそのまま quote に入れること。要約や言い換えを
  quote に入れてはいけません。原文にない文字を1文字も加えないでください。
- 文書に定めがない項目は、value と quote の両方を null にすること。「記載なし」と
  書くのではなく null にしてください。
- 近い内容の条項があっても、問われている項目と別のものであれば null にすること。
  それらしい条項で埋めてはいけません。定めがないこと自体が、利用者が必要としている
  答えです。
- 数値、期間、金額、裁判所名は、文書に書かれているものだけを使うこと。
"""

# The same job asked for without any of the above. Kept in the repository and run as a
# comparison, because "the extraction is accurate" is not a property of the model -- the
# guarded prompt above names, for each field, the plausible wrong clause the document
# actually contains, and that is where its accuracy comes from. Deleting those sentences
# and re-running is the only way to show which of them is load-bearing rather than
# decorative. `--naive` does that; the README reports both columns.
SYSTEM_NAIVE = """契約書から指定された項目を抜き出してください。根拠となる原文を quote に
入れてください。
"""

PROMPT = """次の契約書から、指定された項目を抜き出してください。

## 契約書

{document}
"""


def tool_spec(*, naive: bool = False) -> dict[str, Any]:
    """The nine fields as a tool schema.

    Each field is an object with `value` and `quote`, both nullable, and both required.
    Required-but-nullable rather than optional: an omitted key and a null are the same
    thing to a reader and different things to a parser, and this way "not stated" has
    to be said rather than left out.
    """
    properties = {
        f.key: {
            "type": "object",
            "description": f.label if naive else f"{f.label}: {f.question}",
            "properties": {
                "value": {
                    "type": ["string", "null"],
                    "description": "抜き出した内容。定めがなければ null。",
                },
                "quote": {
                    "type": ["string", "null"],
                    "description": "根拠となる原文の抜粋。定めがなければ null。",
                },
            },
            "required": ["value", "quote"],
        }
        for f in FIELDS
    }
    return {
        "name": "record_clauses",
        "description": "契約書から抜き出した項目を記録する。",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": properties,
                "required": [f.key for f in FIELDS],
            }
        },
    }


def read_documents(only: str | None) -> list[tuple[str, str]]:
    paths = sorted(DOCUMENTS.glob("*.txt"))
    if only:
        paths = [p for p in paths if p.stem == only]
        if not paths:
            raise SystemExit(f"no document named {only!r} in {DOCUMENTS}")
    return [(p.stem, p.read_text(encoding="utf-8")) for p in paths]


def as_str(value: Any) -> str | None:
    """A value from the model, or None.

    Whitespace-only strings collapse to None here rather than downstream, so that
    「 」 and null are one case for both the scorer and the UI.
    """
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc", help="extract one document by file stem")
    parser.add_argument(
        "--naive",
        action="store_true",
        help="ask for the fields by name only, with none of the guardrails",
    )
    parser.add_argument("--out")
    parser.add_argument("--score")
    args = parser.parse_args()

    prompt_name = "naive" if args.naive else "guarded"
    suffix = "-naive" if args.naive else ""
    out_path = args.out or str(HERE.parent / "public" / f"extraction{suffix}.json")
    score_path = args.score or str(HERE / "out" / f"score{suffix}.json")

    documents = read_documents(args.doc)
    labels = yaml.safe_load(LABELS.read_text(encoding="utf-8"))
    client = Bedrock()
    tool = tool_spec(naive=args.naive)
    system = SYSTEM_NAIVE if args.naive else SYSTEM

    print(f"{len(documents)} documents x {len(FIELDS)} fields, {prompt_name} prompt")

    out_documents: list[dict[str, Any]] = []
    ungrounded = 0
    ambiguous = 0

    for doc_id, text in documents:
        try:
            extracted = client.extract(system, PROMPT.format(document=text), tool)
        except ToolCallMissing as exc:
            client.usage.errors.append(f"{doc_id}: {exc}")
            print(f"  {doc_id}: no tool call ({exc})")
            continue

        fields_out: list[dict[str, Any]] = []
        for f in FIELDS:
            got = extracted.get(f.key) or {}
            value = as_str(got.get("value"))
            quote = as_str(got.get("quote"))

            span = locate(text, quote) if quote else None
            count = occurrences(text, quote) if quote else 0
            if quote and span is None:
                ungrounded += 1
            if count > 1:
                ambiguous += 1

            fields_out.append(
                {
                    "key": f.key,
                    "label": f.label,
                    "question": f.question,
                    "value": value,
                    "quote": quote,
                    "span": {"start": span.start, "end": span.end} if span else None,
                    "occurrences": count,
                }
            )

        out_documents.append(
            {
                "id": doc_id,
                "title": text.strip().splitlines()[0].strip(),
                "text": text,
                "fields": fields_out,
            }
        )
        per_document = score_bundle({"documents": out_documents[-1:]}, labels)["tally"]
        print(f"  {doc_id}: " + ", ".join(f"{k} {v}" for k, v in per_document.items() if v))

    run = client.usage.as_dict() | {
        "prompt": prompt_name,
        "documents": len(out_documents),
        "fields_per_document": len(FIELDS),
        "ungrounded_quotes": ungrounded,
        "ambiguous_quotes": ambiguous,
    }
    bundle = {
        "generated": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "revision": 1,
        "run": run,
        "documents": out_documents,
    }

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    scored = score_bundle(bundle, labels)
    scores = Path(score_path)
    scores.parent.mkdir(parents=True, exist_ok=True)
    scores.write_text(json.dumps(scored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    counts = scored["tally"]
    print(f"\nwrote {out} and {scores}")
    print("  " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    print(
        f"  {run['calls']} calls, {run['input_tokens']} in / {run['output_tokens']} out,"
        f" {run['seconds']}s, ungrounded quotes {ungrounded}, ambiguous {ambiguous}"
    )


if __name__ == "__main__":
    main()

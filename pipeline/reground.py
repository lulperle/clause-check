"""Re-derive every span in a committed bundle from the documents, with no model call.

    python pipeline/reground.py ../public/extraction.json
    python pipeline/reground.py ../public/extraction.json --check     # CI: fail on drift
    python pipeline/reground.py ../public/extraction.json --rename 旧社名=新社名

Why this exists: the bundles carry each contract's full text and character offsets into
it, so editing a contract by one character silently invalidates every span after that
point. The app refuses to open such a bundle -- `src/bundle.ts` checks that the text under
each span still matches the quote -- which is the right failure, but leaves you with no way
to fix a name or a typo short of re-running the extraction and losing the measured
comparison with it.

Spans are not model output. They are a pure function of (document text, quotation), so
they can be recomputed exactly, and this script recomputes them with the same `locate` and
`occurrences` the extraction used. What it never touches is the model's own words: values
and quotations are the measurement, and a script that edited them would be rewriting the
result rather than repairing an index.

`--rename` is the one exception, and it is deliberately narrow: it substitutes a literal
string everywhere it appears, including inside quotations, because renaming a party in a
contract has to change the quotations that name that party or they stop being quotations of
the document. Every other kind of edit belongs in the documents, followed by a plain run of
this script.

`--check` prints what would change and exits non-zero. In CI that turns "somebody edited a
contract and forgot the bundles" from a mystery into a failed step.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ground import locate, occurrences

HERE = Path(__file__).parent
DOCUMENTS = HERE / "documents"


def reground(bundle: dict[str, Any], texts: dict[str, str]) -> list[str]:
    """Rewrite `bundle` in place so every span matches `texts`. Returns what changed.

    Ungrounded quotations stay ungrounded: `locate` returns None for a quotation that is
    not in the document, and that None is the finding the naive run exists to show. A
    version of this that "fixed" nulls would erase the thing being measured.
    """
    changes: list[str] = []

    for document in bundle["documents"]:
        doc_id = document["id"]
        text = texts.get(doc_id)
        if text is None:
            changes.append(f"{doc_id}: no document file; left untouched")
            continue

        if document["text"] != text:
            changes.append(f"{doc_id}: text updated from documents/{doc_id}.txt")
            document["text"] = text
        title = text.strip().splitlines()[0].strip()
        if document.get("title") != title:
            changes.append(f"{doc_id}: title -> {title}")
            document["title"] = title

        for field in document["fields"]:
            quote = field.get("quote")
            span = locate(text, quote) if quote else None
            count = occurrences(text, quote) if quote else 0
            new_span = {"start": span.start, "end": span.end} if span else None

            if field.get("span") != new_span:
                changes.append(
                    f"{doc_id}.{field['key']}: span {field.get('span')} -> {new_span}"
                )
            if field.get("occurrences") != count:
                was = field.get("occurrences")
                changes.append(f"{doc_id}.{field['key']}: occurrences {was} -> {count}")
            field["span"] = new_span
            field["occurrences"] = count

    # The run header counts the quotations that could not be located. It is a claim about
    # the bundle, so it is recomputed here rather than trusted.
    ungrounded = sum(
        1
        for document in bundle["documents"]
        for field in document["fields"]
        if field.get("quote") and field.get("span") is None
    )
    run = bundle.get("run", {})
    if run.get("ungrounded_quotes") != ungrounded:
        changes.append(f"run.ungrounded_quotes {run.get('ungrounded_quotes')} -> {ungrounded}")
        run["ungrounded_quotes"] = ungrounded

    ambiguous = sum(
        1
        for document in bundle["documents"]
        for field in document["fields"]
        if field.get("occurrences", 0) > 1
    )
    if "ambiguous_quotes" in run and run["ambiguous_quotes"] != ambiguous:
        changes.append(f"run.ambiguous_quotes {run['ambiguous_quotes']} -> {ambiguous}")
        run["ambiguous_quotes"] = ambiguous

    return changes


def rename_in(bundle: dict[str, Any], old: str, new: str) -> int:
    """Substitute a literal string in the values and quotations. Returns the count."""
    hits = 0
    for document in bundle["documents"]:
        for field in document["fields"]:
            for key in ("value", "quote"):
                text = field.get(key)
                if isinstance(text, str) and old in text:
                    hits += text.count(old)
                    field[key] = text.replace(old, new)
    return hits


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundles", nargs="+", help="paths to extraction bundles")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift and exit non-zero instead of writing",
    )
    parser.add_argument(
        "--rename",
        action="append",
        default=[],
        metavar="OLD=NEW",
        help="substitute a literal string in values and quotations as well as the spans",
    )
    args = parser.parse_args()

    renames = []
    for raw in args.rename:
        old, sep, new = raw.partition("=")
        if not sep or not old:
            raise SystemExit(f"--rename wants OLD=NEW, got {raw!r}")
        renames.append((old, new))

    if renames and args.check:
        raise SystemExit("--rename edits the bundle, so it cannot be combined with --check")

    texts = {p.stem: p.read_text(encoding="utf-8") for p in sorted(DOCUMENTS.glob("*.txt"))}
    drifted = False

    for name in args.bundles:
        path = Path(name)
        bundle = json.loads(path.read_text(encoding="utf-8"))

        for old, new in renames:
            hits = rename_in(bundle, old, new)
            print(f"{path.name}: replaced {hits} occurrence(s) of {old!r} with {new!r}")

        changes = reground(bundle, texts)
        print(f"{path.name}: {len(changes)} change(s)")
        for change in changes:
            print(f"  {change}")

        if args.check:
            drifted = drifted or bool(changes)
            continue
        path.write_text(
            json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    if drifted:
        print(
            "the bundles disagree with pipeline/documents/; run reground.py without --check",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()

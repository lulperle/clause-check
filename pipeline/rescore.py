"""Re-judge a committed bundle against labels.yaml, with no model call.

    python pipeline/rescore.py public/extraction.json
    python pipeline/rescore.py public/extraction-naive.json

Scoring is a pure function of the bundle, so the outcome taxonomy can change without
spending anything. Every number in the README comes out of here.

`--expect correct=28` turns that into an assertion, which is how CI checks the README
against the committed bundles rather than trusting that they were updated together.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from score import OUTCOMES, score_bundle

HERE = Path(__file__).parent


def _check(scored: dict, expectations: list[str]) -> list[str]:
    """Names of the expectations that did not hold, with what was found instead."""
    failures = []
    for raw in expectations:
        name, _, want = raw.partition("=")
        if name == "ungrounded":
            got = scored["ungrounded_quotes"]
        elif name in OUTCOMES:
            got = scored["tally"][name]
        else:
            raise SystemExit(
                f"unknown expectation {name!r}; use ungrounded or one of {OUTCOMES}"
            )
        if got != int(want):
            failures.append(f"{name}: expected {want}, found {got}")
    return failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--out", help="defaults to pipeline/out/score<suffix>.json")
    parser.add_argument(
        "--expect",
        action="append",
        default=[],
        metavar="NAME=N",
        help="assert an outcome count, or ungrounded=N; exits non-zero on a mismatch",
    )
    args = parser.parse_args()

    path = Path(args.bundle)
    bundle = json.loads(path.read_text(encoding="utf-8"))
    labels = yaml.safe_load((HERE / "labels.yaml").read_text(encoding="utf-8"))
    scored = score_bundle(bundle, labels)

    suffix = "-naive" if path.stem.endswith("naive") else ""
    out = Path(args.out or HERE / "out" / f"score{suffix}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(scored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{path.name} ({scored['run'].get('prompt', '?')} prompt) -> {out}")
    print("  " + ", ".join(f"{k} {v}" for k, v in scored["tally"].items()))
    print(f"  ungrounded quotes {scored['ungrounded_quotes']}")

    failures = _check(scored, args.expect)
    for failure in failures:
        print(f"  MISMATCH {failure}", file=sys.stderr)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

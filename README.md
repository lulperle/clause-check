# clause-check

**English** | [日本語](README.ja.md)

Extracts nine fields from a contract and **mechanically verifies that the evidence for each one is really in the document** before showing it to a person.

The extraction itself is not new. What this repository measures is what happens in the step where a person approves the output — which fields get overridden, how many unsupported values get through, and which single sentence of the prompt produced the difference.

```
pipeline/  Extract with Bedrock (Claude Sonnet 5) -> locate each quotation in the source -> score against labels.yaml
src/       React 19 + TypeScript review screen. Validates the bundle before it renders anything
public/    Two committed runs: guarded prompt and naive prompt
api/       Three interfaces over the same data: REST / GraphQL / MCP, with the differences measured into comparison.json
```

- **Live screen: https://lulperle.github.io/clause-check/** (the naive prompt's output is at [`?run=naive`](https://lulperle.github.io/clause-check/?run=naive))
- Locally: `npm ci && npm run dev`
- Recompute the numbers: `cd pipeline && python rescore.py ../public/extraction.json` (no model calls)
- The same data over REST / GraphQL / MCP: `npm run api` / `npm run mcp` ([what was measured](#three-interfaces-over-the-same-data-rest--graphql--mcp))

---

## What was measured

Same model, same four documents, 36 fields. The only difference is the system prompt and the per-field descriptions in the tool schema.

| | Guarded | Naive |
|---|---|---|
| `correct` — stated, answered correctly | 28 | 28 |
| `correct_absent` — not stated, returned null | **8** | 6 |
| `absent_as_prose` — wrote "not stated" into the value as prose | 0 | **1** |
| `invented` — returned a value the contract does not state | 0 | **1** |
| `wrong` / `missed` | 0 / 0 | 0 / 0 |
| Quotation not found in the source | **0** | **1** |
| Input / output tokens, seconds | 15,588 / 3,406, 37.1s | 13,000 / 3,631, 38.8s |

The guarded run is 36/36 (run twice, same result). Three fields broke in the naive run, and each one fell into a trap that was designed for it:

1. **saas-riyo / termination notice period** → `invented`. "Up to 30 days before the end of the term (deadline for giving notice to avoid auto-renewal)." This contract has no early-termination clause at all. The model answered with **the deadline for refusing auto-renewal**. It even writes in the parenthetical that it is looking at a different clause, and yet the value reads as "you can terminate with 30 days' notice." Someone skimming misreads it in the most expensive way available.
2. **saas-riyo / subcontracting** → `absent_as_prose`. It wrote "Not stated (there is no clause on subcontracting or delegation to third parties, but…)" into the value. The model knows the answer. What is broken is not comprehension but the interface: from a consumer's side, this string is indistinguishable from a real clause.
3. **gyomu-itaku / subcontracting** → the value is right but **the quotation does not exist in the source**. It welded Article 6(1) and 6(2) into one seamless sentence. The content is correct, so it scores `correct` — but the source text it presented is nowhere in this document, and a person cannot check it.

The third one is closest to why this repository exists. Correctness of the value and correctness of the evidence have to be measured separately or the second one falls through.

**This is the guarded prompt's achievement, not the model's.** On the guarded side, each of the nine field descriptions names, explicitly, the plausible wrong answer that really exists in that document (for example, the payment-due description says "an inspection deadline or acceptance period is not a payment due date"). So 36/36 is not evidence that "Sonnet 5 can read contracts." `--naive` is kept in the repository, and both columns are reported, so you can delete a sentence and check which one was doing the work.

## Why six outcomes instead of an accuracy number

`OUTCOMES = correct, correct_absent, absent_as_prose, missed, wrong, invented` ([pipeline/score.py](pipeline/score.py)).

Collapsing these into one accuracy figure erases the distinction that decides whether the thing is usable. A **miss** costs the user one search. A **fabrication** breaks the assumption that you may skim, and in contract review that assumption is the entire value of the tool. Average them together and the expensive failure ships uncounted.

`absent_as_prose` was added later, because the naive run actually produced it. Folding it into `invented` would blame comprehension, when the place to fix it is the schema and the prompt. Scoring is a pure function of the committed bundle (`score_bundle`), so adding a sixth outcome meant re-scoring both runs with zero model calls.

**To measure "not stated" at all, 8 of the 36 labels are null on purpose.** Extraction benchmarks skew toward "can it read what is written" because labelling the absent fields is tedious. But in practice the expensive error is reading a clause that is not there.

## Verifying the evidence

The model returns a quotation from the source alongside each value. The pipeline mechanically checks that the quotation really is in the document ([pipeline/ground.py](pipeline/ground.py)):

- Strip whitespace (including U+3000) and NFKC-normalise before searching. Contracts are hard-wrapped to a width, and the model quotes a clause as one line with the wrapping removed. A raw string comparison reports correct quotations as fabrications.
- Normalisation is done **per character**, keeping an index of which source character each normalised character came from. That is what lets a match be mapped back to a range in the original text so the document can be highlighted exactly as written. (`㍿` → `株式会社` changes length, so NFKC over the whole string destroys the correspondence.)
- If the same sentence appears in several places, count them. That is technically grounded, but highlighting only the first of three occurrences claims a precision that does not exist.

If it is not found, the span is null. The screen shows that value struck through in red and says the quoted source could not be found in this document.

**A span is not model output.** It is a pure function of (document, quotation), so it can be recomputed after a one-character edit to the contract — [pipeline/reground.py](pipeline/reground.py) does exactly that, with zero model calls. This turned out to be necessary: a company name written to be fictional turned out to belong to a real company, so every party was renamed to `noexist1`–`noexist8`. Re-running the extraction would have replaced the numbers in the table above with a different run's numbers and lost the comparison itself. CI re-derives every span with `--check` and fails on any drift, so editing a contract and forgetting the bundles is a failed step rather than a mystery. **A quotation that cannot be found stays not-found** — "repairing" the naive run's fabricated quotation would delete the thing being measured.

## The screen does not trust the bundle

The normalisation is **written a second time in TypeScript**, in [src/normalise.ts](src/normalise.ts). Not sharing it is the point: reusing the producer's computation would only make the code agree with itself. Two independent implementations agreeing on a committed artifact is a check.

[src/bundle.ts](src/bundle.ts) does not cast JSON with `as Bundle`. It validates field by field and names the location when something is wrong (`documents[0].fields[0].value: expected string or null, found 42`). That includes checking meaning:

```ts
if (normalise(text.slice(start, end)) !== normalise(field.quote)) {
  fail(`${path}.span`, 'a range whose text matches the quote', field.span);
}
```

So if the characters a span points at do not match the quotation, the screen does not open. This is also where a mismatch between Python code points and JavaScript UTF-16 code units would surface (a span crossing a non-BMP character). The current corpus is entirely within the BMP so they agree today, but failing to open is better than silently highlighting a different sentence when they stop agreeing.

`src/bundle.test.ts` has contract tests that actually parse both committed bundles, and one of them asserts that the run holding an unfindable quotation is the naive one. If the pipeline's output format changes, it fails here.

## The review screen

- The ordering is an argument. **Fields whose evidence could not be verified go first**, so that a person working top to bottom reaches the ones needing judgement while they still have attention left.
- Selecting a field scrolls the contract on the left to the clause and highlights it (amber for the active one, faint for the other fields' evidence).
- Keyboard: `j`/`k` to move, `a` approve / `e` edit / `r` reject. Disabled while a text input has focus, so typing "r" in a note does not reject the field.
- An "edit" whose content equals the extracted value is refused. Recording it would inflate the override rate on fields nobody actually changed.
- The metrics are **override rate** and **count approved without evidence**. Before any review, the override rate shows `—` rather than `0%`. "0% overridden" across zero reviews is the most flattering number available and says nothing.
- Rejected fields export as `agreed: null`. Having downstream pick up a value a person explicitly refused is worse than not running the extraction at all.
- Decisions persist to localStorage (`clause-check/decisions/v1`). [src/hooks/useDecisions.ts](src/hooks/useDecisions.ts) uses a `restored` ref to keep the save effect from firing before the restore and overwriting with empty state.

## Three interfaces over the same data (REST / GraphQL / MCP)

Three interfaces sit on the same store ([api/store.ts](api/store.ts)). This is not three implementations: **the data layer is held fixed so that only the interface differences show up**. If all three read data separately, the table below would compare three implementations rather than three interfaces.

**But the three are not at the same layer, so the table is not a scoreboard.** REST and GraphQL sit on the same HTTP transport and serve the same kind of consumer — code somebody wrote on purpose — so that is a genuine head-to-head, and for one API they are alternatives. MCP is not. Its consumer is a model, and it is not a replacement for REST; this repository itself serves REST and MCP over the same store at the same time. So each axis has to be read differently:

- **Round trips** — REST vs GraphQL is a real comparison. MCP's 2 is my decision to split this into two tools; one tool doing both would make it 1. It is not a property of the protocol.
- **Bytes** — different units. For REST and GraphQL these are bytes on the wire; for MCP they are characters that stay in the model's context for the rest of the conversation. And pretty-printing the MCP results was also my choice; minified, it would approach REST. Read that column as a record of what I chose to pay for, not as evidence that "MCP is heavy."
- **Failure shape** — all three have to answer this question, so this is the axis most worth putting side by side. But the "right" answer differs by consumer: 404 is best because the caller is code, and enumerating the valid ids is best because the caller is a model.

The defensible claim is the narrower one: **REST vs GraphQL is a comparison; MCP is a contrast** — what changes when the data stays the same and only the consumer is swapped.

The numbers are generated by [api/measure.ts](api/measure.ts) and committed to [api/comparison.json](api/comparison.json). CI regenerates it with `--check` and diffs, so prose that drifts away from the code fails the build.

### Transfer volume and round trips

| Task | REST | GraphQL | MCP |
|---|---|---|---|
| Four tabs (ids and titles only) | 429 B / 1 | **295 B** / 1 | 660 B / 1 |
| One review screen (source text + 9 fields) | 9,281 B / 1 | **7,530 B** / 1 | 9,947 B / 1 |
| One agent question (one field + a quotation check) | 696 B / **2** | **354 B** / 1 | 773 B / 2 |

The review-screen row is the honest one. Asking GraphQL for **every field REST returns** costs 9,096 B — a difference of 185 B, or 2%. So this is not an efficient protocol; **being able to drop fields is what does the work**. The 1,566 B gap down to 7,530 B is the `question` field (nine long Japanese sentences, one per field) that the screen never renders. Doing the same thing in REST means maintaining two representations: implement `?fields=` or add another route.

MCP being the heaviest is deliberate. It returns pretty-printed, readable JSON and reports errors in prose. The consumer is a model, so **it spends bytes to buy a higher chance of a correct call on the first try**. The tool definitions themselves cost 5,199 B (1,571 B of that is descriptions), paid at the top of the session whether or not any tool is ever called.

### Failure shape (where they diverge most)

| Failure | REST | GraphQL | MCP |
|---|---|---|---|
| Document id that does not exist | 404 `no_such_document` | **200, no `errors` at all**, `data.document: null` | `isError`, lists the four valid ids |
| Field name that does not exist | 404 `no_such_field` | **400** (rejected by validation before execution) | `isError`, lists that document's field names |
| Quotation not in the source | 200 `grounded: false` | 200 `grounded: false` | not `isError`, `grounded: false` |
| Failure inside a non-null field | 404 | **200 + `errors`**, `data: null` | `isError`, offers the alternatives |

GraphQL's first row was the most useful thing implementing this taught me. `document` is nullable, so **a nonexistent id comes back as a successful null** — not even an `errors` array. The caller cannot distinguish "there is no such contract" from "this contract has no title." Making that distinction possible means designing a union type or an error-extension convention yourself; REST hands you 404 for free.

The fourth row is GraphQL behaving exactly to spec, and that is the trap. **HTTP is 200 even when the application failed**, so monitoring that watches status codes reads it as healthy. Shipping GraphQL means building monitoring that reads `errors` first. The second row is where GraphQL wins: a misspelled field name is rejected **before anything executes**. REST can only execute and then return 404.

The MCP column is uniformly biased toward returning something the model can fix itself. Return only `no_such_document` and the model retries the same call. List the valid ids and the next call is right.

### Graph-shaped costs have to be closed off yourself

`{ documents { fields { key comparison { value } } } }` returns under 4 KB but calls **41 resolvers** (1 + 4 documents + 36 fields). That asymmetry — a small query being expensive on the server — does not exist for a REST route with a fixed shape. So a depth limit of 6 and a cost limit of 2,000 are implemented as a validation rule ([api/graphql.ts](api/graphql.ts)). `comparison` returns its own type, so without a limit the nesting can go on forever.

### In MCP the descriptions are the interface

Prose in an OpenAPI file is documentation: a REST client that ignores it still works. An MCP `description` is **what the model reads at the moment it decides to call**, so it determines behaviour with the same weight as a parameter name. This repository has already measured how large that effect is (guarded 36/36 versus naive 34/36 plus one fabrication), so the tool descriptions are written the way the guarded prompt is written: say **what null means**, and say **when not to call**. Tests assert that every tool has a description over 80 characters and that `does not state` appears in them.

`verify_quote` is closest to why this arm exists at all. An agent can fabricate a plausible sentence from a contract, and the fabrication reads better than the real clause. This tool makes the check something the server does mechanically and something the transcript records. The test feeds it **the fabricated quotation the naive run actually produced** (it is in the committed bundle) and asserts `grounded: false`. Not a constructed example.

## Running it

```bash
npm ci
npm test          # 118 tests (screen 56 / API 62)
npm run typecheck
npm run lint
npm run dev

npm run api       # REST + GraphQL on localhost:8787
npm run mcp       # MCP server (stdio, the way an editor or Claude Desktop launches it)
npm run measure   # measure all three and regenerate api/comparison.json

cd pipeline
pip install -r requirements.txt
python -m pytest -q                                   # 28 tests
python rescore.py ../public/extraction.json           # scoring only, no model calls
python reground.py ../public/extraction.json --check   # do the spans still match the source? (same as CI)
```

AWS credentials are needed only to redo the extraction (us-west-2, `us.anthropic.claude-sonnet-5`):

```bash
python extract.py                    # four documents, four calls, a few cents
python extract.py --doc saas-riyo --naive
```

Poking at it:

```bash
curl -s localhost:8787/documents | jq '.documents[].id'
curl -s -X POST localhost:8787/documents/saas-riyo/verify \
  -H 'content-type: application/json' -d '{"quote":"本契約は無期限に自動更新される"}'
curl -s -X POST localhost:8787/graphql -H 'content-type: application/json' \
  -d '{"query":"{ documents { id title ungrounded } }"}'
```

CI runs on the committed bundles alone. It holds no credentials, recomputes the README's numbers with `rescore.py --expect` and `measure.ts --check`, and confirms with `reground.py --check` that the spans still match the source — so it fails if the contracts, the bundles, comparison.json, or this prose drift apart.

## What this is not

- **I wrote all four contracts; they are fictional.** The parties are `株式会社noexist1` through `noexist8株式会社` and carry no meaning — plausible-sounding company names turned out to match real companies, so they were replaced with names you can tell are fake by reading them (addresses and dates are kept so the documents still look like the templates they imitate). Each document has a deliberate plausible wrong answer planted per field (the inspection deadline, the late-payment interest rate, the auto-renewal notice deadline, "the district court with jurisdiction over Party A's head office"). So these numbers are a comparison under known difficulty, not an estimate of accuracy on real documents. A measurement whose difficulty I chose myself cannot be read as an absolute.
- **No PDF, no OCR.** The input is plain text and highlighting is by character offset. Real use needs a layer mapping onto PDF coordinates; that is a separate problem and it is left out. I have not evaluated Japanese document OCR, so I claim nothing about it.
- **36 fields is not enough for a statistical claim.** The three fields that broke in the naive run are not a representative failure rate; they are instances of falling into planted traps.
- **Nothing feeds review results back into training.** The override rate is a number for a person to read; it does not automatically rewrite the prompt.
- **All three interfaces are read-only, with no auth and no rate limiting**, and none of them is deployed (GitHub Pages serves static files, so no server runs there). Depth and estimated-cost limits are in place, but that is a fraction of what a public API needs. **What was measured is the difference in interface shape** (transfer volume, round trips, failure shape), which is a separate question from whether it would survive production.
- **The absolute byte counts do not transfer.** They are a comparison on this data — four documents, 36 fields — and it is Japanese, so UTF-8 costs 3 bytes per character. Change the order of magnitude and some conclusions change (round trips do not; byte counts do).

Sibling repositories: [guide-gap](https://github.com/lulperle/guide-gap) (detecting the gap between a support queue and the documentation) and [guide-review](https://github.com/lulperle/guide-review) (the review screen for its output).

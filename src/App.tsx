/**
 * Two panes: the contract on the left, the nine extracted fields on the right.
 *
 * Layout follows from one rule -- never make the reviewer hold a clause in their head
 * while they look for the value it produced. Both are on screen, selecting a field marks
 * and centres its clause, and the fields whose evidence did not check out are listed
 * first so the cheap approvals do not get spent before the expensive ones are reached.
 *
 * Selection is derived rather than stored: `selectedKey` falls back to the head of the
 * list instead of an effect writing the first key into state on load. An effect there is
 * the standard version of this component and it has a real bug in it -- for one render
 * nothing is selected while the first row is already drawn as open, so the first
 * keystroke moves from `null` and appears to do nothing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { DocumentPane } from './components/DocumentPane';
import { FieldRow } from './components/FieldRow';
import { useDecisions } from './hooks/useDecisions';
import { BundleError, loadBundle } from './bundle';
import { keyOf, summarise, toExport, unverifiable } from './review';
import type { Bundle, ExtractedField } from './types';

/** `?run=naive` loads the bundle produced without the prompt's guardrails.
 *
 *  It is in the repository because the difference is the finding: same model, same
 *  documents, two prompts, and the unguarded one answers 中途解約の予告期間 from the
 *  auto-renewal clause. A screen that could only ever show the good run would be
 *  demonstrating the prompt, not the review step. */
function bundleUrl(): string {
  const run = new URLSearchParams(window.location.search).get('run');
  const file = run === 'naive' ? 'extraction-naive.json' : 'extraction.json';
  return `${import.meta.env.BASE_URL}${file}`;
}

export default function App() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [decisions, dispatch] = useDecisions();

  useEffect(() => {
    let live = true;
    loadBundle(bundleUrl())
      .then((loaded) => live && setBundle(loaded))
      .catch((cause: unknown) => {
        // The BundleError message names the offending path. Showing it beats "failed to
        // load": the likely reader is whoever changed the pipeline, and the path is the fix.
        if (live) setError(cause instanceof BundleError ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const document = useMemo(() => {
    if (!bundle) return null;
    return bundle.documents.find((d) => d.id === documentId) ?? bundle.documents[0];
  }, [bundle, documentId]);

  /** Fields whose evidence is missing or ambiguous, then the rest, order preserved. */
  const fields = useMemo<ExtractedField[]>(() => {
    if (!document) return [];
    const first = new Set(unverifiable(document).map((f) => f.key));
    return [
      ...document.fields.filter((f) => first.has(f.key)),
      ...document.fields.filter((f) => !first.has(f.key)),
    ];
  }, [document]);

  const selected = fields.find((f) => f.key === selectedKey) ?? fields[0] ?? null;
  const activeKey = selected ? keyOf(document!.id, selected.key) : null;

  const move = useCallback(
    (delta: number) => {
      const at = fields.findIndex((f) => f.key === selected?.key);
      // Clamped, not wrapped. Wrapping means the last field's 「次へ」 silently returns to
      // the top of a list the reviewer believes they have finished.
      const next = Math.min(Math.max(at + delta, 0), fields.length - 1);
      setSelectedKey(fields[next]?.key ?? null);
      setEditing(null);
    },
    [fields, selected],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Without this, typing 「r」 in a memo silently rejects the field being annotated.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (!activeKey) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          move(-1);
          break;
        case 'a':
          dispatch({ type: 'accept', key: activeKey });
          break;
        case 'e':
          setEditing((at) => (at === activeKey ? null : activeKey));
          break;
        case 'r':
          dispatch({ type: 'reject', key: activeKey });
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeKey, dispatch, move]);

  if (error) {
    return (
      <main className="failed">
        <h1>読み込めませんでした</h1>
        <pre>{error}</pre>
      </main>
    );
  }
  if (!bundle || !document) return <main className="loading">読み込み中…</main>;

  const summary = summarise(bundle, decisions);

  function download() {
    const blob = new Blob([JSON.stringify(toExport(bundle!, decisions), null, 2)], {
      type: 'application/json',
    });
    const link = window.document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `clause-check-${bundle!.run.prompt}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="app">
      <header>
        <h1>
          契約書の抽出結果レビュー
          <span className={`run run-${bundle.run.prompt}`}>
            {bundle.run.prompt === 'naive' ? 'ガードなしプロンプト' : 'ガード付きプロンプト'}
          </span>
        </h1>
        <dl className="scoreboard">
          <div>
            <dt>確認済み</dt>
            <dd>
              {summary.reviewed} / {summary.total}
            </dd>
          </div>
          <div>
            <dt title="承認以外（修正・却下）が確認済みに占める割合。レビュー前は表示しない。">
              上書き率
            </dt>
            <dd>
              {summary.overrideRate === null ? '—' : `${Math.round(summary.overrideRate * 100)}%`}
            </dd>
          </div>
          <div className={summary.acceptedWithoutEvidence > 0 ? 'warn' : ''}>
            <dt title="原文に見つからない引用のまま承認された項目。ゼロであるべき数字。">
              根拠なしで承認
            </dt>
            <dd>{summary.acceptedWithoutEvidence}</dd>
          </div>
          <div>
            <dt title={`${bundle.run.model} / ${bundle.run.region}`}>この実行</dt>
            <dd>
              {bundle.run.calls}回, {bundle.run.input_tokens.toLocaleString()}in /{' '}
              {bundle.run.output_tokens.toLocaleString()}out, {bundle.run.seconds}s
            </dd>
          </div>
        </dl>
        <button type="button" className="download" onClick={download}>
          結果を書き出す
        </button>
        {/* The site is public and the contracts read like real ones --署名欄に社名と住所が
            並んでいる -- so the notice belongs on the screen, not only in the README. A
            reader who lands here from a search result never sees the README. */}
        <p className="disclaimer">
          この4通の契約書はすべて架空のものです。社名・住所・氏名を含め実在しません。抽出の
          難易度を測るために、項目ごとに「もっともらしい誤答先」を意図的に仕込んでいます。
        </p>
      </header>

      <nav className="documents">
        {bundle.documents.map((d) => (
          <button
            type="button"
            key={d.id}
            className={d.id === document.id ? 'current' : ''}
            onClick={() => {
              setDocumentId(d.id);
              setSelectedKey(null);
              setEditing(null);
            }}
          >
            {d.title}
          </button>
        ))}
      </nav>

      <div className="panes">
        <DocumentPane document={document} selected={selected} />

        <main aria-label="抽出結果">
          <ol className="fields">
            {fields.map((field) => {
              const key = keyOf(document.id, field.key);
              return (
                <FieldRow
                  key={key}
                  field={field}
                  decision={decisions[key]}
                  selected={field.key === selected?.key}
                  editing={editing === key}
                  onEdit={(on) => setEditing(on ? key : null)}
                  onSelect={() => {
                    setSelectedKey(field.key);
                    setEditing(null);
                  }}
                  onAccept={() => dispatch({ type: 'accept', key })}
                  onReject={() => dispatch({ type: 'reject', key })}
                  onCorrect={(value) => dispatch({ type: 'correct', key, value })}
                  onNote={(note) => dispatch({ type: 'note', key, note })}
                />
              );
            })}
          </ol>
        </main>
      </div>

      <footer>
        <kbd>j</kbd>/<kbd>k</kbd> 項目移動　<kbd>a</kbd> 承認　<kbd>e</kbd> 修正　<kbd>r</kbd> 却下
        　｜　根拠が原文に見つからない項目・同じ文が複数箇所ある項目を先に並べています
      </footer>
    </div>
  );
}

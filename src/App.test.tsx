import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { bundle, document as doc, field } from './test/fixtures';

function serve(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
}

/** The bundle the app tests run against: one clean field, one whose quote is not in the
 *  document, one the contract does not state. */
function threeFields() {
  return bundle({
    documents: [
      doc({
        fields: [
          field(),
          field({
            key: 'liability_cap',
            label: '損害賠償額の上限',
            value: '委託料の総額を上限とする',
            quote: '損害賠償の額は委託料の総額を上限とする。',
            span: null,
          }),
          field({
            key: 'subcontracting',
            label: '再委託・第三者委託',
            value: null,
            quote: null,
            span: null,
          }),
        ],
      }),
    ],
  });
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows the field whose evidence is missing before the sound ones', async () => {
    // Order is the argument: a reviewer who works top to bottom should hit the field that
    // needs judgement while they still have attention left for it.
    serve(threeFields());
    render(<App />);
    const labels = await waitFor(() =>
      screen.getAllByText(/支払期日|損害賠償額の上限|再委託・第三者委託/),
    );
    expect(labels[0]).toHaveTextContent('損害賠償額の上限');
  });

  it('marks the selected field evidence in the document', async () => {
    serve(bundle());
    render(<App />);
    const mark = await screen.findByTestId('active-mark');
    expect(mark).toHaveTextContent('甲は、請求書を受領した月の翌月末日までに委託料を支払う。');
  });

  it('strikes out a quote that is not in the document and says why', async () => {
    serve(threeFields());
    render(<App />);
    expect(await screen.findByText('示された原文がこの文書内に見つかりません')).toBeVisible();
    // And nothing is highlighted for it, because there is nowhere to highlight.
    expect(screen.queryByTestId('active-mark')).toBeNull();
  });

  it('does not report an override rate before anything is reviewed', async () => {
    serve(bundle());
    render(<App />);
    const rate = await screen.findByText('上書き率');
    expect(rate.parentElement).toHaveTextContent('—');
  });

  it('counts a rejection as an override', async () => {
    serve(bundle());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /却下/ }));
    await waitFor(() => expect(screen.getByText('上書き率').parentElement).toHaveTextContent('100%'));
  });

  it('counts accepting an unlocatable quote, because that is the number that matters', async () => {
    serve(threeFields());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /承認/ }));
    await waitFor(() =>
      expect(screen.getByText('根拠なしで承認').parentElement).toHaveTextContent('1'),
    );
  });

  it('refuses a correction identical to the extracted value', async () => {
    // Recording it would inflate the override count with fields nobody changed.
    serve(bundle());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /修正/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/値が変わっていません/)).toBeVisible();
    expect(screen.getByText('上書き率').parentElement).toHaveTextContent('—');
  });

  it('records an edited value as a correction', async () => {
    serve(bundle());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /修正/ }));
    const box = screen.getByRole('textbox', { name: '支払期日の修正' });
    await userEvent.clear(box);
    await userEvent.type(box, '翌月20日');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('翌月20日')).toBeVisible();
    expect(screen.getByText('上書き率').parentElement).toHaveTextContent('100%');
  });

  it('ignores decision keystrokes typed into the memo box', async () => {
    // Without the guard, typing 「r」 in a memo rejects the field being annotated.
    serve(bundle());
    render(<App />);
    const note = await screen.findByRole('textbox', { name: '支払期日のメモ' });
    await userEvent.type(note, 'ar');
    expect(screen.getByText('上書き率').parentElement).toHaveTextContent('—');
  });

  it('accepts with the keyboard and keeps the decision across a remount', async () => {
    serve(bundle());
    const first = render(<App />);
    await screen.findByTestId('active-mark');
    await userEvent.keyboard('a');
    await waitFor(() => expect(screen.getByText('確認済み').parentElement).toHaveTextContent('1 / 1'));
    first.unmount();

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('確認済み').parentElement).toHaveTextContent('1 / 1'),
    );
  });

  it('shows which prompt produced the bundle', async () => {
    // The guarded and naive runs differ in accuracy, so a screen that hid this would let
    // the reader credit the model for the prompt's work.
    serve(bundle({ run: { ...bundle().run, prompt: 'naive' } }));
    render(<App />);
    expect(await screen.findByText('ガードなしプロンプト')).toBeVisible();
  });

  it('reports the offending path when the bundle does not parse', async () => {
    const broken = bundle();
    // @ts-expect-error the drift being simulated
    broken.documents[0].fields[0].value = 42;
    serve(broken);
    render(<App />);
    const failure = await screen.findByText(/fields\[0\]\.value/);
    expect(failure).toBeVisible();
  });

  it('switches documents without carrying the previous selection', async () => {
    serve(
      bundle({
        documents: [
          doc(),
          doc({ id: 'other', title: '取引基本契約書', fields: [field({ key: 'jurisdiction', label: '管轄裁判所' })] }),
        ],
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '取引基本契約書' }));
    // Scoped to the label element: the selected row also shows the question given to the
    // model, which mentions the field name in prose.
    const fields = within(screen.getByRole('main')).getAllByText(/管轄裁判所|支払期日/, {
      selector: '.field-label',
    });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toHaveTextContent('管轄裁判所');
  });
});

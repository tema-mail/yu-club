// Выплата по ведомости (S3-75, K18 §9, №314–315, TC-19, R-15): отметка «Выплачен» (только Владелец, только ready и закрытый период) и отдельная кнопка «Создать расход» с подтверждением.
// Автоматического расхода нет. Второй расход сервер не проводит (PAYOUT_EXPENSE_EXISTS): показываем это текстом, кнопка занята на время запроса. Разбивку по филиалам считает сервер.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { fmtDate, shiftError, type PayrollStatement } from '../lib/shifts.ts';
import { rub } from './CashJournal.tsx';

export interface PayoutDialogProps {
  statement: PayrollStatement;
  staffName: string;
  branches: Array<{ id: string; name: string }>;
  today: string;
  canPaid: boolean;
  canExpense: boolean;
  onChange: () => Promise<void> | void;
}
type Place = 'cash' | 'noncash';
type Method = 'cash' | 'card' | 'transfer';

export default function PayoutDialog({ statement: s, staffName, branches, today, canPaid, canExpense, onChange }: PayoutDialogProps) {
  const [date, setDate] = useState(today);
  const [comment, setComment] = useState('');
  const [place, setPlace] = useState<Place>('cash');
  const [method, setMethod] = useState<Method>('cash');
  const [split, setSplit] = useState('by_branch');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const paidDlg = useRef<HTMLDialogElement>(null);
  const expDlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const toPay = s.totals.toPayKop;
  const name = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Филиал';

  const markPaid = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await browserCall(`/payroll/statements/${enc(s.id)}/paid`, { method: 'POST', body: { rowVersion: s.rowVersion, actualPayoutDate: date, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
      paidDlg.current?.close();
      setNotice(toPay > 0 ? `Выплата отмечена: ${rub(toPay)}. Расход в кассу создаётся отдельно.` : 'Ведомость отмечена выплаченной: денег к выплате нет.');
      await onChange();
    } catch (err) {
      setError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };
  const createExpense = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await browserCall<{ operations: Array<{ id: string; branchId: string; amountKop: number }> }>(`/payroll/statements/${enc(s.id)}/payout-expense`, {
        method: 'POST',
        body: { place, method, split: split === 'by_branch' ? 'by_branch' : { branchId: split }, occurredAt: new Date().toISOString(), ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      expDlg.current?.close();
      setNotice(`Расход создан: ${res.operations.map((o) => `${name(o.branchId)} – ${rub(o.amountKop)}`).join('; ')}.`);
      await onChange();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PAYOUT_EXPENSE_EXISTS') {
        expDlg.current?.close();
        setNotice('');
      }
      setError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };
  const pickPlace = (p: Place) => {
    setPlace(p);
    setMethod(p === 'cash' ? 'cash' : 'card');
  };

  return (
    <div class="yc-pay-statement" data-testid="payout">
      {s.status === 'paid' && s.actualPayoutDate && <p data-testid="paid-date">Выплачено {fmtDate(s.actualPayoutDate)}: {rub(toPay)}</p>}
      <div class="yc-bk__actions">
        {canPaid && s.status === 'ready' && <button type="button" class="yc-btn" onClick={() => { setComment(''); setError(''); setDate(today); paidDlg.current?.showModal(); }}>Отметить выплату</button>}
        {canExpense && s.status === 'paid' && toPay > 0 && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setComment(''); setError(''); expDlg.current?.showModal(); }}>Создать расход</button>}
      </div>
      <p class="yc-alert yc-alert--ok" role="status" data-testid="payout-notice">{notice}</p>
      <p class="yc-alert yc-alert--error" role="alert" data-testid="payout-error">{error}</p>

      <dialog ref={paidDlg} class="yc-dialog" aria-labelledby="paid-title">
        <form class="yc-dialog__body" novalidate onSubmit={markPaid} data-testid="paid-form">
          <h2 id="paid-title">Отметить выплату?</h2>
          <p>{staffName}: к выплате <strong>{rub(toPay)}</strong>.</p>
          {toPay < 0 && <p>Сумма отрицательная: денег не выплачиваем, минус переносится настройкой в следующий открытый период.</p>}
          <p class="yc-field__hint">После отметки ведомость не меняется: ошибка исправляется корректировкой следующего периода. Расход в кассу этим действием не создаётся.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="paid-date-input">Дата выплаты</label>
            <input id="paid-date-input" class="yc-input" type="date" value={date} onInput={(e) => setDate((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="paid-comment">Комментарий</label>
            <textarea id="paid-comment" class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => paidDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy || !date}>Подтвердить выплату</button>
          </div>
        </form>
      </dialog>

      <dialog ref={expDlg} class="yc-dialog yc-dialog--wide" aria-labelledby="exp-title">
        <form class="yc-dialog__body" novalidate onSubmit={createExpense} data-testid="expense-form">
          <h2 id="exp-title">Создать расход «Зарплата»?</h2>
          <p>{staffName}: сумма расхода <strong>{rub(toPay)}</strong>. Операция попадёт в журнал кассы, категория «Персонал» – «Зарплата».</p>
          <fieldset class="yc-week">
            <legend class="yc-field__label">Откуда деньги</legend>
            <label class="yc-check"><input type="radio" name="exp-place" checked={place === 'cash'} onChange={() => pickPlace('cash')} /> Наличные из кассы</label>
            <label class="yc-check"><input type="radio" name="exp-place" checked={place === 'noncash'} onChange={() => pickPlace('noncash')} /> Безналичные</label>
          </fieldset>
          {place === 'noncash' && (
            <div class="yc-field">
              <label class="yc-field__label" for="exp-method">Способ</label>
              <select id="exp-method" class="yc-input" value={method} onChange={(e) => setMethod((e.currentTarget as HTMLSelectElement).value as Method)}>
                <option value="card">Карта</option>
                <option value="transfer">Перевод</option>
              </select>
            </div>
          )}
          <div class="yc-field">
            <label class="yc-field__label" for="exp-split">Филиал расхода</label>
            <select id="exp-split" class="yc-input" value={split} onChange={(e) => setSplit((e.currentTarget as HTMLSelectElement).value)}>
              <option value="by_branch">По филиалам пропорционально начисленному</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="exp-comment">Комментарий</label>
            <textarea id="exp-comment" class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => expDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Создать расход</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

// Привязка ручного расхода к выплаченной ведомости (K18 §9, №315 link): кнопка и окно выбора операции кассы. Показываем расходы категории «Персонал» – «Зарплата»
// за период по филиалу на выбор: деньги могли выдать из кассы не того филиала, где начислено. Категория в архиве – ошибка, а не все расходы подряд. Сумма выбранного должна совпасть с выплатой, иначе кнопка закрыта (решает всё равно сервер: PAYOUT_AMOUNT_MISMATCH, OPERATION_ALREADY_LINKED).
// Второго расхода привязка не создаёт, после неё «Создать расход» отвечает «уже создан».
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { addDays, inZone } from '../lib/booking.ts';
import { fmtDate, shiftError, type PayrollStatement } from '../lib/shifts.ts';
import { rub, type FinanceOperation } from './CashJournal.tsx';

export interface PayoutLinkDialogProps {
  statement: PayrollStatement;
  staffName: string;
  branches: Array<{ id: string; name: string; timezone: string }>;
  today: string;
  onLinked: (notice: string) => Promise<void> | void;
}
interface CategoryNode { id: string; code: string | null; children?: CategoryNode[] }

const LOOKBACK_DAYS = 45;
const MAX_PAGES = 10;

export default function PayoutLinkDialog({ statement: s, staffName, branches, today, onLinked }: PayoutLinkDialogProps) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [from, setFrom] = useState(addDays(today, -LOOKBACK_DAYS));
  const [to, setTo] = useState(today);
  const [ops, setOps] = useState<FinanceOperation[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const enc = encodeURIComponent;
  const toPay = s.totals.toPayKop;
  const name = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Филиал';
  const tzOf = (id: string) => branches.find((b) => b.id === id)?.timezone ?? 'UTC';
  const sum = (ops ?? []).filter((o) => picked.includes(o.id)).reduce((a, o) => a + o.amountKop, 0);

  /** Все страницы журнала филиала за период (K17 №37, порядок по возрастанию: обрезка отсекла бы самые новые). */
  const allPages = async (branchId: string, q: URLSearchParams) => {
    const items: FinanceOperation[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: { items: FinanceOperation[]; nextCursor: string | null } = await browserCall(`/branches/${enc(branchId)}/finance/operations?${q}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
      items.push(...r.items);
      if (!r.nextCursor) return items;
      cursor = r.nextCursor;
    }
    throw new ApiError(0, 'TOO_MANY', 'За период слишком много расходов – сузьте даты.');
  };
  const load = async (start: string, end: string) => {
    const mine = ++request.current;
    setBusy(true);
    setError('');
    setPicked([]);
    setOps(null);
    try {
      const cats = await browserCall<{ items: CategoryNode[] }>('/finance/categories?kind=expense');
      const salary = cats.items.flatMap((c) => c.children ?? []).find((c) => c.code === 'salary'); // по коду: имя можно переименовать
      const q = new URLSearchParams({ kind: 'expense', from: start, to: end, limit: '200' });
      if (!salary) throw new ApiError(0, 'NO_SALARY_CATEGORY', 'Категория «Персонал» – «Зарплата» в архиве: верните её, затем привязывайте расход.');
      q.set('categoryId', salary.id);
      const pages = await Promise.all(branches.map((b) => allPages(b.id, q)));
      if (mine !== request.current) return; // уже спросили другой период
      setOps(pages.flat().filter((o) => !o.reversedBy && !o.reversalOf).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)));
    } catch (err) {
      if (mine !== request.current) return;
      setOps([]);
      setError(shiftError(err));
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };
  const open = () => {
    dlg.current?.showModal();
    void load(from, to);
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || picked.length === 0 || sum !== toPay) return;
    setBusy(true);
    setError('');
    try {
      const res = await browserCall<{ operations: Array<{ number: number; branchId: string; amountKop: number }> }>(`/payroll/statements/${enc(s.id)}/payout-expense/link`, { method: 'POST', body: { operationIds: picked } });
      dlg.current?.close();
      await onLinked(`Расход привязан: ${res.operations.map((o) => `№${o.number}, ${name(o.branchId)} – ${rub(o.amountKop)}`).join('; ')}.`);
    } catch (err) {
      setError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" class="yc-btn yc-btn--ghost" onClick={open}>Привязать из кассы</button>
      <dialog ref={dlg} class="yc-dialog yc-dialog--wide" aria-labelledby="link-title">
        <form class="yc-dialog__body" novalidate onSubmit={submit} data-testid="link-form">
          <h2 id="link-title">Привязать расход из кассы</h2>
          <p>{staffName}: к выплате <strong>{rub(toPay)}</strong>. Выберите расход «Зарплата», уже внесённый в кассе: новая операция не создаётся.</p>
          <div class="yc-bk__actions">
            <div class="yc-field">
              <label class="yc-field__label" for="link-from">С</label>
              <input id="link-from" class="yc-input" type="date" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} onChange={(e) => void load((e.currentTarget as HTMLInputElement).value, to)} />
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="link-to">По</label>
              <input id="link-to" class="yc-input" type="date" value={to} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} onChange={(e) => void load(from, (e.currentTarget as HTMLInputElement).value)} />
            </div>
          </div>
          {ops === null && <p class="yc-field__hint">Загрузка…</p>}
          {ops?.length === 0 && !error && <p class="yc-empty" data-testid="link-empty">За период нет расходов «Зарплата». Внесите расход в кассе или создайте его кнопкой «Создать расход».</p>}
          {ops && ops.length > 0 && (
            <fieldset class="yc-week">
              <legend class="yc-field__label">Операции кассы</legend>
              {ops.map((o) => (
                <label class="yc-check" key={o.id} data-testid="link-op">
                  <input type="checkbox" checked={picked.includes(o.id)} onChange={(e) => toggle(o.id, (e.currentTarget as HTMLInputElement).checked)} />
                  <span>№{o.number} · {fmtDate(inZone(o.occurredAt, tzOf(o.branchId)).date)} · {name(o.branchId)} · {rub(o.amountKop)}{o.comment ? ` · ${o.comment}` : ''}</span>
                </label>
              ))}
            </fieldset>
          )}
          <p class="yc-field__hint" data-testid="link-sum">Выбрано {rub(sum)} из {rub(toPay)}{picked.length > 0 && sum !== toPay ? ': сумма должна совпасть с выплатой' : ''}</p>
          <p class="yc-alert yc-alert--error" role="alert" data-testid="link-error">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy || picked.length === 0 || sum !== toPay}>Привязать</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

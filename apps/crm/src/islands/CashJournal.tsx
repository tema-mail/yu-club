// Раздел «Финансы» (S2-60, K17 №37–38, 44, 47): сводка филиала или сети и журнал движения кассы (колонки 06 §10).
// Журнал – K17 №37 всеми страницами периода; сводка считается из тех же операций (детализация = итог), остаток
// «сейчас» по каждому месту – K17 №38 с deltaKop = 0 (только ролям с finance.view). Администратор (finance.view.day)
// видит только текущие сутки и ни одного остатка: колонки нет, предпросмотр не вызывается (решение 02.11 K17).
// Сторно – окном внутри записи с обязательной причиной; у сеанса, продажи сертификата и возврата кнопок нет –
// их исправляют возвратом платежа или отменой продажи. Закрытие месяца – только Владелец, через окно подтверждения.
// Суммы с сервера – целые копейки; в интерфейсе – рубли без плавающей арифметики.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

export type Place = 'cash' | 'noncash';
export interface FinanceOperation {
  id: string; number: number; branchId: string;
  kind: 'opening_balance' | 'income' | 'expense' | 'withdrawal' | 'place_transfer' | 'refund' | 'correction' | 'reversal';
  place: Place; method: 'cash' | 'card' | 'transfer' | null; direction: 'in' | 'out'; amountKop: number;
  source: 'session' | 'certificate_sale' | 'event' | 'extra_service' | 'other' | null;
  categoryId: string | null; subcategoryId: string | null; comment: string | null; ref: { type: string; id: string } | null;
  receiptIssued: boolean | null; occurredAt: string; recordedAt: string; authorId: string | null;
  /** Нет в ответе без finance.view (06 §14). */
  balanceAfterKop?: number;
  reversedBy: string | null; reversalOf: string | null;
}
export interface FinBranch { id: string; name: string; cityName: string; timezone: string; today: string }
export interface CashJournalProps {
  mode: 'branch' | 'network';
  /** branch – один филиал; network – все филиалы контекста (сеть или город). */
  branches: FinBranch[];
  scopeTitle: string;
  full: boolean;
  canCorrect: boolean;
  canClose: boolean;
  meId: string;
  staffNames: Record<string, string>;
  categoryNames: Record<string, string>;
}

const PAGES_MAX = 50;
export const KIND_LABEL: Record<FinanceOperation['kind'], string> = {
  opening_balance: 'Начальный остаток', income: 'Доход', expense: 'Расход', withdrawal: 'Изъятие',
  place_transfer: 'Перевод между местами', refund: 'Возврат', correction: 'Корректировка', reversal: 'Сторно',
};
export const SOURCE_LABEL: Record<NonNullable<FinanceOperation['source']>, string> = {
  session: 'Игровой сеанс', certificate_sale: 'Продажа сертификата', event: 'Мероприятие', extra_service: 'Доп. услуга', other: 'Прочее',
};
export const METHOD_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' } as const;
export const PLACE_LABEL: Record<Place, string> = { cash: 'Наличные', noncash: 'Безнал' };
const REF_LABEL: Record<string, string> = {
  payment: 'Оплата брони', booking: 'Бронь', certificate: 'Сертификат', event: 'Мероприятие', repair: 'Ремонт', staff: 'Сотрудник', shift: 'Кассовая смена',
};

/** Копейки → «12 345,67 ₽» целочисленно (без деления с плавающей точкой). */
export function rub(kop: number, signed = false): string {
  const neg = kop < 0;
  const abs = Math.abs(kop);
  const r = Math.trunc(abs / 100);
  const k = String(abs - r * 100).padStart(2, '0');
  const sign = neg ? '−' : signed && kop > 0 ? '+' : '';
  return `${sign}${new Intl.NumberFormat('ru-RU').format(r)},${k} ₽`;
}
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка. Повторите.';
  if (e.code === 'FORBIDDEN') return 'Недостаточно прав для этого действия.';
  if (e.code === 'NOT_FOUND') return 'Не найдено: запись удалена или вне вашей зоны.';
  return e.message;
}
const fmtAt = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const monthLabel = (ym: string) => {
  const s = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1).replace(' г.', '');
};

/** Все страницы журнала периода (K17 №37, limit ≤ 200). Больше PAGES_MAX страниц – ошибка, не обрезка. */
async function loadPeriod(branchId: string, from: string | null, to: string | null): Promise<FinanceOperation[]> {
  const items: FinanceOperation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGES_MAX; page++) {
    const q = new URLSearchParams({ limit: '200' });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (cursor) q.set('cursor', cursor);
    const r: { items: FinanceOperation[]; nextCursor: string | null } = await browserCall(`/branches/${encodeURIComponent(branchId)}/finance/operations?${q}`);
    items.push(...r.items);
    if (!r.nextCursor) return items;
    cursor = r.nextCursor;
  }
  throw new ApiError(0, 'TOO_MANY', `За период больше ${PAGES_MAX * 200} операций – сузьте период.`);
}
const balanceOf = (branchId: string, place: Place) =>
  browserCall<{ currentKop: number }>(`/branches/${encodeURIComponent(branchId)}/finance/preview`, { method: 'POST', body: { place, deltaKop: 0 } }).then((r) => r.currentKop);

export interface Summary { incomeKop: number; expenseKop: number; refundKop: number; withdrawalKop: number; resultKop: number; outsideKop: number; count: number }
/** Сводка из операций периода: сторно вычитается из своего вида; сторно операции вне периода – отдельной строкой. */
export function summarize(ops: FinanceOperation[]): Summary {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const s: Summary = { incomeKop: 0, expenseKop: 0, refundKop: 0, withdrawalKop: 0, resultKop: 0, outsideKop: 0, count: ops.length };
  const add = (kind: FinanceOperation['kind'], v: number) => {
    if (kind === 'income') s.incomeKop += v;
    else if (kind === 'expense') s.expenseKop += v;
    else if (kind === 'refund') s.refundKop += v;
    else if (kind === 'withdrawal') s.withdrawalKop += v;
  };
  for (const o of ops) {
    if (o.kind !== 'reversal') add(o.kind, o.amountKop);
    else {
      const orig = o.reversalOf ? byId.get(o.reversalOf) : undefined;
      if (orig) add(orig.kind, -o.amountKop);
      else s.outsideKop += o.direction === 'in' ? o.amountKop : -o.amountKop;
    }
  }
  s.resultKop = s.incomeKop - s.expenseKop - s.refundKop;
  return s;
}
/** Почему у записи нет сторно (K17 §11): сеанс, сертификат, возврат, сторно, уже сторнирована. */
export function noReverseReason(o: FinanceOperation): string | null {
  if (o.kind === 'reversal') return 'Сторно не сторнируется.';
  if (o.reversedBy) return 'Операция уже сторнирована.';
  if (o.kind === 'refund') return 'Возврат не сторнируется: исправление – корректировкой.';
  if (o.kind === 'income' && o.source === 'session') return 'Приход по сеансу исправляется возвратом платежа в карточке брони.';
  if (o.kind === 'income' && o.source === 'certificate_sale') return 'Приход от продажи сертификата исправляется отменой продажи в разделе сертификатов.';
  return null;
}

interface BranchData { ops: FinanceOperation[]; cash: number | null; noncash: number | null; error: string | null }

export default function CashJournal(p: CashJournalProps) {
  const single = p.mode === 'branch' ? p.branches[0]! : null;
  const monthStart = (today: string) => `${today.slice(0, 8)}01`;
  const [from, setFrom] = useState(single ? monthStart(single.today) : monthStart(p.branches[0]?.today ?? ''));
  const [to, setTo] = useState(single?.today ?? p.branches[0]?.today ?? '');
  const [data, setData] = useState<Record<string, BranchData>>({});
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('');
  const [needle, setNeedle] = useState('');
  const [open, setOpen] = useState<FinanceOperation | null>(null);
  const [reason, setReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [month, setMonth] = useState('');
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeDlg = useRef<HTMLDialogElement>(null);
  // Период для перечитывания по событию формы (обработчик подписан один раз – значения берём из ref).
  const period = useRef({ from, to });
  period.current = { from, to };

  const load = async () => {
    setLoading(true);
    const { from: f, to: t } = period.current;
    const next: Record<string, BranchData> = {};
    await Promise.all(
      p.branches.map(async (b) => {
        try {
          const [ops, cash, noncash] = await Promise.all([
            loadPeriod(b.id, p.full ? f : null, p.full ? t : null),
            p.full ? balanceOf(b.id, 'cash') : Promise.resolve(null),
            p.full ? balanceOf(b.id, 'noncash') : Promise.resolve(null),
          ]);
          next[b.id] = { ops, cash, noncash, error: null };
        } catch (e) {
          next[b.id] = { ops: [], cash: null, noncash: null, error: errorText(e) };
        }
      }),
    );
    setData(next);
    setLoading(false);
  };
  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener('yc-finance:changed', onChange);
    return () => window.removeEventListener('yc-finance:changed', onChange);
  }, []); // период применяется кнопкой «Показать», а не каждым вводом

  const applyPeriod = (e: Event) => {
    e.preventDefault();
    if (!from || !to || to < from) return setNotice({ ok: false, text: 'Период: дата «по» не раньше даты «с».' });
    setNotice(null);
    void load();
  };

  const periodForm = p.full && (
    <form class="yc-fin__period" onSubmit={applyPeriod} aria-label="Период">
      <label class="yc-field">
        <span class="yc-field__label">С</span>
        <input class="yc-input" type="date" value={from} max={to} onInput={(e) => setFrom(e.currentTarget.value)} />
      </label>
      <label class="yc-field">
        <span class="yc-field__label">По</span>
        <input class="yc-input" type="date" value={to} min={from} onInput={(e) => setTo(e.currentTarget.value)} />
      </label>
      <button class="yc-btn yc-btn--ghost" type="submit" disabled={loading}>Показать</button>
    </form>
  );
  const status = notice && (
    <p class={`yc-alert ${notice.ok ? 'yc-alert--ok' : 'yc-alert--error'}`} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>
  );

  // ---- сеть или город: таблица филиалов
  if (!single) {
    const rows = p.branches.map((b) => ({ b, d: data[b.id], s: summarize(data[b.id]?.ops ?? []) }));
    const total = rows.reduce(
      (t, r) => ({ income: t.income + r.s.incomeKop, expense: t.expense + r.s.expenseKop, result: t.result + r.s.resultKop, cash: t.cash + (r.d?.cash ?? 0), noncash: t.noncash + (r.d?.noncash ?? 0) }),
      { income: 0, expense: 0, result: 0, cash: 0, noncash: 0 },
    );
    return (
      <section class="yc-panel" aria-labelledby="fin-net-title">
        <h2 id="fin-net-title">Сводка: {p.scopeTitle}</h2>
        {periodForm}
        {status}
        {loading ? <p class="yc-empty" role="status">Загружаем…</p> : (
          <div class="yc-fin__scroll" tabIndex={0} aria-label="Сводка по филиалам, прокрутка внутри блока">
            <table class="yc-fin__table" data-testid="fin-network">
              <thead>
                <tr><th>Филиал</th><th>Доход</th><th>Расход</th><th>Результат</th><th>Наличные сейчас</th><th>Безнал сейчас</th></tr>
              </thead>
              <tbody>
                {rows.map(({ b, d, s }) => (
                  <tr key={b.id} data-testid={`fin-net-${b.id}`}>
                    <td><a href={`/finance/${b.id}`}>{b.name}</a><span class="yc-fin__sub">{b.cityName}</span></td>
                    {d?.error ? <td colSpan={5} class="yc-fin__err">{d.error}</td> : (
                      <>
                        <td class="yc-fin__num">{rub(s.incomeKop)}</td>
                        <td class="yc-fin__num">{rub(s.expenseKop)}</td>
                        <td class="yc-fin__num">{rub(s.resultKop)}</td>
                        <td class="yc-fin__num">{d?.cash == null ? '–' : rub(d.cash)}</td>
                        <td class="yc-fin__num">{d?.noncash == null ? '–' : rub(d.noncash)}</td>
                      </>
                    )}
                  </tr>
                ))}
                <tr class="yc-fin__total" data-testid="fin-net-total">
                  <th scope="row">Итого</th>
                  <td class="yc-fin__num">{rub(total.income)}</td>
                  <td class="yc-fin__num">{rub(total.expense)}</td>
                  <td class="yc-fin__num">{rub(total.result)}</td>
                  <td class="yc-fin__num">{rub(total.cash)}</td>
                  <td class="yc-fin__num">{rub(total.noncash)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p class="yc-field__hint">Результат = доход − расход − возвраты; изъятия и переводы между местами в него не входят. Остатки – на текущий момент.</p>
      </section>
    );
  }

  // ---- один филиал
  const d = data[single.id];
  const all = d?.ops ?? [];
  const s = summarize(all);
  const numberOf = (id: string) => all.find((o) => o.id === id)?.number;
  const needleL = needle.trim().toLowerCase();
  const shown = all.filter((o) => (!kind || o.kind === kind) && (!needleL || String(o.number) === needleL || (o.comment ?? '').toLowerCase().includes(needleL)));
  const author = (id: string | null) => (id === null ? 'Система' : id === p.meId ? 'Вы' : (p.staffNames[id] ?? 'Сотрудник'));
  const catOf = (o: FinanceOperation) =>
    o.categoryId ? [p.categoryNames[o.categoryId] ?? 'Категория', o.subcategoryId ? (p.categoryNames[o.subcategoryId] ?? '') : ''].filter(Boolean).join(' / ')
      : o.source ? SOURCE_LABEL[o.source] : o.kind === 'reversal' && o.reversalOf ? `к операции №${numberOf(o.reversalOf) ?? '…'}` : '';
  const refOf = (o: FinanceOperation) => {
    if (!o.ref) return '';
    if (o.ref.type === 'operation') return `Операция №${numberOf(o.ref.id) ?? '…'}`;
    return REF_LABEL[o.ref.type] ?? o.ref.type;
  };
  /** Место и способ: «Наличные», «Безнал · Карта», «Безнал · Перевод». */
  const wayOf = (o: FinanceOperation) => (o.place === 'cash' ? PLACE_LABEL.cash : `${PLACE_LABEL.noncash}${o.method && o.method !== 'cash' ? ` · ${METHOD_LABEL[o.method]}` : ''}`);
  const statusOf = (o: FinanceOperation) => (o.reversedBy ? 'Сторнирована' : o.kind === 'reversal' ? 'Сторно' : 'Проведена');

  const openRecord = (o: FinanceOperation) => {
    setOpen(o);
    setReason('');
    setReversing(false);
    setDlgError('');
    dialog.current?.showModal();
  };
  const closeRecord = () => {
    dialog.current?.close();
    setOpen(null);
  };
  const reverse = async (e: Event) => {
    e.preventDefault();
    if (!open || busy) return;
    if (!reason.trim()) return setDlgError('Укажите причину сторно – без неё операцию не сторнировать.');
    setBusy(true);
    setDlgError('');
    try {
      const r = await browserCall<FinanceOperation>(`/finance/operations/${open.id}/reverse`, { method: 'POST', body: { reason: reason.trim() } });
      closeRecord();
      setNotice({ ok: true, text: `Операция №${open.number} сторнирована: сторно №${r.number}.` });
      await load();
    } catch (err) {
      setDlgError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // Закрытие месяца: прошедшие 12 месяцев по зоне филиала.
  const months: string[] = [];
  {
    let [y, m] = single.today.split('-').map(Number) as [number, number];
    for (let i = 0; i < 12; i++) {
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
  }
  const closeMonth = async () => {
    const ym = month || months[0]!;
    if (closing) return;
    setClosing(true);
    setNotice(null);
    try {
      await browserCall(`/branches/${encodeURIComponent(single.id)}/finance/periods/${ym}/close`, { method: 'POST' });
      setNotice({ ok: true, text: `${monthLabel(ym)} закрыт: операции этим месяцем больше не внести, исправления – операцией текущей датой.` });
    } catch (err) {
      setNotice({ ok: false, text: errorText(err) });
    } finally {
      setClosing(false);
      closeDlg.current?.close();
    }
  };

  return (
    <>
      <section class="yc-panel" aria-labelledby="fin-sum-title" data-testid="fin-summary">
        <h2 id="fin-sum-title">{p.full ? 'Сводка за период' : 'Сводка за сегодня'}</h2>
        {periodForm}
        {d?.error && <p class="yc-alert yc-alert--error" role="alert">{d.error}</p>}
        <dl class="yc-fin__cards">
          <div><dt>Доход</dt><dd data-testid="fin-income">{rub(s.incomeKop)}</dd></div>
          <div><dt>Расход</dt><dd data-testid="fin-expense">{rub(s.expenseKop)}</dd></div>
          {s.refundKop !== 0 && <div><dt>Возвраты</dt><dd>{rub(s.refundKop)}</dd></div>}
          <div><dt>Результат</dt><dd data-testid="fin-result">{rub(s.resultKop)}</dd></div>
          {s.withdrawalKop !== 0 && <div><dt>Изъятия</dt><dd>{rub(s.withdrawalKop)}</dd></div>}
          {s.outsideKop !== 0 && <div><dt>Сторно операций вне периода</dt><dd>{rub(s.outsideKop, true)}</dd></div>}
          <div><dt>Операций</dt><dd>{s.count}</dd></div>
          {p.full && d && (
            <>
              <div><dt>Наличные сейчас</dt><dd data-testid="fin-balance-cash">{d.cash == null ? '–' : rub(d.cash)}</dd></div>
              <div><dt>Безнал сейчас</dt><dd data-testid="fin-balance-noncash">{d.noncash == null ? '–' : rub(d.noncash)}</dd></div>
            </>
          )}
        </dl>
        {!p.full && <p class="yc-field__hint">Видны операции филиала за текущие сутки. Остатки кассы видят Директор и Владелец.</p>}
      </section>

      {status}

      <section class="yc-panel" aria-labelledby="fin-journal-title">
        <h2 id="fin-journal-title">Движение средств</h2>
        <div class="yc-fin__filters">
          <label class="yc-field">
            <span class="yc-field__label">Тип операции</span>
            <select class="yc-input" value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
              <option value="">Все</option>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label class="yc-field">
            <span class="yc-field__label">Поиск по комментарию или номеру</span>
            <input class="yc-input" type="search" value={needle} onInput={(e) => setNeedle(e.currentTarget.value)} />
          </label>
        </div>
        {loading ? <p class="yc-empty" role="status">Загружаем…</p> : shown.length === 0 ? (
          <p class="yc-empty" data-testid="fin-empty">{all.length === 0 ? (p.full ? 'Операций за период нет.' : 'Сегодня операций ещё нет.') : 'Под фильтр ничего не попало.'}</p>
        ) : (
          <div class="yc-fin__scroll" tabIndex={0} aria-label="Журнал, прокрутка внутри блока">
            <table class="yc-fin__table" data-testid="fin-journal">
              <thead>
                <tr>
                  <th>Дата и время</th><th>№</th><th>Тип</th><th>Категория / источник</th><th>Комментарий</th><th>Приход</th><th>Расход</th>
                  {p.full && <th>Остаток после</th>}<th>Связь</th><th>Автор</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={o.id} data-testid={`fin-row-${o.number}`}>
                    <td class="yc-fin__at">{fmtAt(o.occurredAt, single.timezone)}</td>
                    <td><button class="yc-link" type="button" onClick={() => openRecord(o)} aria-label={`Открыть операцию №${o.number}`}>№{o.number}</button></td>
                    <td>{KIND_LABEL[o.kind]}<span class="yc-fin__sub">{wayOf(o)}</span></td>
                    <td>{catOf(o)}</td>
                    <td class="yc-fin__comment">{o.comment ?? ''}</td>
                    <td class="yc-fin__num">{o.direction === 'in' ? rub(o.amountKop) : ''}</td>
                    <td class="yc-fin__num">{o.direction === 'out' ? rub(o.amountKop) : ''}</td>
                    {p.full && <td class="yc-fin__num" data-testid="fin-after">{o.balanceAfterKop === undefined ? '' : rub(o.balanceAfterKop)}</td>}
                    <td>{refOf(o)}</td>
                    <td>{author(o.authorId)}</td>
                    <td><span class={`yc-badge${o.reversedBy ? ' yc-badge--temporarily_closed' : ''}`}>{statusOf(o)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {p.canClose && (
        <section class="yc-panel" aria-labelledby="fin-close-title">
          <h2 id="fin-close-title">Закрытие месяца</h2>
          <p class="yc-field__hint">После закрытия операции закрытым месяцем не внести и не исправить задним числом; открыть месяц обратно нельзя.</p>
          <div class="yc-fin__period">
            <label class="yc-field">
              <span class="yc-field__label">Месяц</span>
              <select class="yc-input" value={month || months[0]} onChange={(e) => setMonth(e.currentTarget.value)}>
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => closeDlg.current?.showModal()}>Закрыть месяц…</button>
          </div>
          <dialog ref={closeDlg} class="yc-dialog" aria-labelledby="fin-close-dlg">
            <div class="yc-dialog__body">
              <h2 id="fin-close-dlg">Закрыть {monthLabel(month || months[0]!).toLowerCase()}?</h2>
              <p>Филиал «{single.name}». Операции этим месяцем больше не внести; исправления – только операцией текущей датой. Отменить закрытие нельзя.</p>
              <div class="yc-dialog__actions">
                <button class="yc-btn yc-btn--ghost" type="button" onClick={() => closeDlg.current?.close()}>Отмена</button>
                <button class="yc-btn yc-btn--danger" type="button" disabled={closing} onClick={() => void closeMonth()}>Закрыть месяц</button>
              </div>
            </div>
          </dialog>
        </section>
      )}

      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="fin-op-title" onClose={() => setOpen(null)}>
        {open && (
          <div class="yc-dialog__body" data-testid="fin-record">
            <h2 id="fin-op-title">Операция №{open.number}</h2>
            <dl class="yc-props">
              <dt>Дата и время</dt><dd>{fmtAt(open.occurredAt, single.timezone)}</dd>
              <dt>Тип</dt><dd>{KIND_LABEL[open.kind]} · {wayOf(open)}</dd>
              {catOf(open) && <><dt>Категория / источник</dt><dd>{catOf(open)}</dd></>}
              <dt>Сумма</dt><dd>{rub(open.direction === 'in' ? open.amountKop : -open.amountKop, true)}</dd>
              {p.full && open.balanceAfterKop !== undefined && <><dt>Остаток после</dt><dd>{rub(open.balanceAfterKop)}</dd></>}
              <dt>Комментарий</dt><dd>{open.comment ?? '–'}</dd>
              {refOf(open) && <><dt>Связь</dt><dd>{refOf(open)}</dd></>}
              <dt>Автор</dt><dd>{author(open.authorId)}</dd>
              <dt>Статус</dt><dd>{statusOf(open)}{open.reversedBy && numberOf(open.reversedBy) ? ` (сторно №${numberOf(open.reversedBy)})` : ''}</dd>
            </dl>
            {p.canCorrect && noReverseReason(open) && <p class="yc-field__hint" data-testid="fin-no-reverse">{noReverseReason(open)}</p>}
            {reversing ? (
              <form class="yc-dialog__body" novalidate onSubmit={reverse}>
                <label class="yc-field">
                  <span class="yc-field__label">Причина сторно</span>
                  <textarea class="yc-input" rows={3} maxLength={2000} value={reason} onInput={(e) => setReason(e.currentTarget.value)} aria-invalid={dlgError ? 'true' : undefined} />
                  <span class="yc-field__hint">Исходная операция останется в журнале; сторно встанет текущей датой.</span>
                </label>
                {dlgError && <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>}
                <div class="yc-dialog__actions">
                  <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setReversing(false)}>Назад</button>
                  <button class="yc-btn yc-btn--danger" type="submit" disabled={busy}>Сторнировать</button>
                </div>
              </form>
            ) : (
              <>
                {dlgError && <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>}
                <div class="yc-dialog__actions">
                  <button class="yc-btn yc-btn--ghost" type="button" onClick={closeRecord}>Закрыть</button>
                  {p.canCorrect && !noReverseReason(open) && (
                    <button class="yc-btn yc-btn--danger" type="button" onClick={() => setReversing(true)}>Сторно…</button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </dialog>
    </>
  );
}

// Деньги мероприятия (S3-84, K20 §6, №368–369, 11 §7–8, §11.4): поступление, возврат по ссылке на поступление, расход, привязка уже внесённого расхода.
// Каждая операция – одна строка журнала кассы филиала, одним способом. Список операций и себестоимость – только при event.money.view; без права форма
// работает, если есть право кассы, а список не показывается. Сторно – окном внутри записи (finance.correct). Двойной клик – одна операция: кнопка занята,
// а ключ Idempotency-Key один на попытку. Рубли ↔ копейки – целыми; время – по зоне филиала (K8).
// Привязка показывает только расходы филиала без связи: журнал K17 не отдаёт ручную связь с другим объектом – такой случай отклоняет сервер (OPERATION_ALREADY_LINKED).
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { inZone } from '../lib/booking.ts';
import { atText, eventError, fullMoney, kopOf, toIso, type EventLine } from '../lib/events.ts';
import { METHOD_LABEL, rub, type FinanceOperation } from './CashJournal.tsx';
import { Modal, ReasonDialog, type EventTabProps } from './EventParts.tsx';

interface OpLink { operation: FinanceOperation; role: 'income' | 'refund' | 'expense' | 'payout_expense'; inCost: boolean; lineId: string | null; linkedAt: string }
interface Category { id: string; parentId: string | null; name: string; status: 'active' | 'archived'; kind: 'income' | 'expense'; children?: Category[] }
type Method = keyof typeof METHOD_LABEL;
const METHODS = Object.keys(METHOD_LABEL) as Method[];

function nowParts(tz: string) {
  const z = inZone(Date.now(), tz);
  return { date: z.date, time: z.hm };
}
const place = (m: Method) => (m === 'cash' ? 'cash' : 'noncash');

export default function EventMoney(p: EventTabProps & { mode: 'income' | 'expense' }) {
  const c = p.card;
  const tz = c.timezone;
  const can = (a: string) => p.actions.includes(a);
  const seesList = fullMoney(c.money);
  const [ops, setOps] = useState<OpLink[]>([]);
  const [loadError, setLoadError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [free, setFree] = useState<FinanceOperation[] | null>(null);
  const [form, setForm] = useState({ method: 'card' as Method, amount: '', ...nowParts(tz), comment: '', receipt: false, category: '', sub: '', supplier: '', line: '', inCost: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [refunding, setRefunding] = useState<OpLink | null>(null);
  const [refund, setRefund] = useState({ amount: '', method: 'card' as Method, reason: '' });
  const [refundError, setRefundError] = useState('');
  const [reversing, setReversing] = useState<OpLink | null>(null);
  const [linking, setLinking] = useState<FinanceOperation | null>(null);
  const [linkForm, setLinkForm] = useState({ line: '', inCost: false });
  const [linkError, setLinkError] = useState('');
  const key = useRef(crypto.randomUUID());
  const lines: EventLine[] = c.lines.filter((l) => l.status === 'active');
  const income = p.mode === 'income';
  const canRecord = can('event.money.record') && can(income ? 'finance.income.create' : 'finance.expense.create');
  const shown = ops.filter((o) => (income ? o.role === 'income' || o.role === 'refund' : o.role === 'expense' || o.role === 'payout_expense'));
  const refundedOf = (id: string) => ops.filter((o) => o.role === 'refund' && o.operation.ref?.id === id).reduce((a, o) => a + o.operation.amountKop, 0);
  const catName = (id: string | null) => categories.find((x) => x.id === id)?.name ?? '';
  const tops = categories.filter((x) => x.kind === 'expense' && x.parentId === null && x.status === 'active');
  const subs = categories.filter((x) => x.parentId === form.category && x.status === 'active');

  const load = async () => {
    if (!seesList) return;
    try {
      const r = await browserCall<{ operations: OpLink[] }>(`/events/${c.id}/money`);
      setOps(r.operations);
      setLoadError('');
    } catch (err) {
      setLoadError(eventError(err));
    }
  };
  const loadFree = async () => {
    if (income || !seesList) return;
    const to = inZone(Date.now(), tz).date;
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    try {
      const r = await browserCall<{ items: FinanceOperation[] }>(`/branches/${c.branchId}/finance/operations?kind=expense&from=${from}&to=${to}&limit=200`);
      setFree(r.items.filter((o) => o.kind === 'expense' && !o.reversedBy && !o.ref));
    } catch {
      setFree([]);
    }
  };
  useEffect(() => {
    void load();
    void loadFree();
    if (!income) browserCall<{ items: Category[] }>('/finance/categories?kind=expense').then((r) => setCategories(r.items.flatMap((x) => [x, ...(x.children ?? [])])), () => setCategories([]));
  }, [c.id, p.mode, c.rowVersion]);

  const done = async (text: string) => {
    key.current = crypto.randomUUID();
    setForm((f) => ({ ...f, amount: '', comment: '', supplier: '', ...nowParts(tz) }));
    setSaved(text);
    await p.onChanged();
    await load();
    await loadFree();
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const amountKop = kopOf(form.amount);
    if (!amountKop) return setError('Введите сумму в рублях больше нуля, например 5000 или 5000,50.');
    if (!form.date || !form.time) return setError('Укажите дату и время операции.');
    const occurredAt = toIso(form.date, form.time, tz)!;
    if (Date.parse(occurredAt) > Date.now()) return setError('Дата операции – не в будущем.');
    if (!income && !form.category) return setError('Выберите категорию расхода.');
    if (!income && subs.length > 0 && !form.sub) return setError('Выберите подкатегорию.');
    if (!income && !form.comment.trim()) return setError('Укажите комментарий к расходу.');
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const body = income
        ? { method: form.method, place: place(form.method), amountKop, occurredAt, comment: form.comment.trim() || null, receiptIssued: form.receipt }
        : { method: form.method, place: place(form.method), amountKop, categoryId: form.category, subcategoryId: form.sub || null, supplier: form.supplier.trim() || null, lineId: form.line || null, inCost: form.inCost, occurredAt, comment: form.comment.trim() };
      const op = await browserCall<FinanceOperation>(`/events/${c.id}/${income ? 'income' : 'expense'}`, { method: 'POST', key: key.current, body });
      await done(`Проведено: ${rub(op.amountKop)}, операция №${op.number} – она же в журнале кассы филиала.`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  const submitRefund = async (e: Event) => {
    e.preventDefault();
    if (busy || !refunding) return;
    const amountKop = kopOf(refund.amount);
    const left = refunding.operation.amountKop - refundedOf(refunding.operation.id);
    if (!amountKop) return setRefundError('Введите сумму возврата в рублях.');
    if (amountKop > left) return setRefundError(`По этому поступлению можно вернуть не больше ${rub(left)}.`);
    if (!refund.reason.trim()) return setRefundError('Укажите причину – без неё не сохранить.');
    setBusy(true);
    setRefundError('');
    try {
      await browserCall(`/events/${c.id}/refund`, { method: 'POST', key: key.current, body: { incomeOperationId: refunding.operation.id, amountKop, method: refund.method, place: place(refund.method), reason: refund.reason.trim() } });
      setRefunding(null);
      await done(`Возврат проведён: ${rub(amountKop)}.`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setRefundError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  const submitLink = async (e: Event) => {
    e.preventDefault();
    if (busy || !linking) return;
    setBusy(true);
    setLinkError('');
    try {
      await browserCall(`/events/${c.id}/expense/link`, { method: 'POST', key: key.current, body: { operationId: linking.id, lineId: linkForm.line || null, inCost: linkForm.inCost } });
      setLinking(null);
      await done(`Расход №${linking.number} привязан без новой операции.`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setLinkError(eventError(err));
      await loadFree();
    } finally {
      setBusy(false);
    }
  };
  const lineName = (id: string | null) => c.lines.find((l) => l.id === id)?.name;

  return (
    <>
      {!seesList && <p class="yc-field__hint" data-testid="money-hidden">Список операций и себестоимость видят Директор и Владелец. Вам виден остаток к оплате вверху карточки.</p>}
      {loadError && <p class="yc-alert yc-alert--error" role="alert">Операции не загрузились: {loadError}</p>}
      {saved && <p class="yc-alert yc-alert--ok" role="status" data-testid="money-saved">{saved}</p>}
      {seesList && (shown.length === 0 ? <p class="yc-empty" data-testid="money-empty">{income ? 'Поступлений пока нет.' : 'Расходов пока нет.'}</p> : (
        <ul class="yc-ev__cards" data-testid={income ? 'event-income' : 'event-expenses'}>
          {shown.map((o) => {
            const f = o.operation;
            const left = f.amountKop - refundedOf(f.id);
            return (
              <li class="yc-ev__item" key={f.id} data-testid={`op-${f.number}`}>
                <strong>{o.role === 'refund' ? 'Возврат' : income ? 'Поступление' : 'Расход'} №{f.number}: {rub(f.amountKop)}</strong>
                <span>{atText(f.occurredAt, tz)} · {f.method ? METHOD_LABEL[f.method] : ''}{!income && f.categoryId ? ` · ${catName(f.subcategoryId) || catName(f.categoryId)}` : ''}</span>
                {f.comment && <span>{f.comment}</span>}
                {!income && <span>{o.inCost ? 'В себестоимости' : 'Не в себестоимости'}{lineName(o.lineId) ? ` · строка: ${lineName(o.lineId)}` : ''}</span>}
                {o.role === 'income' && left !== f.amountKop && <span>Возвращено: {rub(f.amountKop - left)}</span>}
                <div class="yc-tabs">
                  {o.role === 'income' && can('finance.refund') && left > 0 && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => { key.current = crypto.randomUUID(); setRefund({ amount: '', method: f.method ?? 'card', reason: '' }); setRefundError(''); setRefunding(o); }}>Возврат…</button>}
                  {can('finance.correct') && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setReversing(o)}>Сторно…</button>}
                </div>
              </li>
            );
          })}
        </ul>
      ))}

      {canRecord ? (
        <form class="yc-form yc-form--wide" novalidate onSubmit={submit} data-testid={income ? 'income-form' : 'expense-form'}>
          <h3 class="yc-ev__h3">{income ? 'Принять оплату' : 'Добавить расход'}</h3>
          <p class="yc-field__hint">Каждая операция – одним способом: предоплату и доплату разными способами вносите отдельно. Баллы и сертификаты мероприятие не принимает.</p>
          <div class="yc-seg" role="group" aria-label="Способ">
            {METHODS.map((m) => <button key={m} type="button" class="yc-seg__btn" aria-pressed={form.method === m} onClick={() => setForm({ ...form, method: m })}>{METHOD_LABEL[m]}</button>)}
          </div>
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Сумма, ₽</span><input class="yc-input" type="text" inputMode="decimal" autoComplete="off" value={form.amount} onInput={(e) => setForm({ ...form, amount: e.currentTarget.value })} /></label>
            <div class="yc-ev__row">
              <label class="yc-field"><span class="yc-field__label">Дата</span><input class="yc-input" type="date" value={form.date} onInput={(e) => setForm({ ...form, date: e.currentTarget.value })} /></label>
              <label class="yc-field"><span class="yc-field__label">Время</span><input class="yc-input" type="time" value={form.time} onInput={(e) => setForm({ ...form, time: e.currentTarget.value })} /></label>
            </div>
          </div>
          {!income && (
            <div class="yc-ev__grid">
              <label class="yc-field"><span class="yc-field__label">Категория</span>
                <select class="yc-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.currentTarget.value, sub: '' })}><option value="">Выберите</option>{tops.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>
              {subs.length > 0 && (
                <label class="yc-field"><span class="yc-field__label">Подкатегория</span>
                  <select class="yc-input" value={form.sub} onChange={(e) => setForm({ ...form, sub: e.currentTarget.value })}><option value="">Выберите</option>{subs.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>
              )}
              <label class="yc-field"><span class="yc-field__label">Поставщик</span><input class="yc-input" type="text" maxLength={200} value={form.supplier} onInput={(e) => setForm({ ...form, supplier: e.currentTarget.value })} /></label>
              {lines.length > 0 && (
                <label class="yc-field"><span class="yc-field__label">Строка состава</span>
                  <select class="yc-input" value={form.line} onChange={(e) => setForm({ ...form, line: e.currentTarget.value })}><option value="">Без строки</option>{lines.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
              )}
              <label class="yc-check"><input type="checkbox" checked={form.inCost} onChange={(e) => setForm({ ...form, inCost: e.currentTarget.checked })} /> Учитывать в себестоимости</label>
            </div>
          )}
          <label class="yc-field"><span class="yc-field__label">{income ? 'Комментарий (необязательно)' : 'Комментарий'}</span><input class="yc-input" type="text" maxLength={2000} value={form.comment} onInput={(e) => setForm({ ...form, comment: e.currentTarget.value })} /></label>
          {income && <label class="yc-check"><input type="checkbox" checked={form.receipt} onChange={(e) => setForm({ ...form, receipt: e.currentTarget.checked })} /> Чек выдан</label>}
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div><button class="yc-btn" type="submit" disabled={busy}>{income ? 'Провести поступление' : 'Провести расход'}</button></div>
        </form>
      ) : <p class="yc-field__hint" data-testid="money-no-right">{income ? 'Поступления вносят сотрудники с правом кассы на доход: Директор и Владелец.' : 'Расходы вносят сотрудники с правом кассы.'}</p>}

      {!income && seesList && can('event.money.record') && (
        <section aria-label="Привязка расхода" data-testid="expense-link">
          <h3 class="yc-ev__h3">Привязать уже внесённый расход</h3>
          <p class="yc-field__hint">Без новой операции: расход за последние 30 дней из общего журнала, ещё не связанный ни с чем.</p>
          {free === null ? <p class="yc-empty">Загружаем…</p> : free.length === 0 ? <p class="yc-empty" data-testid="free-empty">Непривязанных расходов нет.</p> : (
            <ul class="yc-ev__cards">
              {free.map((o) => (
                <li class="yc-ev__item" key={o.id} data-testid={`free-${o.number}`}>
                  <strong>№{o.number}: {rub(o.amountKop)}</strong>
                  <span>{atText(o.occurredAt, tz)}{o.comment ? ` · ${o.comment}` : ''}</span>
                  <button class="yc-btn yc-btn--ghost" type="button" onClick={() => { key.current = crypto.randomUUID(); setLinkForm({ line: '', inCost: false }); setLinkError(''); setLinking(o); }}>Привязать…</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Modal open={refunding !== null} title={`Возврат по поступлению №${refunding?.operation.number ?? ''}`} onClose={() => setRefunding(null)} testId="refund-dialog">
        <form class="yc-ev__stack" novalidate onSubmit={submitRefund}>
          <p>Можно вернуть не больше {refunding ? rub(refunding.operation.amountKop - refundedOf(refunding.operation.id)) : ''}. Штрафы и удержания система не считает – сумму вводите вы.</p>
          <div class="yc-seg" role="group" aria-label="Способ возврата">
            {METHODS.map((m) => <button key={m} type="button" class="yc-seg__btn" aria-pressed={refund.method === m} onClick={() => setRefund({ ...refund, method: m })}>{METHOD_LABEL[m]}</button>)}
          </div>
          <label class="yc-field"><span class="yc-field__label">Сумма возврата, ₽</span><input class="yc-input" type="text" inputMode="decimal" autoComplete="off" value={refund.amount} onInput={(e) => setRefund({ ...refund, amount: e.currentTarget.value })} /></label>
          <label class="yc-field"><span class="yc-field__label">Причина</span><textarea class="yc-input" rows={2} maxLength={2000} value={refund.reason} onInput={(e) => setRefund({ ...refund, reason: e.currentTarget.value })} /></label>
          {refundError && <p class="yc-alert yc-alert--error" role="alert">{refundError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setRefunding(null)}>Назад</button>
            <button class="yc-btn" type="submit" disabled={busy}>Провести возврат</button>
          </div>
        </form>
      </Modal>
      <ReasonDialog open={reversing !== null} title={`Сторно операции №${reversing?.operation.number ?? ''}`} label="Причина сторно" confirm="Сторнировать" danger testId="reverse-dialog"
        text={<p>Операция на {reversing ? rub(reversing.operation.amountKop) : ''} будет отменена записью сторно: обе останутся в журнале, в сводке мероприятия её не будет.</p>} onClose={() => setReversing(null)}
        onConfirm={async (reason, k) => {
          await browserCall(`/finance/operations/${reversing!.operation.id}/reverse`, { method: 'POST', key: k, body: { reason } });
          const n = reversing!.operation.number;
          setReversing(null);
          await done(`Операция №${n} сторнирована.`);
        }} />
      <Modal open={linking !== null} title={`Привязать расход №${linking?.number ?? ''}`} onClose={() => setLinking(null)} testId="link-dialog">
        <form class="yc-ev__stack" novalidate onSubmit={submitLink}>
          <p>{linking ? rub(linking.amountKop) : ''}{linking?.comment ? `, ${linking.comment}` : ''}. Новой операции не будет. Накладные филиала в себестоимость не включают.</p>
          {lines.length > 0 && (
            <label class="yc-field"><span class="yc-field__label">Строка состава</span>
              <select class="yc-input" value={linkForm.line} onChange={(e) => setLinkForm({ ...linkForm, line: e.currentTarget.value })}><option value="">Без строки</option>{lines.map((l) => <option value={l.id}>{l.name}</option>)}</select></label>
          )}
          <label class="yc-check"><input type="checkbox" checked={linkForm.inCost} onChange={(e) => setLinkForm({ ...linkForm, inCost: e.currentTarget.checked })} /> Учитывать в себестоимости</label>
          {linkError && <p class="yc-alert yc-alert--error" role="alert">{linkError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setLinking(null)}>Назад</button>
            <button class="yc-btn" type="submit" disabled={busy}>Привязать</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

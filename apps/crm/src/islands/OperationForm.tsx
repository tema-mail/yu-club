// Формы дохода и расхода (S2-61, K17 №38, 40, 41; 06 §8, §13.2–13.4). Сумма вводится в рублях и переводится в
// целые копейки разбором строки (без плавающей арифметики). До сохранения – «остаток после» (K17 №38), но только
// ролям с finance.view: Администратору маршрут отвечает 403, он видит лишь результат команды (решение 02.11 K17).
// Ключ идемпотентности – один на открытую форму: двойной клик и повтор после обрыва связи дают одну операцию.
// Успех – событие yc-finance:changed: журнал (CashJournal) перечитывается сам. Исправление (K17 №45, только Владелец):
// журнал шлёт yc-finance:correct с операцией – та же форма открывается с её значениями и обязательной причиной;
// сервер делает сторно + новую операцию одной транзакцией, отказ новой (закрытый месяц и т. п.) откатывает и сторно.
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError } from '../lib/api.ts';

export interface CategoryOption { id: string; name: string; children: Array<{ id: string; name: string }> }
export interface OperationFormProps {
  branch: { id: string; name: string; timezone: string };
  canIncome: boolean;
  canExpense: boolean;
  /** finance.view: предпросмотр остатка и числа остатка в ответах. */
  full: boolean;
  /** Активные категории расхода, два уровня (K17 №46). */
  categories: CategoryOption[];
  /** finance.correct: слушать «Исправить» из записи журнала. */
  canCorrect: boolean;
}
/** Что нужно форме из операции журнала для исправления. */
export interface CorrectTarget {
  id: string; number: number; kind: string; method: Method | null; amountKop: number; source: string | null;
  categoryId: string | null; subcategoryId: string | null; comment: string | null; occurredAt: string;
}
type Kind = 'income' | 'expense';
type Method = 'cash' | 'card' | 'transfer';
interface Saved { number: number; amountKop: number; place: 'cash' | 'noncash'; balanceAfterKop?: number }

const PLACE = { cash: 'наличные', noncash: 'безнал' } as const;
const SOURCES = [
  ['event', 'Мероприятие'],
  ['extra_service', 'Доп. услуга'],
  ['other', 'Прочее поступление'],
] as const;

/** «1 234,5» → 123450 копеек; пусто, ноль, больше двух знаков после запятой – null. */
export function parseRub(input: string): number | null {
  const t = input.replace(/\s/g, '').replace(',', '.'); // \s ловит и неразрывный пробел
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const kop = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return kop > 0 ? kop : null;
}
function rub(kop: number): string {
  const abs = Math.abs(kop);
  const r = Math.trunc(abs / 100);
  return `${kop < 0 ? '−' : ''}${new Intl.NumberFormat('ru-RU').format(r)},${String(abs - r * 100).padStart(2, '0')} ₽`;
}
/** Сейчас по зоне филиала: дата и время для полей формы. */
function nowIn(tz: string): { date: string; time: string } {
  const d = new Date();
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d),
  };
}
/** Дата и время по зоне филиала → момент ISO (как localToInstant в core/time.ts). */
export function toInstant(date: string, time: string, tz: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess));
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return new Date(guess - (Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`) - guess)).toISOString();
}
const monthName = (ym: string) => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}T00:00:00Z`)).replace(' г.', '');

/** Команда с заданным ключом: повтор того же ключа – тот же ответ сервера (ADR 0004). */
async function send<T>(path: string, body: unknown, key: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите – операция не задвоится.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'INTERNAL', data.error?.message ?? 'Ошибка сервера', data.error?.details);
  return data as T;
}

export default function OperationForm(p: OperationFormProps) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [source, setSource] = useState<string>('event');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<{ currentKop: number; afterKop: number; allowed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<CorrectTarget | null>(null);
  const [reason, setReason] = useState('');
  const key = useRef('');
  const inflight = useRef(false); // двойной клик в одном такте: состояние busy ещё не перерисовано
  const dialog = useRef<HTMLDialogElement>(null);

  const kop = parseRub(amount);
  const place = method === 'cash' ? 'cash' : 'noncash';
  const category = p.categories.find((c) => c.id === categoryId);
  const today = nowIn(p.branch.timezone).date;

  // Предпросмотр «остатка после» (06 §8): только finance.view, с задержкой на ввод.
  useEffect(() => {
    setPreview(null);
    if (!p.full || !kind || kop === null || target) return; // при исправлении сторно меняет остаток – подсказка была бы неверной
    let live = true; // сумма изменилась, пока ответ в пути: подсказка прежней суммы не показывается
    const t = setTimeout(async () => {
      try {
        const r = await send<{ currentKop: number; afterKop: number; allowed: boolean }>(
          `/branches/${encodeURIComponent(p.branch.id)}/finance/preview`,
          { place, deltaKop: kind === 'income' ? kop : -kop },
          crypto.randomUUID(),
        );
        if (live) setPreview(r);
      } catch {
        if (live) setPreview(null); // предпросмотр – подсказка; окончательная проверка в команде
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, kop, place, p.full, p.branch.id, target]);

  useEffect(() => {
    if (!p.canCorrect) return;
    const onCorrect = (ev: Event) => {
      const op = (ev as CustomEvent<CorrectTarget>).detail;
      if (op.kind !== 'income' && op.kind !== 'expense') return;
      start(op.kind, op);
    };
    window.addEventListener('yc-finance:correct', onCorrect);
    return () => window.removeEventListener('yc-finance:correct', onCorrect);
  }, [p.canCorrect]);

  const start = (k: Kind, op?: CorrectTarget) => {
    const at = op ? new Date(op.occurredAt) : new Date();
    const tz = p.branch.timezone;
    setKind(k);
    setTarget(op ?? null);
    setReason('');
    setSource(op?.source && SOURCES.some(([v]) => v === op.source) ? op.source : 'event');
    setAmount(op ? rub(op.amountKop).replace(' ₽', '') : '');
    setMethod(op?.method ?? 'cash');
    setCategoryId(op?.categoryId ?? '');
    setSubcategoryId(op?.subcategoryId ?? '');
    setDate(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at));
    setTime(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at));
    setComment(op?.comment ?? '');
    setErrors({});
    setFormError('');
    setNotice('');
    key.current = crypto.randomUUID();
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
    setKind(null);
  };

  const explain = (e: unknown): { field?: string; text: string } => {
    if (!(e instanceof ApiError)) return { text: 'Не удалось сохранить. Повторите.' };
    const d = e.details ?? {};
    switch (e.code) {
      case 'COMMENT_REQUIRED':
        if (d.field === 'reason') return { field: 'reason', text: 'Укажите причину исправления.' };
        return { field: 'comment', text: 'Укажите комментарий: на что потрачены деньги.' };
      case 'SUBCATEGORY_REQUIRED': return { field: 'subcategoryId', text: 'Выберите подкатегорию.' };
      case 'CATEGORY_ARCHIVED': return { field: 'categoryId', text: 'Категория в архиве – выберите другую.' };
      case 'INVALID_AMOUNT': return { field: 'amount', text: 'Сумма – больше нуля, не больше двух знаков после запятой.' };
      case 'PERIOD_CLOSED': return { field: 'date', text: `${typeof d.month === 'string' ? `Месяц «${monthName(d.month)}»` : 'Месяц'} закрыт: операцию этим месяцем не внести. Исправление – операцией текущей датой.` };
      case 'CASH_INSUFFICIENT':
        return typeof d.currentKop === 'number' && typeof d.afterKop === 'number'
          ? { text: `Недостаточно денег (${PLACE[place]}): в кассе ${rub(d.currentKop)}, после операции было бы ${rub(d.afterKop)}. Внесите поступление или проверьте начальный остаток.` }
          : { text: `${e.message}.` };
      case 'SESSION_INCOME_VIA_PAYMENT': return { field: 'source', text: e.message };
      case 'FORBIDDEN': return { text: 'Недостаточно прав для этой операции.' };
      case 'VALIDATION_FAILED': {
        const field = typeof d.field === 'string' ? d.field : undefined;
        return { field: field === 'occurredAt' ? 'date' : field, text: e.message };
      }
      default: return { text: e.message };
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (inflight.current || !kind) return;
    const errs: Record<string, string> = {};
    if (kop === null) errs.amount = 'Введите сумму в рублях, например 1 500 или 1 500,50.';
    if (kind === 'expense' && !category) errs.categoryId = 'Выберите категорию.';
    if (kind === 'expense' && category && category.children.length > 0 && !subcategoryId) errs.subcategoryId = 'Выберите подкатегорию.';
    if (kind === 'expense' && !comment.trim()) errs.comment = 'Укажите комментарий: на что потрачены деньги.';
    if (target && !reason.trim()) errs.reason = 'Укажите причину исправления.';
    if (!date || !time) errs.date = 'Укажите дату и время.';
    else if (Date.parse(toInstant(date, time, p.branch.timezone)) > Date.now()) errs.date = 'Дата операции – не в будущем.';
    setErrors(errs);
    setFormError('');
    if (Object.keys(errs).length > 0) return;
    const occurredAt = toInstant(date, time, p.branch.timezone);
    const body = kind === 'income'
      ? { method, amountKop: kop, source, occurredAt, comment: comment.trim() || null }
      : { method, amountKop: kop, categoryId, subcategoryId: subcategoryId || null, occurredAt, comment: comment.trim() };
    setBusy(true);
    inflight.current = true;
    try {
      if (target) {
        const r = await send<{ reversal: Saved; replacement: Saved }>(`/finance/operations/${target.id}/correct`, { reason: reason.trim(), replacement: { kind, ...body } }, key.current);
        close();
        setNotice(`Операция №${target.number} исправлена: сторно №${r.reversal.number}, новая операция №${r.replacement.number} на ${rub(r.replacement.amountKop)}.`);
        window.dispatchEvent(new CustomEvent('yc-finance:changed'));
        return;
      }
      const r = await send<Saved>(`/branches/${encodeURIComponent(p.branch.id)}/finance/${kind}`, body, key.current);
      close();
      const after = r.balanceAfterKop === undefined ? '' : ` Остаток (${PLACE[r.place]}) после: ${rub(r.balanceAfterKop)}.`;
      setNotice(`${kind === 'income' ? 'Доход' : 'Расход'} №${r.number} внесён: ${rub(r.amountKop)}.${after}`);
      window.dispatchEvent(new CustomEvent('yc-finance:changed'));
    } catch (err) {
      const x = explain(err);
      if (x.field && ['amount', 'categoryId', 'subcategoryId', 'comment', 'date', 'source', 'reason'].includes(x.field)) setErrors({ [x.field]: x.text });
      else setFormError(x.text);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  if (!p.canIncome && !p.canExpense) return null;
  const err = (f: string) => errors[f] && <span class="yc-field__error" id={`op-${f}-err`}>{errors[f]}</span>;
  const inv = (f: string) => (errors[f] ? { 'aria-invalid': 'true' as const, 'aria-describedby': `op-${f}-err` } : {});

  return (
    <div class="yc-fin__actions">
      <div class="yc-tabs">
        {p.canIncome && <button class="yc-btn" type="button" onClick={() => start('income')}>Внести доход</button>}
        {p.canExpense && <button class="yc-btn" type="button" onClick={() => start('expense')}>Внести расход</button>}
      </div>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="op-saved">{notice}</p>}
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="op-title" onClose={() => setKind(null)}>
        {kind && (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="op-title">{target ? `Исправить операцию №${target.number}` : `${kind === 'income' ? 'Доход' : 'Расход'} · ${p.branch.name}`}</h2>
            {target && <p class="yc-field__hint">Исходная операция останется в журнале со сторно текущей датой; ниже – значения новой операции.</p>}
            {kind === 'income' ? (
              <label class="yc-field">
                <span class="yc-field__label">Источник</span>
                <select class="yc-input" value={source} onChange={(e) => setSource(e.currentTarget.value)} {...inv('source')}>
                  {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <span class="yc-field__hint">Доход по сеансу вносится оплатой брони, продажа сертификата – в разделе сертификатов.</span>
                {err('source')}
              </label>
            ) : (
              <>
                <label class="yc-field">
                  <span class="yc-field__label">Категория</span>
                  <select class="yc-input" value={categoryId} onChange={(e) => { setCategoryId(e.currentTarget.value); setSubcategoryId(''); }} {...inv('categoryId')}>
                    <option value="">Выберите…</option>
                    {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {err('categoryId')}
                </label>
                {category && category.children.length > 0 && (
                  <label class="yc-field">
                    <span class="yc-field__label">Подкатегория</span>
                    <select class="yc-input" value={subcategoryId} onChange={(e) => setSubcategoryId(e.currentTarget.value)} {...inv('subcategoryId')}>
                      <option value="">Выберите…</option>
                      {category.children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {err('subcategoryId')}
                  </label>
                )}
              </>
            )}
            <label class="yc-field">
              <span class="yc-field__label">Сумма, ₽</span>
              <input class="yc-input" type="text" inputMode="decimal" autoComplete="off" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} {...inv('amount')} />
              {err('amount')}
            </label>
            <div class="yc-field" role="group" aria-labelledby="op-method">
              <span class="yc-field__label" id="op-method">Способ</span>
              <div class="yc-seg">
                {(['cash', 'card', 'transfer'] as const).map((m) => (
                  <button key={m} type="button" class="yc-seg__btn" aria-pressed={method === m} onClick={() => setMethod(m)}>
                    {m === 'cash' ? 'Наличные' : m === 'card' ? 'Карта' : 'Перевод'}
                  </button>
                ))}
              </div>
            </div>
            <div class="yc-fin__period">
              <label class="yc-field">
                <span class="yc-field__label">Дата</span>
                <input class="yc-input" type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} {...inv('date')} />
              </label>
              <label class="yc-field">
                <span class="yc-field__label">Время</span>
                <input class="yc-input" type="time" value={time} onInput={(e) => setTime(e.currentTarget.value)} />
              </label>
            </div>
            {err('date')}
            <label class="yc-field">
              <span class="yc-field__label">{kind === 'expense' ? 'Комментарий (основание)' : 'Комментарий (необязательно)'}</span>
              <textarea class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment(e.currentTarget.value)} {...inv('comment')} />
              {kind === 'expense' && <span class="yc-field__hint">Например: «счёт за электричество за октябрь».</span>}
              {err('comment')}
            </label>
            {preview && (
              <p class={`yc-alert ${preview.allowed ? 'yc-alert--ok' : 'yc-alert--error'}`} data-testid="op-preview" aria-live="polite">
                Остаток ({PLACE[place]}): {rub(preview.currentKop)} → {rub(preview.afterKop)}
                {!preview.allowed && '. Денег не хватит: отрицательный остаток запрещён – внесите поступление или уменьшите сумму.'}
              </p>
            )}
            {target && (
              <label class="yc-field">
                <span class="yc-field__label">Причина исправления</span>
                <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason(e.currentTarget.value)} {...inv('reason')} />
                {err('reason')}
              </label>
            )}
            {formError && <p class="yc-alert yc-alert--error" role="alert">{formError}</p>}
            <div class="yc-dialog__actions">
              <button class="yc-btn yc-btn--ghost" type="button" onClick={close}>Отмена</button>
              <button class="yc-btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

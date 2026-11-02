// Кассовая смена филиала (S2-62, K17 §7, №49–50, 55–56). Экран есть только при включённом finance.cash_shift_enabled
// (страница рисует его по №55). Открытие и закрытие – пересчёт наличных; Администратор вводит его вслепую: ожидаемого
// остатка и расхождения он не видит ни до, ни после (сервер их не отдаёт). Расхождение (при открытии или закрытии)
// ничего не проводит само: смена ждёт решения Владельца или Директора, причина обязательна. При разнице ≠ 0 оба
// решения выравнивают кассу операцией (K17 §7 п.4): «принять» – пересчёт признан фактом, недостача уходит расходом
// «Недостача кассы», излишек – доходом «Излишек кассы»; «исправить ошибку» – нашли ошибочную операцию, корректировка. Список смен: с finance.view – все с суммами, Администратору – свои без сумм.
import { useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { errorText, rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';

export type ShiftStatus = 'open' | 'closed' | 'needs_resolution' | 'resolved';
export interface ShiftRead {
  shiftId: string; branchId: string; status: ShiftStatus; openedAt: string; openedBy: string; closedAt: string | null; closedBy: string | null;
  // только с finance.view
  openingCountedKop?: number; openingExpectedKop?: number; openingDiffKop?: number;
  closingCountedKop?: number | null; closingExpectedKop?: number | null; closingDiffKop?: number | null;
  resolution?: 'correct' | 'accept' | null; resolutionReason?: string | null;
}
export interface CashShiftProps {
  branch: { id: string; name: string; timezone: string };
  initialOpen: ShiftRead | null;
  initialList: ShiftRead[];
  canResolve: boolean;
  meId: string;
  staffNames: Record<string, string>;
}

const STATUS: Record<ShiftStatus, { text: string; cls: string }> = {
  open: { text: 'Открыта', cls: 'yc-badge--preparing' },
  closed: { text: 'Закрыта, сошлось', cls: 'yc-badge--active' },
  needs_resolution: { text: 'Расхождение – ждёт решения', cls: 'yc-badge--temporarily_closed' },
  resolved: { text: 'Расхождение решено', cls: 'yc-badge--active' },
};
const FRIENDLY: Record<string, string> = {
  CASH_SHIFT_ALREADY_OPEN: 'Смена уже открыта – экран обновлён.',
  COMMENT_REQUIRED: 'Укажите причину решения.',
  CASH_INSUFFICIENT: 'Операция уведёт кассу в минус: проверьте пересчёт.',
  PERIOD_CLOSED: 'Месяц закрыт – операцию по расхождению не провести.',
};
const errText = (e: unknown) => (e instanceof ApiError && FRIENDLY[e.code]) || errorText(e);
const signed = (kop: number) => rub(kop, true);
/** Что проводит «принять» при разнице diff (системные категории 0210). */
const acceptText = (diff: number) =>
  diff < 0 ? `недостача ${rub(-diff)} – расходом «Недостача кассы»` : diff > 0 ? `излишек ${rub(diff)} – доходом «Излишек кассы»` : 'без проводки: при закрытии сошлось';

export default function CashShift({ branch, initialOpen, initialList, canResolve, meId, staffNames }: CashShiftProps) {
  const [open, setOpen] = useState(initialOpen);
  const [list, setList] = useState(initialList);
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<ShiftRead | null>(null);
  const [action, setAction] = useState<'correct' | 'accept'>('accept');
  const [reason, setReason] = useState('');
  const [dlgError, setDlgError] = useState('');

  const tz = branch.timezone;
  const at = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const who = (id: string | null) => (id === null ? '' : id === meId ? 'вы' : (staffNames[id] ?? 'сотрудник'));
  const enc = encodeURIComponent;

  const reload = async () => {
    const [cur, l] = await Promise.all([
      browserCall<{ enabled: boolean; openShift: ShiftRead | null }>(`/branches/${enc(branch.id)}/cash-shifts/current`),
      browserCall<{ items: ShiftRead[] }>(`/branches/${enc(branch.id)}/cash-shifts?limit=20`),
    ]);
    setOpen(cur.openShift);
    setList(l.items);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const kop = count.trim() === '0' || /^0([.,]0{1,2})?$/.test(count.trim()) ? 0 : parseRub(count);
    if (kop === null) return setError('Введите пересчитанную сумму наличных в рублях, например 12 500 или 12 500,50.');
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      if (open) {
        const r = await browserCall<{ status: ShiftStatus; closingDiffKop?: number | null; closingExpectedKop?: number | null }>(`/cash-shifts/${enc(open.shiftId)}/close`, { method: 'POST', body: { countedKop: kop } });
        const text = r.status === 'closed'
          ? 'Смена закрыта: пересчёт сошёлся.'
          : r.closingDiffKop !== undefined && r.closingDiffKop !== null
            ? `Смена закрыта с расхождением ${signed(r.closingDiffKop)} (в системе ${rub(r.closingExpectedKop ?? 0)}). Нужно решение.`
            : 'Смена закрыта. Пересчёт передан Директору: если есть расхождение, он его разберёт.';
        setNotice({ ok: r.status === 'closed' || r.closingDiffKop === undefined, text }); // Администратору – без «красного» намёка на разницу
      } else {
        await browserCall(`/branches/${enc(branch.id)}/cash-shifts/open`, { method: 'POST', body: { countedKop: kop } });
        setNotice({ ok: true, text: 'Смена открыта.' });
      }
      setCount('');
      await reload();
    } catch (err) {
      setError(errText(err));
      if (err instanceof ApiError && ['CASH_SHIFT_ALREADY_OPEN', 'VALIDATION_FAILED'].includes(err.code)) await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const openResolve = (s: ShiftRead) => {
    setTarget(s);
    setAction('accept');
    setReason('');
    setDlgError('');
    (document.getElementById('shift-resolve') as HTMLDialogElement | null)?.showModal();
  };
  const closeResolve = () => (document.getElementById('shift-resolve') as HTMLDialogElement | null)?.close();
  const resolve = async (e: Event) => {
    e.preventDefault();
    if (busy || !target) return;
    if (!reason.trim()) return setDlgError('Укажите причину – без неё решение не сохранить.');
    setBusy(true);
    setDlgError('');
    try {
      await browserCall(`/cash-shifts/${enc(target.shiftId)}/resolve`, { method: 'POST', body: { action, reason: reason.trim() } });
      closeResolve();
      const diff = target.closingDiffKop ?? 0;
      setNotice({ ok: true, text: action === 'correct' ? `Ошибка исправлена: корректировка кассы на ${signed(diff)}.` : `Пересчёт принят: ${acceptText(diff)}.` });
      await reload();
    } catch (err) {
      setDlgError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const pending = list.filter((s) => s.status === 'needs_resolution');
  const sums = (s: ShiftRead) => s.openingCountedKop !== undefined;

  return (
    <section class="yc-panel" aria-labelledby="shift-title" data-testid="cash-shift">
      <h2 id="shift-title">
        Кассовая смена{' '}
        <span class={`yc-badge ${open ? STATUS.open.cls : ''}`} data-testid="shift-state">{open ? `Открыта с ${at(open.openedAt)} (${who(open.openedBy)})` : 'Не открыта'}</span>
      </h2>
      <p class={`yc-alert ${notice ? (notice.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="shift-notice">{notice?.text ?? ''}</p>

      {open && sums(open) && (
        <p class="yc-field__hint" data-testid="shift-opening">
          При открытии пересчитано {rub(open.openingCountedKop!)}, в системе было {rub(open.openingExpectedKop!)}
          {open.openingDiffKop ? ` – расхождение ${signed(open.openingDiffKop)}` : ' – сошлось'}.
        </p>
      )}

      <form class="yc-form" novalidate onSubmit={submit} data-testid="shift-form">
        <div class="yc-field">
          <label class="yc-field__label" for="shift-count">{open ? 'Пересчёт наличных при закрытии, ₽' : 'Пересчёт наличных при открытии, ₽'}</label>
          <input id="shift-count" class="yc-input" inputMode="decimal" autocomplete="off" value={count} onInput={(e) => setCount((e.currentTarget as HTMLInputElement).value)} />
          <span class="yc-field__hint">Пересчитайте деньги в кассе и введите, сколько насчитали. Сумму из системы до ввода не показываем – сверит сервер.</span>
        </div>
        <p class="yc-alert yc-alert--error" role="alert">{error}</p>
        <div><button type="submit" class="yc-btn" disabled={busy}>{open ? 'Закрыть смену' : 'Открыть смену'}</button></div>
      </form>

      {canResolve && pending.length > 0 && (
        <div data-testid="shift-pending">
          <h3 class="yc-field__label">Требуют решения: {pending.length}</h3>
          <ul class="yc-desk__list">
            {pending.map((s) => (
              <li class="yc-desk__row" key={s.shiftId}>
                <strong>Смена {at(s.openedAt)} – {s.closedAt ? at(s.closedAt) : ''}</strong>
                <span>
                  {s.closingCountedKop !== null && s.closingCountedKop !== undefined && `закрытие: насчитано ${rub(s.closingCountedKop)}, в системе ${rub(s.closingExpectedKop ?? 0)}, разница ${signed(s.closingDiffKop ?? 0)}`}
                  {s.openingDiffKop ? `; при открытии разница ${signed(s.openingDiffKop)}` : ''}
                </span>
                <span><button type="button" class="yc-btn yc-btn--ghost" onClick={() => openResolve(s)}>Решить…</button></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {list.length > 0 && (
        <details>
          <summary class="yc-link">Последние смены{list.some(sums) ? '' : ' (ваши)'}</summary>
          <ul class="yc-desk__list" data-testid="shift-list">
            {list.map((s) => (
              <li class="yc-desk__row" key={s.shiftId}>
                <span>{at(s.openedAt)} ({who(s.openedBy)}){s.closedAt ? ` – ${at(s.closedAt)} (${who(s.closedBy)})` : ''}</span>
                <span>
                  <span class={`yc-badge ${STATUS[s.status].cls}`}>{STATUS[s.status].text}</span>
                  {sums(s) && s.closingDiffKop !== null && s.closingDiffKop !== undefined && ` разница ${signed(s.closingDiffKop)}`}
                  {s.resolution && ` · ${s.resolution === 'correct' ? 'исправлена ошибка (корректировка)' : 'пересчёт принят'}: ${s.resolutionReason ?? ''}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <dialog id="shift-resolve" class="yc-dialog" aria-labelledby="shift-resolve-title">
        {target && (
          <form class="yc-dialog__body" novalidate onSubmit={resolve}>
            <h2 id="shift-resolve-title">Решение по расхождению</h2>
            <dl class="yc-props yc-bk__diff">
              <dt>В системе</dt><dd>{rub(target.closingExpectedKop ?? 0)}</dd>
              <dt>Насчитано</dt><dd>{rub(target.closingCountedKop ?? 0)}</dd>
              <dt>Разница</dt><dd><strong>{signed(target.closingDiffKop ?? 0)}</strong>{target.openingDiffKop ? ` (при открытии ${signed(target.openingDiffKop)})` : ''}</dd>
            </dl>
            <fieldset class="yc-week">
              <legend class="yc-field__label">Что сделать</legend>
              <label class="yc-check"><input type="radio" name="shift-action" checked={action === 'accept'} onChange={() => setAction('accept')} />
                Принять пересчёт: {acceptText(target.closingDiffKop ?? 0)}</label>
              <label class="yc-check"><input type="radio" name="shift-action" checked={action === 'correct'} disabled={!target.closingDiffKop} onChange={() => setAction('correct')} />
                Исправить ошибку: нашли ошибочную операцию – корректировка кассы на {signed(target.closingDiffKop ?? 0)}</label>
              <span class="yc-field__hint">В обоих случаях остаток наличных станет равен пересчёту; операция попадёт в журнал со ссылкой на смену.</span>
            </fieldset>
            <div class="yc-field">
              <label class="yc-field__label" for="shift-reason">Причина *</label>
              <textarea id="shift-reason" class="yc-input" rows={3} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
            </div>
            <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={closeResolve}>Не сейчас</button>
              <button type="submit" class="yc-btn" disabled={busy}>Сохранить решение</button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}

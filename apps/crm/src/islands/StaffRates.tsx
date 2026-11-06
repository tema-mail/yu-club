// Карточка сотрудника, блок «Оплата и планирование» (S3-70, K18 §2–§3, №309–310). Ставки только дописываются: ошибочная исправляется новой записью с той
// же датой и ссылкой corrects, причина обязательна. Нет ставки на сегодня – «Не настроена ставка оплаты», это не ноль. Менять ставки – только Владелец
// (payroll.rate.manage), Директор видит историю своей зоны; решает сервер. «Временно не работает» – не статус входа: новые смены запрещены,
// запланированные не отменяются, а показываются списком «требуют решения». Суммы – целые копейки, ввод разбирается строкой (lib/shifts.ts).
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { fmtDate, kopToInput, parseKopZero, shiftError, type ShiftDto, type StaffRate } from '../lib/shifts.ts';
import { rub } from './CashJournal.tsx';

export type PlanningStatus = 'available' | 'on_leave';
export interface StaffRatesProps {
  staffId: string;
  /** null – нет права payroll.view: блока ставок нет. */
  initialRates: StaffRate[] | null;
  canManage: boolean;
  canPlanning: boolean;
  /** Текущее значение из журнала staff.planning_changed; null – прочитать не удалось. */
  initialPlanning: PlanningStatus | null;
  /** Даты работы: начало и конец действующих назначений (K1 staff_assignments). */
  workFrom: string | null;
  workTo: string | null;
  today: string;
  staffNames: Record<string, string>;
}
interface Draft { corrects: string | null; validFrom: string; hourly: string; fee: string; reason: string }

export default function StaffRates({ staffId, initialRates, canManage, canPlanning, initialPlanning, workFrom, workTo, today, staffNames }: StaffRatesProps) {
  const [rates, setRates] = useState(initialRates);
  const [draft, setDraft] = useState<Draft>({ corrects: null, validFrom: today, hourly: '', fee: '', reason: '' });
  const [planning, setPlanning] = useState(initialPlanning);
  const [pending, setPending] = useState<ShiftDto[]>([]);
  const [affected, setAffected] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [planNotice, setPlanNotice] = useState('');
  const [error, setError] = useState('');
  const [dlgError, setDlgError] = useState('');
  const rateDlg = useRef<HTMLDialogElement>(null);
  const planDlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const openNew = () => {
    setDraft({ corrects: null, validFrom: today, hourly: '', fee: '', reason: '' });
    setDlgError('');
    rateDlg.current?.showModal();
  };
  const openFix = (r: StaffRate) => {
    setDraft({ corrects: r.id, validFrom: r.validFrom, hourly: kopToInput(r.hourlyKop), fee: kopToInput(r.attendanceFeeKop), reason: '' });
    setDlgError('');
    rateDlg.current?.showModal();
  };
  const saveRate = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const hourlyKop = parseKopZero(draft.hourly);
    const attendanceFeeKop = parseKopZero(draft.fee);
    if (hourlyKop === null || attendanceFeeKop === null) return setDlgError('Введите суммы в рублях, например 350 или 350,50. Ноль допустим.');
    if (!draft.reason.trim()) return setDlgError('Укажите причину.');
    setBusy(true);
    setDlgError('');
    try {
      const res = await browserCall<{ rate: StaffRate; affectedShiftIds: string[] }>(`/staff/${enc(staffId)}/rates`, {
        method: 'POST',
        body: { validFrom: draft.validFrom, hourlyKop, attendanceFeeKop, reason: draft.reason.trim(), ...(draft.corrects ? { corrects: draft.corrects } : {}) },
      });
      const list = await browserCall<{ items: StaffRate[] }>(`/staff/${enc(staffId)}/rates`);
      setRates(list.items);
      setAffected(res.affectedShiftIds);
      setNotice('Ставка сохранена.');
      rateDlg.current?.close();
    } catch (err) {
      setDlgError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };
  const togglePlanning = async () => {
    if (busy) return;
    const next: PlanningStatus = planning === 'on_leave' ? 'available' : 'on_leave';
    setBusy(true);
    setError('');
    try {
      const res = await browserCall<{ planningStatus: PlanningStatus; futureShiftsNeedingDecision: ShiftDto[] }>(`/staff/${enc(staffId)}/planning`, { method: 'PATCH', body: { planningStatus: next } });
      setPlanning(res.planningStatus);
      setPending(res.futureShiftsNeedingDecision);
      setPlanNotice(res.planningStatus === 'on_leave' ? 'Отмечено: временно не работает. Новые смены запрещены.' : 'Сотрудник снова доступен для планирования.');
    } catch (err) {
      setError(shiftError(err));
    } finally {
      planDlg.current?.close();
      setBusy(false);
    }
  };

  // API отдаёт от новых к старым: первая запись с датой ≤ сегодня действует; запись с той же датой выше по списку заменила эту.
  const current = rates?.find((r) => r.validFrom <= today) ?? null;
  const replaced = (r: StaffRate, i: number) => (rates ?? []).slice(0, i).some((x) => x.validFrom === r.validFrom);
  const untilOf = (r: StaffRate) => (rates ?? []).filter((x) => x.validFrom > r.validFrom).map((x) => x.validFrom).sort()[0] ?? null;

  return (
    <>
      <section class="yc-panel" aria-labelledby="work-title" data-testid="staff-work">
        <h2 id="work-title">Работа и планирование</h2>
        <dl class="yc-props">
          <dt>Даты работы</dt>
          <dd data-testid="work-dates">{workFrom ? `с ${fmtDate(workFrom)}` : 'назначений нет'}{workTo ? ` по ${fmtDate(workTo)}` : ''}</dd>
          <dt>Планирование</dt>
          <dd data-testid="planning-status">
            {planning === 'on_leave' && <span class="yc-badge yc-badge--temporarily_closed">Временно не работает</span>}
            {planning === 'available' && <span class="yc-badge yc-badge--active">Доступен для смен</span>}
            {planning === null && <span class="yc-badge">Нет данных</span>}
          </dd>
        </dl>
        {canPlanning && (
          <div>
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => planDlg.current?.showModal()}>
              {planning === 'on_leave' ? 'Вернуть в планирование' : 'Временно не работает'}
            </button>
          </div>
        )}
        <p class="yc-alert yc-alert--ok" role="status" data-testid="planning-notice">{planNotice}</p>
        <p class="yc-alert yc-alert--error" role="alert">{error}</p>
        {pending.length > 0 && (
          <div data-testid="planning-pending">
            <h3 class="yc-field__label">Требуют решения: {pending.length}</h3>
            <p class="yc-field__hint">Запланированные смены не отменены: перенесите или отмените каждую.</p>
            <ul class="yc-desk__list">
              {pending.map((s) => <li class="yc-desk__row" key={s.id}><a href={`/shifts/${enc(s.id)}`}>Смена {fmtDate(s.localDate)}</a></li>)}
            </ul>
          </div>
        )}
      </section>

      {rates && (
        <section class="yc-panel" aria-labelledby="rates-title" data-testid="staff-rates">
          <h2 id="rates-title">Ставки</h2>
          {current ? (
            <dl class="yc-props" data-testid="rate-current">
              <dt>Стоимость часа</dt><dd>{rub(current.hourlyKop)}</dd>
              <dt>Ставка за выход</dt><dd>{rub(current.attendanceFeeKop)}</dd>
              <dt>Действует с</dt><dd>{fmtDate(current.validFrom)}</dd>
            </dl>
          ) : (
            <p class="yc-alert yc-alert--error" data-testid="rate-missing">Не настроена ставка оплаты. Смены сотрудника не начисляются и не считаются нулём.</p>
          )}
          {canManage && <div><button type="button" class="yc-btn" onClick={openNew}>Новая ставка</button></div>}
          <p class="yc-alert yc-alert--ok" role="status" data-testid="rate-notice">{notice}</p>
          {affected && affected.length > 0 && (
            <div data-testid="rate-affected">
              <h3 class="yc-field__label">Пересчитываются смены: {affected.length}</h3>
              <ul class="yc-desk__list">
                {affected.map((id) => <li class="yc-desk__row" key={id}><a href={`/shifts/${enc(id)}`}>Открыть смену</a></li>)}
              </ul>
            </div>
          )}
          {rates.length === 0 ? <p class="yc-empty">История пуста: ставку ещё не задавали.</p> : (
            <table class="yc-table" data-testid="rate-history">
              <thead><tr><th>Действует</th><th>Час</th><th>За выход</th><th>Причина</th><th>Кто задал</th>{canManage && <th>Действие</th>}</tr></thead>
              <tbody>
                {rates.map((r, i) => (
                  <tr key={r.id} data-testid="rate-row">
                    <td class="yc-table__main">
                      с {fmtDate(r.validFrom)}{untilOf(r) ? ` до ${fmtDate(untilOf(r)!)}` : ''}
                      {replaced(r, i) && <> <span class="yc-badge">заменена исправлением</span></>}
                    </td>
                    <td data-label="Час">{rub(r.hourlyKop)}</td>
                    <td data-label="За выход">{rub(r.attendanceFeeKop)}</td>
                    <td data-label="Причина">{r.reason}</td>
                    <td data-label="Кто задал">{staffNames[r.createdBy] ?? 'сотрудник'}</td>
                    {canManage && <td>{!replaced(r, i) && <button type="button" class="yc-link" onClick={() => openFix(r)}>Исправить</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <dialog ref={rateDlg} class="yc-dialog" aria-labelledby="rate-dlg-title">
        <form class="yc-dialog__body" novalidate onSubmit={saveRate} data-testid="rate-form">
          <h2 id="rate-dlg-title">{draft.corrects ? 'Исправить ставку' : 'Новая ставка'}</h2>
          <p class="yc-field__hint">{draft.corrects ? 'Ошибочная запись останется в истории, новая перекроет её с той же даты.' : 'Ставка общая для всех филиалов сотрудника. Смены закрытых периодов не пересчитываются.'}</p>
          <div class="yc-field">
            <label class="yc-field__label" for="rate-from">Действует с</label>
            <input id="rate-from" class="yc-input" type="date" required disabled={draft.corrects !== null} value={draft.validFrom} onInput={(e) => set({ validFrom: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="rate-hourly">Стоимость часа, ₽</label>
            <input id="rate-hourly" class="yc-input" inputMode="decimal" autocomplete="off" value={draft.hourly} onInput={(e) => set({ hourly: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="rate-fee">Ставка за выход, ₽</label>
            <input id="rate-fee" class="yc-input" inputMode="decimal" autocomplete="off" value={draft.fee} onInput={(e) => set({ fee: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="rate-reason">Причина *</label>
            <textarea id="rate-reason" class="yc-input" rows={2} maxLength={2000} value={draft.reason} onInput={(e) => set({ reason: (e.currentTarget as HTMLTextAreaElement).value })} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => rateDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Сохранить ставку</button>
          </div>
        </form>
      </dialog>

      <dialog ref={planDlg} class="yc-dialog" aria-labelledby="plan-dlg-title">
        <div class="yc-dialog__body">
          <h2 id="plan-dlg-title">{planning === 'on_leave' ? 'Вернуть в планирование?' : 'Отметить «Временно не работает»?'}</h2>
          <p>{planning === 'on_leave' ? 'На сотрудника снова можно будет ставить смены.' : 'Вход в CRM не меняется. Новые смены будут запрещены, уже запланированные останутся и попадут в список «требуют решения».'}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => planDlg.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn" disabled={busy} onClick={() => void togglePlanning()}>Подтвердить</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

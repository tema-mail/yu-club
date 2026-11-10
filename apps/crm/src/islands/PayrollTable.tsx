// «Зарплата» (S3-74, 05 §12.4, K18 §7, §9–§10, №311–313, №318): период, фильтры, таблица ведомостей, прогноз отдельно от факта, детализация «каждая сумма раскрывается сменами
// и записями», статусы, закрытие периода. Закрыть нельзя – понятный список причин PAYROLL_PERIOD_HAS_UNRESOLVED со ссылками на смены. Закрытый период – только корректировки.
// Расчёт управленческий, подпись постоянна. Суммы – целые копейки с сервера, складывает сервер. Директор видит суммы своей зоны; закрытие, выплата, корректировка – только Владелец.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { addDays, inZone } from '../lib/booking.ts';
import { useLatest } from '../lib/latest.ts';
import {
  fmtDate, fmtMinutes, monthEnd, shiftError, SHIFT_STATUS, STATEMENT_STATUS, UNRESOLVED_REASON,
  type PayrollPeriod, type PayrollReport, type PayrollStatement, type ReportRow, type StatementStatus,
} from '../lib/shifts.ts';
import { rub } from './CashJournal.tsx';
import PayoutDialog from './PayoutDialog.tsx';
import PenaltyForm from './PenaltyForm.tsx';

export interface PayBranch { id: string; name: string; cityId: string; cityName: string; timezone: string }
export interface PayrollTableProps {
  initialPeriods: PayrollPeriod[];
  branches: PayBranch[];
  today: string;
  penaltiesEnabled: boolean;
  isOwner: boolean;
  can: { periodManage: boolean; review: boolean; ready: boolean; paid: boolean; expense: boolean; correct: boolean; penalty: boolean };
}
interface Unresolved { shiftId: string; staffId?: string; branchId?: string; reason: string }
const ENTRY: Record<string, string> = { 'payroll.accrual': 'Начисление', 'payroll.penalty': 'Штраф', 'payroll.bonus': 'Премия', 'payroll.correction': 'Корректировка', 'payroll.payout': 'Выплата' };

export default function PayrollTable({ initialPeriods, branches, today, penaltiesEnabled, isOwner, can }: PayrollTableProps) {
  const [periods, setPeriods] = useState(initialPeriods);
  const [periodId, setPeriodId] = useState(initialPeriods.find((p) => p.status === 'open')?.id ?? initialPeriods[0]?.id ?? '');
  const [cityId, setCityId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [statementFilter, setStatementFilter] = useState<'' | StatementStatus>('');
  const [report, setReport] = useState<PayrollReport | null>(null);
  const [statements, setStatements] = useState<PayrollStatement[]>([]);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unresolved, setUnresolved] = useState<{ list: Unresolved[]; extra: string[]; rates: number } | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [dlgError, setDlgError] = useState('');
  const closeDlg = useRef<HTMLDialogElement>(null);
  const newDlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const period = periods.find((p) => p.id === periodId) ?? null;
  const cities = [...new Map(branches.map((b) => [b.cityId, b.cityName])).entries()];
  const inCity = branches.filter((b) => !cityId || b.cityId === cityId);
  const branchOf = (id: string | null) => branches.find((b) => b.id === id);
  const statementOf = (id: string) => statements.find((s) => s.staffId === id) ?? null;

  const query = (extra = '') => `/payroll/report?periodId=${enc(periodId)}${cityId ? `&cityId=${enc(cityId)}` : ''}${branchId ? `&branchIds=${enc(branchId)}` : ''}${extra}`;
  const latest = useLatest(); // смена периода или фильтра: ответ прежнего запроса не подменяет свежую таблицу
  const load = async () => {
    if (!periodId) return;
    const fresh = latest();
    setLoading(true);
    setError('');
    try {
      const [r, st] = await Promise.all([
        browserCall<PayrollReport>(query(`${staffId ? `&staffId=${enc(staffId)}` : ''}${statementFilter ? `&statementStatus=${statementFilter}` : ''}`)),
        browserCall<{ items: PayrollStatement[] }>(`/payroll/periods/${enc(periodId)}/statements`),
      ]);
      if (!fresh()) return;
      setReport(r);
      setStatements(st.items);
      if (!staffId) setPeople(r.rows.map((x) => ({ id: x.staffId, name: x.name })));
    } catch (e) {
      if (!fresh()) return;
      setError(shiftError(e));
      setReport(null);
    } finally {
      if (fresh()) setLoading(false);
    }
  };
  const loadDetail = async (id: string) => {
    try {
      const r = await browserCall<PayrollReport>(query(`&staffId=${enc(id)}&detail=true`));
      setDetail(r.rows[0] ?? null);
    } catch (e) {
      setError(shiftError(e));
    }
  };
  const refresh = async () => {
    await load();
    if (openRow) await loadDetail(openRow);
  };
  useEffect(() => {
    setOpenRow(null);
    setDetail(null);
    setUnresolved(null);
    void load();
  }, [periodId, cityId, branchId, staffId, statementFilter]);

  const toggle = (id: string) => {
    if (openRow === id) {
      setOpenRow(null);
      return;
    }
    setOpenRow(id);
    setDetail(null);
    void loadDetail(id);
  };
  const guarded = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      setError(shiftError(e));
    } finally {
      setBusy(false);
    }
  };
  const calculate = () => guarded(async () => {
    await browserCall(`/payroll/periods/${enc(periodId)}/calculate`, { method: 'POST', body: {} });
    setNotice('Ведомости пересчитаны.');
    await refresh();
  });
  const setStatus = (s: PayrollStatement, status: 'checked' | 'ready' | 'disputed' | 'calculated') => guarded(async () => {
    try {
      await browserCall(`/payroll/statements/${enc(s.id)}/status`, { method: 'POST', body: { rowVersion: s.rowVersion, status } });
      setNotice(`Статус ведомости: ${STATEMENT_STATUS[status].text.toLowerCase()}.`);
    } finally {
      await refresh();
    }
  });
  const openNew = () => {
    const last = periods.map((p) => p.to).sort().at(-1);
    const from = last ? addDays(last, 1) : `${today.slice(0, 7)}-01`;
    setNewFrom(from);
    setNewTo(monthEnd(from));
    setDlgError('');
    newDlg.current?.showModal();
  };
  const createPeriod = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setDlgError('');
    try {
      const p = await browserCall<PayrollPeriod>('/payroll/periods', { method: 'POST', body: { from: newFrom, to: newTo } });
      setPeriods([p, ...periods]);
      setPeriodId(p.id);
      newDlg.current?.close();
    } catch (err) {
      setDlgError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };
  const closePeriod = async (e: Event) => {
    e.preventDefault();
    if (busy || !period) return;
    setBusy(true);
    setNotice('');
    setUnresolved(null);
    setError('');
    try {
      const p = await browserCall<PayrollPeriod>(`/payroll/periods/${enc(period.id)}/close`, { method: 'POST', body: closeReason.trim() ? { reason: closeReason.trim() } : {} });
      setPeriods(periods.map((x) => (x.id === p.id ? p : x)));
      setNotice('Период закрыт. Ведомости зафиксированы, дальше – только корректировки.');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PAYROLL_PERIOD_HAS_UNRESOLVED') {
        const list = (err.details?.reasons as Unresolved[] | undefined) ?? [];
        const named = new Set(list.map((x) => x.shiftId));
        const extra = ((err.details?.shiftIds as string[] | undefined) ?? []).filter((id) => !named.has(id));
        setUnresolved({ list, extra, rates: ((err.details?.rateIds as string[] | undefined) ?? []).length });
      } else setError(shiftError(err));
    } finally {
      closeDlg.current?.close();
      setBusy(false);
    }
  };
  const nameOf = (id: string | undefined) => people.find((x) => x.id === id)?.name ?? 'Сотрудник';
  const closed = period?.status === 'closed';
  const showPenalty = penaltiesEnabled || (report?.rows.some((r) => r.penaltiesKop !== 0) ?? false);
  const t = report?.totals;
  const hmAt = (iso: string, branch: string) => {
    const tz = branchOf(branch)?.timezone;
    return tz ? inZone(iso, tz).hm : inZone(iso, 'UTC').hm;
  };

  return (
    <>
      <section class="yc-panel" aria-label="Период и фильтры" data-testid="payroll-bar">
        <p class="yc-alert yc-sh-note" data-testid="payroll-note">Управленческий расчёт, не бухгалтерия. Система не ведёт налоги и кадровый учёт и не утверждает соответствие суммы ТК РФ.</p>
        <div class="yc-list__bar">
          <div class="yc-field">
            <label class="yc-field__label" for="pay-period">Период</label>
            <select id="pay-period" class="yc-input" value={periodId} onChange={(e) => setPeriodId((e.currentTarget as HTMLSelectElement).value)}>
              {periods.map((p) => <option key={p.id} value={p.id}>{fmtDate(p.from)} – {fmtDate(p.to)}{p.status === 'closed' ? ' (закрыт)' : ''}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-city">Город</label>
            <select id="pay-city" class="yc-input" value={cityId} onChange={(e) => { setBranchId(''); setCityId((e.currentTarget as HTMLSelectElement).value); }}>
              <option value="">Все</option>
              {cities.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-branch">Филиал</label>
            <select id="pay-branch" class="yc-input" value={branchId} onChange={(e) => setBranchId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Все</option>
              {inCity.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-staff">Сотрудник</label>
            <select id="pay-staff" class="yc-input" value={staffId} onChange={(e) => setStaffId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Все</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-st">Статус ведомости</label>
            <select id="pay-st" class="yc-input" value={statementFilter} onChange={(e) => setStatementFilter((e.currentTarget as HTMLSelectElement).value as '' | StatementStatus)}>
              <option value="">Все</option>
              {(Object.keys(STATEMENT_STATUS) as StatementStatus[]).map((k) => <option key={k} value={k}>{STATEMENT_STATUS[k].text}</option>)}
            </select>
          </div>
        </div>
        {period && (
          <p data-testid="period-status">
            {closed
              ? <><span class="yc-badge yc-badge--archived">Период закрыт</span> Менять смены и записи нельзя, исправление – только корректировкой в открытом периоде.</>
              : <span class="yc-badge yc-badge--active">Период открыт</span>}
          </p>
        )}
        <div class="yc-bk__actions">
          {can.review && !closed && period && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void calculate()}>Рассчитать ведомости</button>}
          {can.periodManage && !closed && period && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setCloseReason(''); closeDlg.current?.showModal(); }}>Закрыть период</button>}
          {can.periodManage && <button type="button" class="yc-btn yc-btn--ghost" onClick={openNew}>Новый период</button>}
        </div>
        <p class="yc-alert yc-alert--ok" role="status" data-testid="pay-notice">{notice}</p>
        <p class="yc-alert yc-alert--error" role="alert" data-testid="pay-error">{error}</p>
        {unresolved && (
          <div class="yc-alert yc-alert--error" role="alert" data-testid="close-unresolved">
            <strong>Период не закрыт. Нерешённых смен: {unresolved.list.length + unresolved.extra.length}.</strong>
            <ul class="yc-sh-list">
              {unresolved.list.map((u) => (
                <li key={u.shiftId} data-testid="unresolved-item">
                  <a href={`/shifts/${enc(u.shiftId)}`}>{nameOf(u.staffId)}{u.branchId ? `, ${branchOf(u.branchId)?.name ?? 'филиал'}` : ''}</a>: {UNRESOLVED_REASON[u.reason] ?? u.reason}
                </li>
              ))}
              {unresolved.extra.map((id) => <li key={id} data-testid="unresolved-item"><a href={`/shifts/${enc(id)}`}>Открыть смену</a>: начисление ещё пересчитывается</li>)}
              {unresolved.rates > 0 && <li>Новые ставки ещё применяются ({unresolved.rates}): повторите закрытие через минуту.</li>}
            </ul>
          </div>
        )}
      </section>

      {periods.length === 0 && <section class="yc-panel"><p class="yc-empty" data-testid="no-periods">Расчётных периодов ещё нет.{can.periodManage ? ' Создайте первый кнопкой «Новый период».' : ' Их создаёт Владелец.'}</p></section>}

      {t && (
        <section class="yc-pay-tiles" aria-label="Итоги периода" data-testid="payroll-totals">
          <div class="yc-pay-tile yc-pay-tile--forecast" data-testid="total-forecast">
            <span class="yc-field__hint">Прогноз по плановым сменам</span>
            <strong>{rub(t.forecastKop)}</strong>
            <span class="yc-field__hint">Не начислено, в журнал не пишется</span>
          </div>
          <div class="yc-pay-tile" data-testid="total-accrued"><span class="yc-field__hint">Начислено по факту</span><strong>{rub(t.accruedKop)}</strong></div>
          {showPenalty && <div class="yc-pay-tile" data-testid="total-penalties"><span class="yc-field__hint">Штрафы и удержания</span><strong>{rub(t.penaltiesKop + t.otherDeductionsKop)}</strong></div>}
          <div class="yc-pay-tile" data-testid="total-corrections"><span class="yc-field__hint">Корректировки</span><strong>{rub(t.correctionsKop, true)}</strong></div>
          <div class="yc-pay-tile" data-testid="total-topay"><span class="yc-field__hint">К выплате</span><strong>{rub(t.toPayKop)}</strong></div>
          <div class="yc-pay-tile" data-testid="total-issues">
            <span class="yc-field__hint">Требуют внимания</span>
            <strong>Смен без решения: {t.unclosedShifts}</strong>
            <span class="yc-field__hint">Пустых интервалов: {t.emptyIntervals}</span>
          </div>
        </section>
      )}

      {report && (
        <section class="yc-panel" aria-label="Ведомости" data-testid="payroll-table">
          {loading && <p class="yc-empty" role="status">Загрузка…</p>}
          {report.rows.length === 0 && <p class="yc-empty" data-testid="payroll-empty">В этом периоде и с этими фильтрами нет смен и начислений.</p>}
          {report.rows.length > 0 && (
            <div class="yc-pay-scroll">
              <table class="yc-table">
                <thead>
                  <tr><th>Сотрудник</th><th>Смены</th><th>Оплачено</th><th>Прогноз</th><th>Начислено</th>{showPenalty && <th>Штрафы</th>}<th>Корр.</th><th>К выплате</th><th>Статус</th><th>Выплата</th><th>Подробно</th></tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => {
                    const st = r.statementStatus ? STATEMENT_STATUS[r.statementStatus] : null;
                    const expanded = openRow === r.staffId;
                    return [
                      <tr key={r.staffId} data-testid="payroll-row" data-staff={r.staffId}>
                        <td class="yc-table__main">{r.name}</td>
                        <td data-label="Смены">{r.workedShifts} из {r.plannedShifts}{r.noShows > 0 ? `, невыходов ${r.noShows}` : ''}</td>
                        <td data-label="Оплачено">{fmtMinutes(r.paidMinutes)}</td>
                        <td data-label="Прогноз" class="yc-pay-forecast" data-testid="row-forecast">{rub(r.forecastKop)}</td>
                        <td data-label="Начислено" data-testid="row-accrued">{rub(r.accruedKop)}</td>
                        {showPenalty && <td data-label="Штрафы" data-testid="row-penalties">{rub(r.penaltiesKop + r.otherDeductionsKop)}</td>}
                        <td data-label="Корр." data-testid="row-corrections">{rub(r.correctionsKop, true)}</td>
                        <td data-label="К выплате" data-testid="row-topay"><strong>{rub(r.toPayKop)}</strong></td>
                        <td data-label="Статус" data-testid="row-status">{st ? <span class={`yc-badge ${st.cls}`}>{st.text}</span> : <span class="yc-badge">Не рассчитана</span>}</td>
                        <td data-label="Выплата">{r.actualPayoutDate ? fmtDate(r.actualPayoutDate) : r.plannedPayoutDate ? `план ${fmtDate(r.plannedPayoutDate)}` : '–'}</td>
                        <td><button type="button" class="yc-link" aria-expanded={expanded} onClick={() => toggle(r.staffId)}>{expanded ? 'Свернуть' : 'Детализация'}</button></td>
                      </tr>,
                      expanded && (
                        <tr key={`${r.staffId}-d`} class="yc-pay-detailrow">
                          <td colSpan={showPenalty ? 11 : 10}>
                            {!detail && <p class="yc-empty" role="status">Загрузка…</p>}
                            {detail && (
                              <div class="yc-pay-detail" data-testid="payroll-detail">
                                {detail.hourlyKop !== null
                                  ? <p class="yc-field__hint">Ставка на конец периода: {rub(detail.hourlyKop)} в час, {rub(detail.attendanceFeeKop ?? 0)} за выход.</p>
                                  : <p class="yc-alert yc-alert--error">Не настроена ставка оплаты.</p>}
                                {detail.branches.length > 0 && (
                                  <ul class="yc-sh-list" data-testid="detail-branches">
                                    {detail.branches.map((b) => <li key={b.branchId}>{branchOf(b.branchId)?.name ?? 'Филиал'}: отработано смен {b.workedShifts}, {fmtMinutes(b.paidMinutes)}, начислено {rub(b.accruedKop)}, прогноз {rub(b.forecastKop)}</li>)}
                                  </ul>
                                )}
                                <h3 class="yc-field__label">Смены</h3>
                                {(detail.detail?.shifts.length ?? 0) === 0 && <p class="yc-empty">Смен нет.</p>}
                                <ul class="yc-desk__list">
                                  {detail.detail?.shifts.map((s) => (
                                    <li class="yc-desk__row" key={s.id} data-testid="detail-shift">
                                      <a href={`/shifts/${enc(s.id)}`}>{fmtDate(s.localDate)} {hmAt(s.plannedStart, s.branchId)}–{hmAt(s.plannedEnd, s.branchId)}, {branchOf(s.branchId)?.name ?? 'филиал'}</a>
                                      <span>
                                        {SHIFT_STATUS[s.status].text}
                                        {s.paidMinutes !== null && `, к оплате ${fmtMinutes(s.paidMinutes)}`}
                                        {s.forecastKop !== null && `, прогноз ${rub(s.forecastKop)}`}
                                        {s.status === 'worked' && `, начислено ${rub(s.accruedKop)}`}
                                        {s.flags.rateMissing && ', не настроена ставка'}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <h3 class="yc-field__label">Записи журнала</h3>
                                {(detail.detail?.entries.length ?? 0) === 0 && <p class="yc-empty">Записей нет.</p>}
                                <ul class="yc-desk__list">
                                  {detail.detail?.entries.map((e) => (
                                    <li class="yc-desk__row" key={e.id} data-testid="detail-entry">
                                      <span>{fmtDate(e.date)} · {ENTRY[e.kind] ?? e.kind}: <strong>{rub(e.amountKop, true)}</strong>{e.basis ? ` · ${e.basis}` : ''}</span>
                                    </li>
                                  ))}
                                </ul>
                                {statementBlock(r)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <dialog ref={closeDlg} class="yc-dialog" aria-labelledby="pay-close-title">
        <form class="yc-dialog__body" novalidate onSubmit={closePeriod} data-testid="close-form">
          <h2 id="pay-close-title">Закрыть период?</h2>
          {period && <p>{fmtDate(period.from)} – {fmtDate(period.to)}. Итоги ведомостей зафиксируются, открыть период снова нельзя: исправления – только корректировками.</p>}
          <div class="yc-field">
            <label class="yc-field__label" for="pay-close-reason">Комментарий</label>
            <textarea id="pay-close-reason" class="yc-input" rows={2} maxLength={2000} value={closeReason} onInput={(e) => setCloseReason((e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => closeDlg.current?.close()}>Не закрывать</button>
            <button type="submit" class="yc-btn" disabled={busy}>Закрыть период</button>
          </div>
        </form>
      </dialog>

      <dialog ref={newDlg} class="yc-dialog" aria-labelledby="pay-new-title">
        <form class="yc-dialog__body" novalidate onSubmit={createPeriod} data-testid="new-period-form">
          <h2 id="pay-new-title">Новый расчётный период</h2>
          <p class="yc-field__hint">Периоды идут встык, общие на сеть.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-new-from">С</label>
            <input id="pay-new-from" class="yc-input" type="date" value={newFrom} onInput={(e) => setNewFrom((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="pay-new-to">По</label>
            <input id="pay-new-to" class="yc-input" type="date" value={newTo} onInput={(e) => setNewTo((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert" data-testid="new-period-error">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => newDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Создать период</button>
          </div>
        </form>
      </dialog>
    </>
  );

  /** Ведомость сотрудника в детализации: статусы по K18 §9. */
  function statementBlock(r: ReportRow) {
    const s = statementOf(r.staffId);
    const zoneBranches = branches.filter((b) => r.branches.some((x) => x.branchId === b.id));
    const penalties = (
      <PenaltyForm key={`${r.staffId}-${periodId}`} staffId={r.staffId} staffName={r.name} periodId={periodId} statementId={s?.id ?? null}
        shifts={(detail?.detail?.shifts ?? []).map((x) => ({ id: x.id, label: fmtDate(x.localDate) }))}
        branches={(zoneBranches.length > 0 ? zoneBranches : branches).map((b) => ({ id: b.id, name: b.name }))} today={today} enabled={penaltiesEnabled}
        canPenalty={can.penalty} canCorrect={can.correct} isOwner={isOwner} closed={closed} onChange={refresh} />
    );
    if (!s) {
      return (
        <>
          <p class="yc-empty" data-testid="no-statement">Ведомости ещё нет: {closed ? 'сотрудник не попал в закрытие периода.' : 'нажмите «Рассчитать ведомости».'}</p>
          {penalties}
        </>
      );
    }
    return (
      <div class="yc-pay-statement" data-testid="statement">
        <h3 class="yc-field__label">Ведомость: <span class={`yc-badge ${STATEMENT_STATUS[s.status].cls}`} data-testid="statement-status">{STATEMENT_STATUS[s.status].text}</span></h3>
        {s.needsReview.length > 0 && (
          <div class="yc-alert yc-alert--error" data-testid="statement-review">
            Нерешённые смены:
            <ul class="yc-sh-list">
              {s.needsReview.map((u) => <li key={u.shiftId}><a href={`/shifts/${enc(u.shiftId)}`}>Открыть смену</a>: {UNRESOLVED_REASON[u.reason] ?? u.reason}</li>)}
            </ul>
          </div>
        )}
        <div class="yc-bk__actions">
          {can.review && s.status === 'calculated' && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void setStatus(s, 'checked')}>Проверено</button>}
          {can.ready && s.status === 'checked' && closed && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void setStatus(s, 'ready')}>Готова к выплате</button>}
          {can.review && ['calculated', 'checked', 'ready'].includes(s.status) && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void setStatus(s, 'disputed')}>Спорная</button>}
          {can.review && s.status === 'disputed' && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void setStatus(s, 'calculated')}>Вернуть в расчёт</button>}
        </div>
        {s.status === 'checked' && !closed && <p class="yc-field__hint">«Готова к выплате» – после закрытия периода: выплачивать по меняющимся итогам нельзя.</p>}
        <PayoutDialog key={s.id} statement={s} staffName={r.name} branches={branches.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone }))} today={today} canPaid={can.paid} canExpense={can.expense} onChange={refresh} />
        {penalties}
      </div>
    );
  }
}

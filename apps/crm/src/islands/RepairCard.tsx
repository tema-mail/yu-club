// Карточка ремонта (S3-80, K19 №343–344; 10 §13.5): вверху номер, статус, приоритет, просроченный план; блокировка ресурса с затронутыми
// бронями и мероприятиями; три даты и первое описание (не перезаписывается); диагностика и план отдельно от факта, исполнитель – снимком;
// статусы по таблице K19 §6 с обязательным комментарием; согласование Владельца; закрытие и расход; документы; хронология.
// Записи ремонта не удаляются: ошибочно созданный – статус «Отменён» окном внутри записи, он остаётся в списке.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import {
  EXECUTOR_KIND, IMPACT, PRIORITY, REPAIR_BADGE, REPAIR_NEXT, REPAIR_STATUS, errorText, fmtAt, isOpenRepair, isPlanOverdue, ruDate,
  type ExecutorDto, type RepairCardDto, type RepairDto, type RepairPriority, type RepairStatus,
} from '../lib/equipment.ts';
import Attachments from './Attachments.tsx';
import { rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';
import RepairBlockPanel from './RepairBlockPanel.tsx';
import RepairClose, { type StillBlocked } from './RepairClose.tsx';

export interface RepairCardProps {
  initial: RepairCardDto;
  equipmentName: string;
  timezone: string;
  branchName: string;
  branches: Array<{ id: string; name: string }>;
  rooms: Array<{ id: string; name: string }>;
  units: Array<{ id: string; name: string }>;
  executors: ExecutorDto[];
  staff: Array<{ id: string; name: string }>;
  cancelReasons: Array<{ id: string; name: string }>;
  actions: string[];
  justRegistered: boolean;
}
const TIMELINE: Record<string, string> = {
  'repair.registered': 'Зарегистрирован', 'repair.updated': 'Изменён план или диагностика', 'repair.status_changed': 'Смена статуса', 'repair.approved': 'Решение по согласованию',
  'repair.closed': 'Закрыт', 'repair.block_linked': 'Поставлена блокировка', 'repair.expense_linked': 'Связан расход',
};
const STILL: Record<StillBlocked['reason'], string> = { other_open_repair: 'на этом месте есть другой открытый ремонт', not_selected: 'не отмечена к снятию' };
const NEXT_LABEL: Partial<Record<RepairStatus, string>> = { awaiting_approval: 'На согласование', cancelled: 'Отменить ремонт', done_pending_check: 'На проверку' };
const rubInput = (kop: number | null) => (kop === null ? '' : String(kop / 100).replace('.', ','));

export default function RepairCard(p: RepairCardProps) {
  const [r, setR] = useState<RepairCardDto>(p.initial);
  const [executors, setExecutors] = useState(p.executors);
  const [notice, setNotice] = useState('');
  const [still, setStill] = useState<StillBlocked[]>([]);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(r.diagnostics ?? '');
  const [cause, setCause] = useState(r.cause ?? '');
  const [partsUsed, setPartsUsed] = useState(r.partsUsed ?? '');
  const [conclusion, setConclusion] = useState(r.conclusion ?? '');
  const [priority, setPriority] = useState<RepairPriority>(r.priority);
  const [executorId, setExecutorId] = useState(r.executor.id ?? '');
  const [works, setWorks] = useState(r.plan.works ?? '');
  const [start, setStart] = useState(r.plan.start ?? '');
  const [end, setEnd] = useState(r.plan.end ?? '');
  const [cost, setCost] = useState(rubInput(r.plan.costKop));
  const [responsible, setResponsible] = useState(r.plan.responsibleStaffId ?? '');
  const [parts, setParts] = useState(r.plan.partsNeeded);
  const [planComment, setPlanComment] = useState(r.plan.comment ?? '');
  const dialog = useRef<HTMLDialogElement>(null);
  const [dlg, setDlg] = useState<{ kind: 'status'; to: RepairStatus } | { kind: 'approve' | 'reject' } | { kind: 'executor' } | null>(null);
  const [comment, setComment] = useState('');
  const [exName, setExName] = useState('');
  const [exKind, setExKind] = useState<ExecutorDto['kind']>('service_center');
  const [exPhone, setExPhone] = useState('');
  const [dialogError, setDialogError] = useState('');

  const can = (a: string) => p.actions.includes(a);
  const open = isOpenRepair(r);
  const canEdit = open && can('repair.manage');
  const overdue = isPlanOverdue(r, p.timezone);
  const needsApproval = r.status === 'awaiting_approval' || (r.approval.required && !r.approval.approvedAt && ['planned', 'in_repair', 'awaiting_parts'].includes(r.status));
  const staffName = (id: string | null) => p.staff.find((s) => s.id === id)?.name ?? (id ? 'Сотрудник' : '–');

  const applyFields = (x: RepairDto) => {
    setDiagnostics(x.diagnostics ?? '');
    setCause(x.cause ?? '');
    setPartsUsed(x.partsUsed ?? '');
    setConclusion(x.conclusion ?? '');
    setPriority(x.priority);
    setExecutorId(x.executor.id ?? '');
    setWorks(x.plan.works ?? '');
    setStart(x.plan.start ?? '');
    setEnd(x.plan.end ?? '');
    setCost(rubInput(x.plan.costKop));
    setResponsible(x.plan.responsibleStaffId ?? '');
    setParts(x.plan.partsNeeded);
    setPlanComment(x.plan.comment ?? '');
  };
  const reload = async () => {
    const x = await browserCall<RepairCardDto>(`/repairs/${r.id}`);
    setR(x);
    return x;
  };
  const changed = (text: string) => {
    setNotice(text);
    void reload();
  };
  const save = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setFormError('');
    const costKop = cost.trim() ? parseRub(cost) : null;
    if (cost.trim() && costKop === null) return setFormError('Плановая сумма – в рублях, например 3000 или 3000,50.');
    if (start && end && end < start) return setFormError('Конец плана раньше начала.');
    setBusy(true);
    const orNull = (v: string) => v.trim() || null;
    try {
      const x = await browserCall<RepairDto>(`/repairs/${r.id}`, {
        method: 'PATCH',
        body: {
          rowVersion: r.rowVersion, diagnostics: orNull(diagnostics), cause: orNull(cause), partsUsed: orNull(partsUsed), conclusion: orNull(conclusion), priority, executorId: executorId || null,
          plan: { works: orNull(works), start: start || null, end: end || null, costKop, responsibleStaffId: responsible || null, partsNeeded: parts, comment: orNull(planComment) },
        },
      });
      setNotice(x.approval.required && !x.approval.approvedAt ? 'Сохранено. План выше порога: нужно согласование Владельца.' : 'Сохранено.');
      await reload();
    } catch (err) {
      setFormError(errorText(err));
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') applyFields(await reload());
    } finally {
      setBusy(false);
    }
  };
  const openDlg = (d: NonNullable<typeof dlg>) => {
    setDlg(d);
    setComment('');
    setDialogError('');
    setExName('');
    setExPhone('');
    setExKind('service_center');
    dialog.current?.showModal();
  };
  const closeDlg = () => {
    dialog.current?.close();
    setDlg(null);
  };
  const submitDialog = async (e: Event) => {
    e.preventDefault();
    if (busy || !dlg) return;
    if (dlg.kind !== 'executor' && !comment.trim()) return setDialogError('Укажите комментарий – без него не сохранить.');
    if (dlg.kind === 'executor' && !exName.trim()) return setDialogError('Укажите наименование или ФИО.');
    setBusy(true);
    setDialogError('');
    try {
      if (dlg.kind === 'status') {
        await browserCall(`/repairs/${r.id}/status`, { method: 'POST', body: { rowVersion: r.rowVersion, to: dlg.to, comment: comment.trim() } });
        setNotice(`Статус: ${REPAIR_STATUS[dlg.to]}.`);
      } else if (dlg.kind === 'executor') {
        const x = await browserCall<ExecutorDto>('/repair-executors', { method: 'POST', body: { kind: exKind, name: exName.trim(), ...(exPhone.trim() ? { phone: exPhone.trim() } : {}) } });
        setExecutors((l) => [...l, x]);
        setExecutorId(x.id);
        closeDlg();
        return;
      } else {
        await browserCall(`/repairs/${r.id}/approve`, { method: 'POST', body: { rowVersion: r.rowVersion, decision: dlg.kind, comment: comment.trim() } });
        setNotice(dlg.kind === 'approve' ? 'План согласован.' : 'Согласование отклонено.');
      }
      closeDlg();
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REPAIR_APPROVAL_REQUIRED') setDialogError('План выше порога: сначала согласование Владельца. Переведите ремонт «На согласование» из диагностики.');
      else if (err instanceof ApiError && err.code === 'COMMENT_REQUIRED') setDialogError('Укажите комментарий – без него не сохранить.');
      else setDialogError(errorText(err));
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="yc-eq">
      <section class="yc-panel yc-eq__top" aria-label="Главное">
        <h1 data-testid="rp-number">{r.number}</h1>
        <div class="yc-eq__facts">
          <span class={`yc-badge yc-badge--${REPAIR_BADGE[r.status]}`} data-testid="rp-status">{REPAIR_STATUS[r.status]}</span>
          <span>{PRIORITY[r.priority]} приоритет</span>
          {overdue && <span class="yc-badge yc-badge--decide" data-testid="rp-overdue">План просрочен: {ruDate(r.plan.end)}</span>}
          {r.approval.approvedAt && <span class="yc-badge yc-badge--active" data-testid="rp-approved">Согласовано</span>}
        </div>
        <p><a href={`/equipment/${r.equipmentId}`} data-testid="rp-equipment">{p.equipmentName}</a> · {p.branchName}</p>
      </section>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="rp-notice">{notice}</p>}
      {still.length > 0 && (
        <section class="yc-eq__warn" data-testid="rp-still">
          <strong>Ремонт закрыт, но ресурс ещё заблокирован ({still.length}): закрытие само его не открывает.</strong>
          <ul class="yc-eq__rows">{still.map((s) => <li key={s.blockId}>Блокировка осталась: {STILL[s.reason]}.</li>)}</ul>
        </section>
      )}

      <RepairBlockPanel
        repair={r}
        timezone={p.timezone}
        rooms={p.rooms}
        units={p.units}
        cancelReasons={p.cancelReasons}
        canBlock={can('block.manage')}
        canCancelBooking={can('booking.cancel')}
        canReschedule={can('booking.reschedule')}
        justRegistered={p.justRegistered}
        onChanged={changed}
      />

      <section class="yc-panel" aria-labelledby="rp-facts">
        <h2 id="rp-facts">Что случилось</h2>
        <dl class="yc-props">
          <dt>Поломка</dt><dd data-testid="rp-broken">{r.brokenAtUnknown ? 'Дата неизвестна' : fmtAt(r.brokenAt, p.timezone)}</dd>
          <dt>Обнаружено</dt><dd data-testid="rp-detected">{fmtAt(r.detectedAt, p.timezone)}</dd>
          <dt>Зарегистрировано</dt><dd>{fmtAt(r.registeredAt, p.timezone)}</dd>
          <dt>Описание</dt><dd data-testid="rp-symptoms">{r.symptoms}</dd>
          <dt>Влияние</dt><dd>{IMPACT[r.impact]}</dd>
          <dt>Сообщил</dt><dd>{r.reportedBy.name ?? staffName(r.reportedBy.staffId)}</dd>
          <dt>Повтор ремонта</dt><dd>{r.previousRepairId ? <a href={`/repairs/${r.previousRepairId}`}>Прошлый ремонт</a> : '–'}</dd>
          <dt>Простой по блокировкам</dt><dd>{r.downtime.hasBlocks ? `${Math.round(r.downtime.minutes / 60)} ч` : 'Блокировок не было – это не простой'}</dd>
        </dl>
      </section>

      <section class="yc-panel" aria-labelledby="rp-status-title">
        <h2 id="rp-status-title">Статус и согласование</h2>
        {needsApproval && (
          <p class="yc-eq__warn" data-testid="rp-needs-approval">{can('repair.approve') ? 'План выше порога – нужно ваше решение.' : 'План выше порога – ждёт согласования Владельца.'}</p>
        )}
        <div class="yc-eq__actions">
          {needsApproval && can('repair.approve') && <button type="button" class="yc-btn" onClick={() => openDlg({ kind: 'approve' })}>Согласовать…</button>}
          {needsApproval && can('repair.approve') && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => openDlg({ kind: 'reject' })}>Отклонить…</button>}
          {can('repair.manage') && REPAIR_NEXT[r.status].map((to) => (
            <button key={to} type="button" class={`yc-btn yc-btn--ghost${to === 'cancelled' ? ' yc-btn--danger-text' : ''}`} onClick={() => openDlg({ kind: 'status', to })}>{NEXT_LABEL[to] ?? REPAIR_STATUS[to]}…</button>
          ))}
        </div>
        {!open && <p class="yc-eq__muted">{r.status === 'closed' ? `Закрыт ${fmtAt(r.completedAt, p.timezone)}.` : 'Отменён: запись осталась в списке, оборудование статус не меняет само.'}</p>}
      </section>

      <section class="yc-panel" aria-labelledby="rp-plan">
        <h2 id="rp-plan">Диагностика и план</h2>
        {canEdit ? (
          <form class="yc-form yc-form--wide" novalidate onSubmit={save} data-testid="rp-plan-form">
            <label class="yc-field"><span class="yc-field__label">Диагностика</span><textarea class="yc-input" rows={2} maxLength={4000} value={diagnostics} onInput={(e) => setDiagnostics((e.currentTarget as HTMLTextAreaElement).value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Причина</span><input class="yc-input" maxLength={4000} value={cause} onInput={(e) => setCause((e.currentTarget as HTMLInputElement).value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Что планируем сделать</span><textarea class="yc-input" rows={2} maxLength={4000} value={works} onInput={(e) => setWorks((e.currentTarget as HTMLTextAreaElement).value)} /></label>
            <div class="yc-eq__pair">
              <label class="yc-field"><span class="yc-field__label">План: начало</span><input class="yc-input" type="date" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">План: конец</span><input class="yc-input" type="date" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Плановая сумма, ₽</span><input class="yc-input" inputMode="decimal" value={cost} onInput={(e) => setCost((e.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Приоритет</span>
                <select class="yc-input" value={priority} onChange={(e) => setPriority((e.currentTarget as HTMLSelectElement).value as RepairPriority)}>{(Object.keys(PRIORITY) as RepairPriority[]).map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}</select>
              </label>
              <label class="yc-field"><span class="yc-field__label">Ответственный</span>
                <select class="yc-input" value={responsible} onChange={(e) => setResponsible((e.currentTarget as HTMLSelectElement).value)}><option value="">Не назначен</option>{p.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
              <label class="yc-field"><span class="yc-field__label">Исполнитель</span>
                <select class="yc-input" value={executorId} onChange={(e) => setExecutorId((e.currentTarget as HTMLSelectElement).value)}><option value="">Не выбран</option>{executors.map((x) => <option key={x.id} value={x.id}>{x.name} ({EXECUTOR_KIND[x.kind]})</option>)}</select>
              </label>
            </div>
            {can('repair.executor.manage') && <div class="yc-eq__actions"><button type="button" class="yc-btn yc-btn--ghost" onClick={() => openDlg({ kind: 'executor' })}>Новый исполнитель…</button></div>}
            <label class="yc-check"><input type="checkbox" checked={parts} onChange={(e) => setParts((e.currentTarget as HTMLInputElement).checked)} />Нужны запчасти</label>
            <label class="yc-field"><span class="yc-field__label">Использованные запчасти</span><input class="yc-input" maxLength={4000} value={partsUsed} onInput={(e) => setPartsUsed((e.currentTarget as HTMLInputElement).value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Заключение</span><input class="yc-input" maxLength={4000} value={conclusion} onInput={(e) => setConclusion((e.currentTarget as HTMLInputElement).value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Комментарий к плану</span><input class="yc-input" maxLength={4000} value={planComment} onInput={(e) => setPlanComment((e.currentTarget as HTMLInputElement).value)} /></label>
            <p class="yc-alert yc-alert--error" role="alert">{formError}</p>
            <div class="yc-eq__actions"><button type="submit" class="yc-btn" disabled={busy}>Сохранить план</button></div>
          </form>
        ) : (
          <dl class="yc-props" data-testid="rp-plan-view">
            <dt>Диагностика</dt><dd>{r.diagnostics ?? '–'}</dd>
            <dt>Причина</dt><dd>{r.cause ?? '–'}</dd>
            <dt>Что планируем</dt><dd>{r.plan.works ?? '–'}</dd>
            <dt>Сроки плана</dt><dd>{ruDate(r.plan.start)} – {ruDate(r.plan.end)}</dd>
            <dt>Плановая сумма</dt><dd>{r.plan.costKop === null ? '–' : rub(r.plan.costKop)}</dd>
            <dt>Ответственный</dt><dd>{staffName(r.plan.responsibleStaffId)}</dd>
            <dt>Исполнитель</dt><dd>{r.executor.snapshot?.name ?? '–'}</dd>
            <dt>Выполненные работы</dt><dd>{r.worksDone ?? '–'}</dd>
            <dt>Запчасти</dt><dd>{r.partsUsed ?? '–'}</dd>
            <dt>Заключение</dt><dd>{r.conclusion ?? '–'}</dd>
          </dl>
        )}
      </section>

      <RepairClose
        repair={r}
        timezone={p.timezone}
        branches={p.branches}
        executors={executors}
        canClose={can('repair.close') || can('repair.accept')}
        canExpense={can('repair.expense.create') && can('finance.expense.create')}
        canWriteOff={can('equipment.write_off')}
        onChanged={changed}
        onClosed={(res) => {
          setStill(res.stillBlocked);
          changed(`Ремонт закрыт. Итоговый статус оборудования применён.`);
        }}
      />

      <Attachments ownerType="repair" ownerId={r.id} timezone={p.timezone} canAttach={can('repair.attach')} />

      <section class="yc-panel" aria-labelledby="rp-history">
        <h2 id="rp-history">Хронология</h2>
        {r.timeline.length === 0 && <p class="yc-empty">Событий пока нет.</p>}
        <ul class="yc-eq__rows" data-testid="rp-timeline">
          {r.timeline.map((t) => (
            <li class="yc-eq__row" key={t.id}>
              <strong>{TIMELINE[t.action] ?? t.action}</strong>
              <span class="yc-eq__muted">{fmtAt(t.at, p.timezone)}</span>
              {t.reason && <span>{t.reason}</span>}
            </li>
          ))}
        </ul>
      </section>

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="rp-dialog-title" onClose={() => setDlg(null)}>
        <form class="yc-dialog__body" novalidate onSubmit={submitDialog}>
          {dlg?.kind === 'status' && <h2 id="rp-dialog-title">{dlg.to === 'cancelled' ? 'Отменить ремонт как ошибочный?' : `Перевести: ${REPAIR_STATUS[dlg.to]}`}</h2>}
          {dlg?.kind === 'status' && dlg.to === 'cancelled' && <p class="yc-field__hint" data-testid="rp-cancel-note">Ремонты не удаляются: запись уйдёт в архив со статусом «Отменён» и останется доступна по фильтру. Статус оборудования вернёте вручную.</p>}
          {dlg?.kind === 'approve' && <h2 id="rp-dialog-title">Согласовать план</h2>}
          {dlg?.kind === 'reject' && <h2 id="rp-dialog-title">Отклонить план</h2>}
          {dlg?.kind === 'executor' ? (
            <>
              <h2 id="rp-dialog-title">Новый исполнитель</h2>
              <label class="yc-field"><span class="yc-field__label">Тип</span>
                <select class="yc-input" value={exKind} onChange={(e) => setExKind((e.currentTarget as HTMLSelectElement).value as ExecutorDto['kind'])}>{(Object.keys(EXECUTOR_KIND) as Array<ExecutorDto['kind']>).map((k) => <option key={k} value={k}>{EXECUTOR_KIND[k]}</option>)}</select>
              </label>
              <label class="yc-field"><span class="yc-field__label">Наименование или ФИО *</span><input class="yc-input" maxLength={300} value={exName} onInput={(e) => setExName((e.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Телефон</span><input class="yc-input" type="tel" maxLength={40} value={exPhone} onInput={(e) => setExPhone((e.currentTarget as HTMLInputElement).value)} /></label>
            </>
          ) : (
            <label class="yc-field"><span class="yc-field__label">Комментарий *</span><textarea class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLTextAreaElement).value)} /></label>
          )}
          <p class="yc-alert yc-alert--error" role="alert">{dialogError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={closeDlg}>Не менять</button>
            <button type="submit" class="yc-btn" disabled={busy}>Сохранить</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

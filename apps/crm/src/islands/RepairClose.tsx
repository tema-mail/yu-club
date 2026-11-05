// Закрытие ремонта и расход (S3-80, K19 №346–347, §7, §10; 10 §13.5). Закрытие: результат, дата, итоговый статус, сумма либо «без затрат»
// с комментарием, исполнитель, гарантия на работы, какие блокировки снять – снятие только явное, stillBlocked показываем после закрытия.
// Расход – одна операция кассы по кнопке с подтверждением, связанная с ремонтом; ключ Idempotency-Key живёт, пока открыто окно: повтор
// нажатия или повтор после сбоя – та же операция (K19 §17). Уже внесённый в кассу расход связывается без новой операции (№347 link).
import { useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError, browserCall } from '../lib/api.ts';
import { today } from '../lib/booking.ts';
import { CLOSE_FIELD, EQUIPMENT_STATUS, PAYMENT, errorText, fmtAt, fromLocalInput, toLocalInput, type EquipmentStatus, type ExecutorDto, type RepairDto } from '../lib/equipment.ts';
import { rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';

export interface StillBlocked { blockId: string; reason: 'other_open_repair' | 'not_selected' }
export interface RepairCloseProps {
  repair: RepairDto;
  timezone: string;
  branches: Array<{ id: string; name: string }>;
  executors: ExecutorDto[];
  canClose: boolean;
  canExpense: boolean;
  canWriteOff: boolean;
  onClosed: (r: { repair: RepairDto; stillBlocked: StillBlocked[] }) => void;
  onChanged: (notice: string) => void;
}
interface OperationRow { id: string; number: number; amountKop: number; occurredAt: string; comment: string | null }
type Dlg = 'close' | 'expense' | 'link';

/** POST с заранее выданным ключом: повтор отправки из того же окна – тот же ответ сервера. */
async function postWithKey<T>(path: string, body: unknown, key: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key }, credentials: 'same-origin', body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите: операция не задвоится.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'INTERNAL', data?.error?.message ?? 'Ошибка сервера', data?.error?.details);
  return data as T;
}

export default function RepairClose(p: RepairCloseProps) {
  const r = p.repair;
  const dialog = useRef<HTMLDialogElement>(null);
  const key = useRef('');
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [works, setWorks] = useState('');
  const [completedAt, setCompletedAt] = useState('');
  const [finalStatus, setFinalStatus] = useState<EquipmentStatus>('in_service');
  const [noCost, setNoCost] = useState(false);
  const [amount, setAmount] = useState('');
  const [costComment, setCostComment] = useState('');
  const [executorId, setExecutorId] = useState('');
  const [hasWarranty, setHasWarranty] = useState(false);
  const [wFrom, setWFrom] = useState('');
  const [wTo, setWTo] = useState('');
  const [wTerms, setWTerms] = useState('');
  const [lift, setLift] = useState<string[]>([]);
  const [payer, setPayer] = useState(r.branchId);
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>('card');
  const [occurredAt, setOccurredAt] = useState('');
  const [comment, setComment] = useState('');
  const [ops, setOps] = useState<OperationRow[]>([]);
  const [operationId, setOperationId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeBlocks = r.blocks.filter((b) => b.active);
  const canCloseNow = r.status === 'done_pending_check' && p.canClose;
  const money = p.canExpense && r.status !== 'cancelled' && !r.noCost;
  const remainder = Math.max(0, (r.actualCostKop ?? r.plan.costKop ?? 0) - r.payment.paidKop);
  const rubText = (kop: number) => (kop > 0 ? String(kop / 100).replace('.', ',') : '');

  const open = (k: Dlg) => {
    setDlg(k);
    setError('');
    key.current = crypto.randomUUID();
    if (k === 'close') {
      setWorks(r.worksDone ?? r.plan.works ?? '');
      setCompletedAt(toLocalInput(Date.now(), p.timezone));
      setFinalStatus('in_service');
      setNoCost(false);
      setAmount(rubText(r.plan.costKop ?? 0));
      setCostComment('');
      setExecutorId(r.executor.id ?? '');
      setHasWarranty(false);
      setWFrom(today(p.timezone));
      setWTo('');
      setWTerms('');
      setLift([]);
    } else if (k === 'expense') {
      setPayer(r.branchId);
      setMethod('card');
      setAmount(rubText(remainder));
      setOccurredAt(toLocalInput(Date.now(), p.timezone));
      setComment('');
    } else {
      setOperationId('');
      setOps([]);
      const to = today(p.timezone);
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
      browserCall<{ items: OperationRow[] }>(`/branches/${r.branchId}/finance/operations?kind=expense&from=${from}&to=${to}&limit=200`)
        .then((res) => setOps(res.items.filter((o) => !r.payment.operationIds.includes(o.id)).reverse()))
        .catch((e: unknown) => setError(errorText(e)));
    }
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
    setDlg(null);
  };
  const toggleLift = (id: string, on: boolean) => setLift((l) => (on ? [...l, id] : l.filter((x) => x !== id)));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || !dlg) return;
    setError('');
    const kop = amount.trim() ? parseRub(amount) : null;
    if (dlg === 'close') {
      if (!works.trim()) return setError('Опишите выполненные работы или укажите, что ремонт не потребовался.');
      if (!completedAt) return setError('Укажите дату завершения.');
      if (noCost && !costComment.trim()) return setError('«Без затрат» – только с комментарием.');
      if (!noCost && kop === null) return setError('Укажите фактическую сумму или отметьте «без затрат».');
      if (hasWarranty && (!wFrom || !wTo || wTo < wFrom)) return setError('Проверьте даты гарантии.');
    }
    if (dlg === 'expense') {
      if (kop === null) return setError('Введите сумму расхода в рублях.');
      if (!occurredAt) return setError('Укажите дату оплаты.');
    }
    if (dlg === 'link' && !operationId) return setError('Выберите расход из кассы.');
    setBusy(true);
    try {
      if (dlg === 'close') {
        const res = await postWithKey<{ repair: RepairDto; stillBlocked: StillBlocked[] }>(`/repairs/${r.id}/close`, {
          rowVersion: r.rowVersion, worksDone: works.trim(), completedAt: fromLocalInput(completedAt, p.timezone), finalEquipmentStatus: finalStatus,
          ...(noCost ? { noCost: true, costComment: costComment.trim() } : { actualCostKop: kop }),
          executorId: executorId || null,
          ...(hasWarranty ? { warranty: { startsOn: wFrom, endsOn: wTo, ...(wTerms.trim() ? { terms: wTerms.trim() } : {}) } } : {}),
          ...(lift.length ? { liftBlockIds: lift } : {}),
        }, key.current);
        close();
        p.onClosed(res);
      } else if (dlg === 'expense') {
        await postWithKey(`/repairs/${r.id}/expense`, { branchId: payer, method, amountKop: kop, occurredAt: fromLocalInput(occurredAt, p.timezone), ...(comment.trim() ? { comment: comment.trim() } : {}) }, key.current);
        close();
        p.onChanged('Расход создан в кассе и связан с ремонтом.');
      } else {
        await postWithKey(`/repairs/${r.id}/expense/link`, { operationId }, key.current);
        close();
        p.onChanged('Расход из кассы связан с ремонтом, новой операции нет.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REPAIR_CLOSE_INCOMPLETE') {
        const fields = (err.details?.fields as string[] | undefined) ?? [];
        setError(`Для закрытия не хватает: ${[...new Set(fields)].map((f) => CLOSE_FIELD[f] ?? f).join(', ')}.`);
      } else if (err instanceof ApiError && err.code === 'OPERATION_ALREADY_LINKED') {
        setError('Эта операция уже связана с другим объектом: второй раз учесть её нельзя.');
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="yc-panel" aria-labelledby="rp-money">
      <h2 id="rp-money">Закрытие и деньги</h2>
      <dl class="yc-props" data-testid="rp-payment">
        <dt>План</dt><dd>{r.plan.costKop === null ? '–' : rub(r.plan.costKop)}</dd>
        <dt>Факт</dt><dd>{r.noCost ? 'Без затрат' : r.actualCostKop === null ? '–' : rub(r.actualCostKop)}</dd>
        <dt>Оплачено по кассе</dt><dd data-testid="rp-paid">{rub(r.payment.paidKop)} · {PAYMENT[r.payment.status]}{r.payment.operationIds.length ? ` · операций: ${r.payment.operationIds.length}` : ''}</dd>
        <dt>Последняя оплата</dt><dd>{fmtAt(r.payment.lastPaidAt, p.timezone)}</dd>
      </dl>
      <p class="yc-field__hint">Источник истины – касса: сумма оплаты считается по связанным операциям, сторно их исключает.</p>
      <div class="yc-eq__actions">
        {canCloseNow && <button type="button" class="yc-btn" onClick={() => open('close')}>Закрыть ремонт…</button>}
        {money && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('expense')}>Создать расход…</button>}
        {money && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('link')}>Связать расход из кассы…</button>}
      </div>
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="rp-money-title" onClose={() => setDlg(null)}>
        <form class="yc-dialog__body" novalidate onSubmit={submit}>
          {dlg === 'close' && (
            <>
              <h2 id="rp-money-title">Закрыть ремонт {r.number}</h2>
              <label class="yc-field"><span class="yc-field__label">Выполненные работы *</span><textarea class="yc-input" rows={3} maxLength={4000} value={works} onInput={(e) => setWorks((e.currentTarget as HTMLTextAreaElement).value)} /></label>
              <div class="yc-eq__pair">
                <label class="yc-field"><span class="yc-field__label">Дата завершения *</span><input class="yc-input" type="datetime-local" value={completedAt} onInput={(e) => setCompletedAt((e.currentTarget as HTMLInputElement).value)} /></label>
                <label class="yc-field"><span class="yc-field__label">Итоговый статус оборудования *</span>
                  <select class="yc-input" value={finalStatus} onChange={(e) => setFinalStatus((e.currentTarget as HTMLSelectElement).value as EquipmentStatus)}>
                    {(Object.keys(EQUIPMENT_STATUS) as EquipmentStatus[]).filter((s) => p.canWriteOff || (s !== 'written_off' && s !== 'lost')).map((s) => <option key={s} value={s}>{EQUIPMENT_STATUS[s]}</option>)}
                  </select>
                </label>
                <label class="yc-field"><span class="yc-field__label">Исполнитель</span>
                  <select class="yc-input" value={executorId} onChange={(e) => setExecutorId((e.currentTarget as HTMLSelectElement).value)}>
                    <option value="">Не указан</option>
                    {p.executors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </label>
                {!noCost && <label class="yc-field"><span class="yc-field__label">Фактическая сумма, ₽ *</span><input class="yc-input" inputMode="decimal" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} /></label>}
              </div>
              <label class="yc-check"><input type="checkbox" checked={noCost} onChange={(e) => setNoCost((e.currentTarget as HTMLInputElement).checked)} />Без затрат</label>
              {noCost && <label class="yc-field"><span class="yc-field__label">Почему без затрат *</span><input class="yc-input" maxLength={2000} value={costComment} onInput={(e) => setCostComment((e.currentTarget as HTMLInputElement).value)} /></label>}
              <label class="yc-check"><input type="checkbox" checked={hasWarranty} onChange={(e) => setHasWarranty((e.currentTarget as HTMLInputElement).checked)} />Дана гарантия на работы</label>
              {hasWarranty && (
                <div class="yc-eq__pair">
                  <label class="yc-field"><span class="yc-field__label">Гарантия с</span><input class="yc-input" type="date" value={wFrom} onInput={(e) => setWFrom((e.currentTarget as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Гарантия по</span><input class="yc-input" type="date" value={wTo} onInput={(e) => setWTo((e.currentTarget as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Условия</span><input class="yc-input" maxLength={2000} value={wTerms} onInput={(e) => setWTerms((e.currentTarget as HTMLInputElement).value)} /></label>
                </div>
              )}
              {activeBlocks.length > 0 && (
                <fieldset class="yc-field" data-testid="rp-lift">
                  <legend class="yc-field__label">Снять блокировки</legend>
                  {activeBlocks.map((b) => <label class="yc-check" key={b.blockId}><input type="checkbox" checked={lift.includes(b.blockId)} onChange={(e) => toggleLift(b.blockId, (e.currentTarget as HTMLInputElement).checked)} />{fmtAt(b.period.start, p.timezone)} – {fmtAt(b.period.end, p.timezone)}</label>)}
                  <span class="yc-field__hint">Закрытие само ресурс не открывает: снимутся только отмеченные. Блокировка, на месте которой есть другой открытый ремонт, останется.</span>
                </fieldset>
              )}
            </>
          )}
          {dlg === 'expense' && (
            <>
              <h2 id="rp-money-title">Создать расход на ремонт</h2>
              <p class="yc-field__hint" data-testid="rp-expense-note">Будет создана одна операция кассы, категория «Ремонт и обслуживание», и связана с {r.number}. Если расход уже внесён в кассу – закройте окно и свяжите его.</p>
              <div class="yc-eq__pair">
                <label class="yc-field"><span class="yc-field__label">Плательщик</span>
                  <select class="yc-input" value={payer} onChange={(e) => setPayer((e.currentTarget as HTMLSelectElement).value)}>
                    {p.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                <label class="yc-field"><span class="yc-field__label">Способ</span>
                  <select class="yc-input" value={method} onChange={(e) => setMethod((e.currentTarget as HTMLSelectElement).value as typeof method)}>
                    <option value="cash">Наличные</option><option value="card">Карта</option><option value="transfer">Перевод</option>
                  </select>
                </label>
                <label class="yc-field"><span class="yc-field__label">Сумма, ₽ *</span><input class="yc-input" inputMode="decimal" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} /></label>
                <label class="yc-field"><span class="yc-field__label">Дата оплаты *</span><input class="yc-input" type="datetime-local" value={occurredAt} onInput={(e) => setOccurredAt((e.currentTarget as HTMLInputElement).value)} /></label>
              </div>
              <label class="yc-field"><span class="yc-field__label">Комментарий</span><input class="yc-input" maxLength={2000} placeholder={`Ремонт ${r.number}`} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLInputElement).value)} /></label>
            </>
          )}
          {dlg === 'link' && (
            <>
              <h2 id="rp-money-title">Связать расход из кассы</h2>
              <p class="yc-field__hint">Новой операции не будет. Расходы филиала ремонта за 90 дней.</p>
              <label class="yc-field"><span class="yc-field__label">Расход *</span>
                <select class="yc-input" value={operationId} onChange={(e) => setOperationId((e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">Выберите…</option>
                  {ops.map((o) => <option key={o.id} value={o.id}>№{o.number} · {rub(Math.abs(o.amountKop))} · {fmtAt(o.occurredAt, p.timezone)}{o.comment ? ` · ${o.comment}` : ''}</option>)}
                </select>
              </label>
            </>
          )}
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={close}>Не сейчас</button>
            <button type="submit" class="yc-btn" disabled={busy}>{dlg === 'close' ? 'Закрыть ремонт' : dlg === 'expense' ? 'Создать расход' : 'Связать'}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

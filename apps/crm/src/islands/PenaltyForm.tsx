// Штрафы и корректировки ведомости (S3-75, K18 §7–§8, №316–317). Штрафы – только при включённом payroll.penalties_enabled (Q-121), всегда с подписью «юридическая допустимость не проверена»;
// выключен – блока нет, сервер всё равно ответит FEATURE_DISABLED. Отмена и правка – окном внутри записи с причиной: исходная запись остаётся (сторно). Директор ставит штраф только с филиалом
// своей зоны, без филиала – Владелец. Корректировка – Владелец, со ссылкой на ведомость или смену, проводится в открытом периоде. Копейки разбираются строкой (lib/shifts.ts).
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { fmtDate, kopToInput, parseKopSigned, parseKopZero, shiftError, type Penalty } from '../lib/shifts.ts';
import { rub } from './CashJournal.tsx';

export const LEGAL_NOTE = 'Юридическая допустимость не проверена: в ТК РФ денежные штрафы не предусмотрены, запись – управленческая.';

export interface PenaltyFormProps {
  staffId: string;
  staffName: string;
  periodId: string;
  statementId: string | null;
  shifts: Array<{ id: string; label: string }>;
  /** Филиалы штрафа: зона смотрящего, где работает сотрудник. */
  branches: Array<{ id: string; name: string }>;
  today: string;
  enabled: boolean;
  canPenalty: boolean;
  canCorrect: boolean;
  isOwner: boolean;
  closed: boolean;
  onChange: () => Promise<void> | void;
}
type Dlg = 'new' | 'cancel' | 'amend' | 'correction';

export default function PenaltyForm({ staffId, staffName, periodId, statementId, shifts, branches, today, enabled, canPenalty, canCorrect, isOwner, closed, onChange }: PenaltyFormProps) {
  const [items, setItems] = useState<Penalty[]>([]);
  const [open, setOpen] = useState<Dlg | null>(null);
  const [target, setTarget] = useState<Penalty | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState('');
  const [date, setDate] = useState(today);
  const [branchId, setBranchId] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState('');
  const [notice, setNotice] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const branchName = (id: string | null) => (id ? (branches.find((b) => b.id === id)?.name ?? 'Филиал') : 'Без филиала');

  const load = async () => {
    if (!enabled) return;
    const r = await browserCall<{ items: Penalty[] }>(`/payroll/penalties?staffId=${enc(staffId)}&periodId=${enc(periodId)}`);
    setItems(r.items.filter((x) => x.kind === 'penalty'));
  };
  useEffect(() => {
    void load().catch((e: unknown) => setNotice(shiftError(e)));
  }, [staffId, periodId, enabled]);

  const show = (d: Dlg, p: Penalty | null = null) => {
    setOpen(d);
    setTarget(p);
    setAmount(p && d === 'amend' ? kopToInput(p.amountKop) : '');
    setReason(p && d === 'amend' ? p.reason : '');
    setWhy('');
    setDate(today);
    setBranchId(isOwner ? '' : (branches[0]?.id ?? ''));
    setRef(statementId ? `payroll_statement:${statementId}` : shifts[0] ? `shift:${shifts[0].id}` : '');
    setDlgError('');
    dlg.current?.showModal();
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setDlgError('');
    let call: () => Promise<unknown>;
    let ok = '';
    if (open === 'new' || open === 'amend') {
      const kop = parseKopZero(amount);
      if (kop === null || kop === 0) return setDlgError('Введите сумму больше нуля в рублях, например 500 или 500,50.');
      if (!reason.trim()) return setDlgError('Укажите причину.');
      if (open === 'new') {
        if (!isOwner && !branchId) return setDlgError('Укажите филиал.');
        call = () => browserCall('/payroll/penalties', { method: 'POST', body: { staffId, ...(branchId ? { branchId } : {}), date, amountKop: kop, reason: reason.trim() } });
        ok = 'Штраф записан.';
      } else {
        if (!why.trim()) return setDlgError('Укажите, почему исправляете.');
        call = () => browserCall(`/payroll/penalties/${enc(target!.id)}/amend`, { method: 'POST', body: { amountKop: kop, reason: reason.trim(), why: why.trim() } });
        ok = 'Штраф исправлен: прежняя запись сторнирована.';
      }
    } else if (open === 'cancel') {
      if (!why.trim()) return setDlgError('Укажите причину отмены.');
      call = () => browserCall(`/payroll/penalties/${enc(target!.id)}/cancel`, { method: 'POST', body: { reason: why.trim() } });
      ok = 'Штраф отменён: сторно проведено, запись осталась.';
    } else {
      const kop = parseKopSigned(amount);
      if (kop === null) return setDlgError('Введите сумму со знаком, например 500 или −500,50.');
      if (!reason.trim()) return setDlgError('Укажите причину.');
      const [type, id] = ref.split(':');
      if (!id) return setDlgError('Выберите, к чему относится корректировка.');
      call = async () => {
        const r = await browserCall<{ date: string }>('/payroll/corrections', { method: 'POST', body: { staffId, amountKop: kop, ref: { type, id }, reason: reason.trim() } });
        ok = `Корректировка ${rub(kop, true)} проведена датой ${fmtDate(r.date)} в открытом периоде.`;
      };
    }
    setBusy(true);
    try {
      await call();
      setNotice(ok);
      dlg.current?.close();
      await load();
      await onChange();
    } catch (err) {
      setDlgError(shiftError(err));
    } finally {
      setBusy(false);
    }
  };

  const TITLE: Record<Dlg, string> = { new: 'Новый штраф', amend: 'Исправить штраф', cancel: 'Отменить штраф?', correction: 'Корректировка' };
  return (
    <div class="yc-pay-statement" data-testid="penalties">
      {enabled && (
        <>
          <h3 class="yc-field__label">Штрафы</h3>
          <p class="yc-alert yc-alert--error" data-testid="legal-note">{LEGAL_NOTE}</p>
          {items.length === 0 && <p class="yc-empty">Штрафов за период нет.</p>}
          <ul class="yc-desk__list">
            {items.map((p) => (
              <li class="yc-desk__row" key={p.id} data-testid="penalty-item" data-status={p.status}>
                <strong>{fmtDate(p.date)} · {rub(p.amountKop)} · {branchName(p.branchId)}</strong>
                <span>Причина: {p.reason}{p.status === 'cancelled' ? ` · отменён${p.cancelReason ? `: ${p.cancelReason}` : ''}` : ''}</span>
                {canPenalty && p.status === 'active' && (
                  <span class="yc-bk__actions">
                    <button type="button" class="yc-link" onClick={() => show('amend', p)}>Исправить</button>
                    <button type="button" class="yc-link" onClick={() => show('cancel', p)}>Отменить</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div class="yc-bk__actions">
        {enabled && canPenalty && !closed && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => show('new')}>Добавить штраф</button>}
        {canCorrect && (statementId || shifts.length > 0) && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => show('correction')}>Корректировка</button>}
      </div>
      <p class="yc-alert yc-alert--ok" role="status" data-testid="penalty-notice">{notice}</p>

      <dialog ref={dlg} class="yc-dialog yc-dialog--wide" aria-labelledby="pen-title">
        {open && (
          <form class="yc-dialog__body" novalidate onSubmit={submit} data-testid="penalty-form">
            <h2 id="pen-title">{TITLE[open]}</h2>
            <p>{staffName}{target ? ` · ${fmtDate(target.date)} · ${rub(target.amountKop)}` : ''}</p>
            {open !== 'correction' && <p class="yc-field__hint">{LEGAL_NOTE}</p>}
            {open === 'correction' && <p class="yc-field__hint">Запись идёт в открытый период со ссылкой на источник. Плюс – в пользу сотрудника, минус – удержание. Снимок закрытой ведомости не меняется.</p>}
            {open === 'cancel' && <p>Исходная запись и её причина останутся в истории.</p>}
            {(open === 'new' || open === 'amend') && (
              <div class="yc-field">
                <label class="yc-field__label" for="pen-amount">Сумма, ₽</label>
                <input id="pen-amount" class="yc-input" inputMode="decimal" autocomplete="off" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
              </div>
            )}
            {open === 'correction' && (
              <>
                <div class="yc-field">
                  <label class="yc-field__label" for="pen-signed">Сумма со знаком, ₽</label>
                  <input id="pen-signed" class="yc-input" autocomplete="off" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
                </div>
                <div class="yc-field">
                  <label class="yc-field__label" for="pen-ref">К чему относится</label>
                  <select id="pen-ref" class="yc-input" value={ref} onChange={(e) => setRef((e.currentTarget as HTMLSelectElement).value)}>
                    {statementId && <option value={`payroll_statement:${statementId}`}>Ведомость этого периода</option>}
                    {shifts.map((x) => <option key={x.id} value={`shift:${x.id}`}>Смена {x.label}</option>)}
                  </select>
                </div>
              </>
            )}
            {open === 'new' && (
              <>
                <div class="yc-field">
                  <label class="yc-field__label" for="pen-date">Дата</label>
                  <input id="pen-date" class="yc-input" type="date" value={date} onInput={(e) => setDate((e.currentTarget as HTMLInputElement).value)} />
                </div>
                <div class="yc-field">
                  <label class="yc-field__label" for="pen-branch">Филиал</label>
                  <select id="pen-branch" class="yc-input" value={branchId} onChange={(e) => setBranchId((e.currentTarget as HTMLSelectElement).value)}>
                    {isOwner && <option value="">Без филиала</option>}
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              </>
            )}
            {open !== 'cancel' && (
              <div class="yc-field">
                <label class="yc-field__label" for="pen-reason">Причина *</label>
                <textarea id="pen-reason" class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
              </div>
            )}
            {(open === 'cancel' || open === 'amend') && (
              <div class="yc-field">
                <label class="yc-field__label" for="pen-why">{open === 'cancel' ? 'Причина отмены *' : 'Почему исправляете *'}</label>
                <textarea id="pen-why" class="yc-input" rows={2} maxLength={2000} value={why} onInput={(e) => setWhy((e.currentTarget as HTMLTextAreaElement).value)} />
              </div>
            )}
            <p class="yc-alert yc-alert--error" role="alert" data-testid="penalty-form-error">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dlg.current?.close()}>Закрыть</button>
              <button type="submit" class={open === 'cancel' ? 'yc-btn yc-btn--danger' : 'yc-btn'} disabled={busy}>Подтвердить</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

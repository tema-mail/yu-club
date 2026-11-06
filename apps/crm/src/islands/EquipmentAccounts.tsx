// Учётные записи PS/VR (S3-77, K19 №336, §5; 10 §5): только идентификатор и «где взять доступ». Паролей и кодов система не хранит:
// поля для них нет ни в форме, ни в API (Q-53). Переназначение закрывает прежнюю связь с датой и причиной и создаёт новую (10 §5.4).
// Права: чтение – equipment.view.accounts (остров показывается, только если сервер отдал accounts), запись – equipment.manage.
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { PLATFORM, errorText, ruDate, type AccountDto } from '../lib/equipment.ts';
import { today } from '../lib/booking.ts';

export interface EquipmentAccountsProps {
  equipmentId: string;
  branchId: string;
  timezone: string;
  accounts: AccountDto[];
  canManage: boolean;
  onChanged: (notice: string) => void;
}

export default function EquipmentAccounts(p: EquipmentAccountsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<AccountDto | null>(null);
  const [mode, setMode] = useState<'bind' | 'rebind' | null>(null);
  const [platform, setPlatform] = useState<AccountDto['platform']>('playstation');
  const [displayName, setDisplayName] = useState('');
  const [hint, setHint] = useState('');
  const [from, setFrom] = useState(today(p.timezone));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = p.accounts.filter((a) => a.status === 'active');
  const ended = p.accounts.filter((a) => a.status === 'ended');

  const open = (m: 'bind' | 'rebind', a: AccountDto | null = null) => {
    setMode(m);
    setTarget(a);
    setPlatform('playstation');
    setDisplayName('');
    setHint('');
    setFrom(today(p.timezone));
    setReason('');
    setError('');
    dialog.current?.showModal();
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'bind' && !displayName.trim()) return setError('Укажите идентификатор учётной записи.');
    if (mode === 'rebind' && !reason.trim()) return setError('Укажите причину.');
    setBusy(true);
    setError('');
    try {
      if (mode === 'bind') {
        await browserCall('/equipment-accounts', { method: 'POST', body: { platform, displayName: displayName.trim(), equipmentId: p.equipmentId, branchId: p.branchId, boundFrom: from, ...(hint.trim() ? { accessHint: hint.trim() } : {}) } });
      } else if (target) {
        await browserCall(`/equipment-accounts/${target.id}/rebind`, { method: 'POST', body: { equipmentId: null, at: from, reason: reason.trim() } });
      }
      dialog.current?.close();
      p.onChanged(mode === 'bind' ? 'Учётная запись привязана.' : 'Связь с учётной записью закрыта, прежняя видна в истории.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const row = (a: AccountDto) => (
    <li class="yc-eq__row" key={a.id} data-testid={`account-${a.displayName}`}>
      <strong>{a.displayName}</strong>
      <span class="yc-eq__muted">{PLATFORM[a.platform]} · с {ruDate(a.boundFrom)}{a.boundTo ? ` по ${ruDate(a.boundTo)}` : ''}{a.endReason ? ` · ${a.endReason}` : ''}</span>
      {a.accessHint && <span>Где взять доступ: {a.accessHint}</span>}
      {a.comment && <span>{a.comment}</span>}
      {a.status === 'active' && p.canManage && <span><button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('rebind', a)}>Отвязать…</button></span>}
    </li>
  );

  return (
    <section class="yc-panel" role="tabpanel" aria-label="Учётные записи">
      <h2>Учётные записи PS/VR</h2>
      <p class="yc-field__hint" data-testid="accounts-note">Здесь только идентификатор и подсказка, где взять доступ. Пароли и коды в системе не хранятся.</p>
      {p.canManage && <div class="yc-eq__actions"><button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('bind')}>Привязать учётную запись…</button></div>}
      {active.length === 0 && <p class="yc-empty">Действующих учётных записей нет.</p>}
      <ul class="yc-eq__rows" data-testid="eq-accounts">{active.map(row)}</ul>
      {ended.length > 0 && (
        <>
          <h3>Прежние</h3>
          <ul class="yc-eq__rows" data-testid="eq-accounts-ended">{ended.map(row)}</ul>
        </>
      )}
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="acc-title" onClose={() => setMode(null)}>
        <form class="yc-dialog__body" novalidate onSubmit={submit}>
          <h2 id="acc-title">{mode === 'bind' ? 'Привязать учётную запись' : 'Отвязать учётную запись'}</h2>
          {mode === 'bind' && (
            <>
              <label class="yc-field"><span class="yc-field__label">Платформа</span>
                <select class="yc-input" value={platform} onChange={(e) => setPlatform((e.currentTarget as HTMLSelectElement).value as AccountDto['platform'])}>
                  {(Object.keys(PLATFORM) as Array<AccountDto['platform']>).map((k) => <option key={k} value={k}>{PLATFORM[k]}</option>)}
                </select>
              </label>
              <label class="yc-field"><span class="yc-field__label">Идентификатор *</span>
                <input class="yc-input" maxLength={200} autoComplete="off" value={displayName} onInput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)} />
                <span class="yc-field__hint">Имя или логин, не пароль.</span>
              </label>
              <label class="yc-field"><span class="yc-field__label">Где взять доступ</span>
                <input class="yc-input" maxLength={500} value={hint} onInput={(e) => setHint((e.currentTarget as HTMLInputElement).value)} />
                <span class="yc-field__hint">Например: «у директора, журнал доступов». Паролей сюда не пишите.</span>
              </label>
            </>
          )}
          {mode === 'rebind' && (
            <>
              <p class="yc-field__hint">Связь закроется датой и причиной, запись останется в истории. Новую привяжите отдельно – к этому или другому оборудованию.</p>
              <label class="yc-field"><span class="yc-field__label">Причина *</span>
                <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
              </label>
            </>
          )}
          <label class="yc-field"><span class="yc-field__label">{mode === 'bind' ? 'Действует с' : 'Дата'}</span>
            <input class="yc-input" type="date" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Не менять</button>
            <button type="submit" class="yc-btn" disabled={busy}>Сохранить</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

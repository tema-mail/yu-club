// Карточка сотрудника, блок «Дополнительные права» (S3-87, K1 «Делегирование», 04 §9, K11 №380–382). Выдаёт, отзывает и видит только Владелец;
// себе – нельзя (блока на своей карточке нет). Действия предлагаются только из `delegable` ответа списка – закрытый список DELEGABLE сервера;
// зона – только из назначений получателя (город целиком или филиал), `network.branch.create` – только на город. Задним числом не выдаётся:
// дата начала – с сегодняшнего дня. Решает всё равно сервер: GRANT_ACTION_NOT_DELEGABLE, GRANT_SCOPE_INVALID, GRANT_ALREADY_ACTIVE.
// `client.merge` выдаётся, но API слияния клиентов пока нет – у права пометка (TEHDOLG 5.15).
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { fmtDate } from '../lib/shifts.ts';

export interface GrantDto {
  id: string; staffId: string; action: string; cityId: string | null; branchId: string | null;
  validFrom: string; validTo: string | null; grantedBy: string; createdAt: string; revokedAt: string | null; revokedBy: string | null;
}
export interface GrantZoneOption { value: string; label: string; kind: 'city' | 'branch' }
export interface StaffGrantsProps {
  staffId: string;
  initialItems: GrantDto[];
  delegable: string[];
  /** Город и филиалы из назначений получателя (зона права ⊆ назначений, K1). */
  zones: GrantZoneOption[];
  /** Имена городов и филиалов по id – для зоны в списке. */
  zoneNames: Record<string, string>;
  staffNames: Record<string, string>;
  today: string;
}

export const GRANT_LABEL: Record<string, string> = {
  'block.manage': 'Блокировки ресурсов',
  'network.hours.manage': 'Часы работы филиала',
  'finance.income.create': 'Внесение доходов',
  'finance.expense.create': 'Внесение расходов',
  'equipment.view.accounts': 'Учётные записи оборудования',
  'client.merge': 'Объединение карточек клиентов',
  'shift.manage': 'Управление сменами',
  'payroll.view': 'Просмотр зарплаты',
  'network.branch.create': 'Создание филиалов',
};
const MERGE_NOTE = 'Заработает, когда появится слияние клиентов.';
const GRANT_HINT: Record<string, string> = {
  'client.merge': MERGE_NOTE,
  'payroll.view': 'Открывает суммы всех сотрудников зоны права, включая коллег.',
  'network.branch.create': 'Выдаётся только на город.',
};
const ERROR_TEXT: Record<string, string> = {
  GRANT_ACTION_NOT_DELEGABLE: 'Это действие не выдаётся отдельно.',
  GRANT_SCOPE_INVALID: 'Зона права вне назначений сотрудника на дату начала.',
  GRANT_ALREADY_ACTIVE: 'На эти даты такое право в этой зоне уже выдано.',
  FORBIDDEN: 'Выдавать и отзывать права может только Владелец, себе – нельзя.',
  NOT_FOUND: 'Сотрудник или право не найдены – обновите страницу.',
};
const grantError = (e: unknown) =>
  e instanceof ApiError
    ? e.code === 'VALIDATION_FAILED' && e.details?.field === 'validFrom' ? 'Дата начала – не раньше сегодняшнего дня.' : (ERROR_TEXT[e.code] ?? e.message)
    : 'Неизвестная ошибка. Повторите.';

type State = 'active' | 'planned' | 'expired' | 'revoked';
const STATE_LABEL: Record<State, string> = { active: 'Действует', planned: 'Запланировано', expired: 'Истекло', revoked: 'Отозвано' };
const STATE_BADGE: Record<State, string> = { active: 'active', planned: 'preparing', expired: 'archived', revoked: 'blocked' };
interface Draft { action: string; zone: string; validFrom: string; validTo: string; reason: string }

export default function StaffGrants({ staffId, initialItems, delegable, zones, zoneNames, staffNames, today }: StaffGrantsProps) {
  const [items, setItems] = useState(initialItems);
  const [draft, setDraft] = useState<Draft>({ action: '', zone: '', validFrom: today, validTo: '', reason: '' });
  const [revoking, setRevoking] = useState<GrantDto | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dlgError, setDlgError] = useState('');
  const key = useRef('');
  const grantDlg = useRef<HTMLDialogElement>(null);
  const revokeDlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const set = (patch: Partial<Draft>) => {
    key.current = '';
    setDraft((d) => ({ ...d, ...patch }));
  };

  const stateOf = (g: GrantDto): State => (g.revokedAt ? 'revoked' : g.validTo !== null && g.validTo < today ? 'expired' : g.validFrom > today ? 'planned' : 'active');
  const current = items.filter((g) => ['active', 'planned'].includes(stateOf(g)));
  const past = items.filter((g) => ['expired', 'revoked'].includes(stateOf(g)));
  const zoneOptions = zones.filter((z) => draft.action !== 'network.branch.create' || z.kind === 'city');
  const reload = async () => setItems((await browserCall<{ items: GrantDto[] }>(`/staff/grants?staffId=${enc(staffId)}`)).items);

  const openGrant = () => {
    key.current = '';
    setDraft({ action: '', zone: '', validFrom: today, validTo: '', reason: '' });
    setDlgError('');
    grantDlg.current?.showModal();
  };
  const saveGrant = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const zone = zoneOptions.find((z) => z.value === draft.zone);
    if (!draft.action) return setDlgError('Выберите право.');
    if (!zone) return setDlgError('Выберите город или филиал.');
    if (!draft.validFrom || draft.validFrom < today) return setDlgError('Дата начала – не раньше сегодняшнего дня.');
    if (draft.validTo && draft.validTo < draft.validFrom) return setDlgError('Дата окончания раньше даты начала.');
    key.current ||= crypto.randomUUID(); // двойное нажатие – одна выдача
    setBusy(true);
    setDlgError('');
    try {
      const reason = draft.reason.trim();
      await browserCall<GrantDto>(`/staff/${enc(staffId)}/grants`, {
        method: 'POST',
        key: key.current,
        body: {
          action: draft.action,
          ...(zone.kind === 'city' ? { cityId: zone.value } : { branchId: zone.value }),
          validFrom: draft.validFrom,
          validTo: draft.validTo || null,
          ...(reason ? { reason } : {}),
        },
      });
      await reload();
      setNotice(`Право «${GRANT_LABEL[draft.action] ?? draft.action}» выдано.`);
      grantDlg.current?.close();
    } catch (err) {
      setDlgError(grantError(err));
    } finally {
      setBusy(false);
    }
  };
  const openRevoke = (g: GrantDto) => {
    key.current = '';
    setRevoking(g);
    setRevokeReason('');
    setDlgError('');
    revokeDlg.current?.showModal();
  };
  const revoke = async (e: Event) => {
    e.preventDefault();
    if (busy || !revoking) return;
    key.current ||= crypto.randomUUID();
    setBusy(true);
    setDlgError('');
    try {
      const reason = revokeReason.trim();
      await browserCall<GrantDto>(`/staff/grants/${enc(revoking.id)}/revoke`, { method: 'POST', key: key.current, body: reason ? { reason } : {} });
      await reload();
      setNotice(`Право «${GRANT_LABEL[revoking.action] ?? revoking.action}» отозвано. Перестаёт действовать со следующего запроса сотрудника.`);
      revokeDlg.current?.close();
    } catch (err) {
      setDlgError(grantError(err));
    } finally {
      setBusy(false);
    }
  };

  const zoneOf = (g: GrantDto) => (g.cityId ? `${zoneNames[g.cityId] ?? 'город'} (весь город)` : (zoneNames[g.branchId ?? ''] ?? 'филиал'));
  const period = (g: GrantDto) => `с ${fmtDate(g.validFrom)}${g.validTo ? ` по ${fmtDate(g.validTo)}` : ', бессрочно'}`;
  const table = (rows: GrantDto[], withRevoke: boolean, testId: string) => (
    <table class="yc-table" data-testid={testId}>
      <thead><tr><th>Право</th><th>Зона</th><th>Срок</th><th>Статус</th><th>Кто выдал</th>{withRevoke && <th>Действие</th>}</tr></thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.id} data-testid="grant-row">
            <td class="yc-table__main">
              {GRANT_LABEL[g.action] ?? g.action}
              {g.action === 'client.merge' && <span class="yc-field__hint" data-testid="grant-merge-note"> {MERGE_NOTE}</span>}
            </td>
            <td data-label="Зона">{zoneOf(g)}</td>
            <td data-label="Срок">{period(g)}</td>
            <td data-label="Статус"><span class={`yc-badge yc-badge--${STATE_BADGE[stateOf(g)]}`}>{STATE_LABEL[stateOf(g)]}</span></td>
            <td data-label="Кто выдал">{staffNames[g.grantedBy] ?? 'сотрудник'}{g.revokedAt ? `; отозвал ${staffNames[g.revokedBy ?? ''] ?? 'сотрудник'}` : ''}</td>
            {withRevoke && <td><button type="button" class="yc-link" onClick={() => openRevoke(g)}>Отозвать</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <section class="yc-panel" aria-labelledby="grants-title" data-testid="staff-grants">
        <h2 id="grants-title">Дополнительные права</h2>
        <p class="yc-field__hint">Право сверх роли на срок, в городе или филиале из назначений сотрудника. Выдаёт и отзывает только Владелец, всё пишется в журнал.</p>
        <div><button type="button" class="yc-btn" onClick={openGrant} disabled={zones.length === 0}>Выдать право</button></div>
        {zones.length === 0 && <p class="yc-field__hint">У сотрудника нет назначений на город или филиал – выдать право не на что.</p>}
        <p class="yc-alert yc-alert--ok" role="status" data-testid="grant-notice">{notice}</p>
        <h3 class="yc-field__label">Действующие и запланированные</h3>
        {current.length === 0 ? <p class="yc-empty" data-testid="grants-current-empty">Дополнительных прав нет.</p> : table(current, true, 'grants-current')}
        <h3 class="yc-field__label">Истёкшие и отозванные</h3>
        {past.length === 0 ? <p class="yc-empty" data-testid="grants-past-empty">Пусто.</p> : table(past, false, 'grants-past')}
      </section>

      <dialog ref={grantDlg} class="yc-dialog" aria-labelledby="grant-dlg-title">
        <form class="yc-dialog__body" novalidate onSubmit={saveGrant} data-testid="grant-form">
          <h2 id="grant-dlg-title">Выдать право</h2>
          <div class="yc-field">
            <label class="yc-field__label" for="grant-action">Право</label>
            <select id="grant-action" class="yc-input" value={draft.action} onChange={(e) => set({ action: (e.currentTarget as HTMLSelectElement).value, zone: '' })}>
              <option value="">Выберите</option>
              {delegable.map((a) => <option key={a} value={a}>{GRANT_LABEL[a] ?? a}</option>)}
            </select>
            {GRANT_HINT[draft.action] && <p class="yc-field__hint" data-testid="grant-action-hint">{GRANT_HINT[draft.action]}</p>}
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="grant-zone">Где действует</label>
            <select id="grant-zone" class="yc-input" value={draft.zone} onChange={(e) => set({ zone: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">Выберите</option>
              {zoneOptions.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
            </select>
            {zoneOptions.length === 0 && <p class="yc-field__hint">Сотрудник не назначен на город целиком – это право выдать не на что.</p>}
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="grant-from">Действует с</label>
            <input id="grant-from" class="yc-input" type="date" min={today} value={draft.validFrom} onInput={(e) => set({ validFrom: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="grant-to">Действует по</label>
            <input id="grant-to" class="yc-input" type="date" min={draft.validFrom || today} value={draft.validTo} onInput={(e) => set({ validTo: (e.currentTarget as HTMLInputElement).value })} />
            <p class="yc-field__hint">Пусто – бессрочно, до отзыва.</p>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="grant-reason">Причина</label>
            <textarea id="grant-reason" class="yc-input" rows={2} maxLength={500} value={draft.reason} onInput={(e) => set({ reason: (e.currentTarget as HTMLTextAreaElement).value })} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => grantDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Выдать</button>
          </div>
        </form>
      </dialog>

      <dialog ref={revokeDlg} class="yc-dialog" aria-labelledby="revoke-dlg-title">
        <form class="yc-dialog__body" novalidate onSubmit={revoke} data-testid="revoke-form">
          <h2 id="revoke-dlg-title">Отозвать право?</h2>
          {revoking && <p>«{GRANT_LABEL[revoking.action] ?? revoking.action}», {zoneOf(revoking)}, {period(revoking)}. Перестанет действовать со следующего запроса сотрудника.</p>}
          <div class="yc-field">
            <label class="yc-field__label" for="revoke-reason">Причина</label>
            <textarea id="revoke-reason" class="yc-input" rows={2} maxLength={500} value={revokeReason} onInput={(e) => { key.current = ''; setRevokeReason((e.currentTarget as HTMLTextAreaElement).value); }} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => revokeDlg.current?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Отозвать</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

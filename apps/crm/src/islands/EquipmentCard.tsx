// Карточка оборудования (S3-76, K19 №332–335, 348; 10 §13.2): вверху статус, филиал и комната, открытые неисправности; 7 вкладок:
// основное, размещение и история, учётки PS/VR, ремонт, гарантия, документы, история изменений. Вкладка учёток – только если сервер
// отдал поле accounts (Администратору его нет, Q-54). Списанное – только чтение: команды скрыты, сервер отвечает EQUIPMENT_WRITTEN_OFF;
// документы принимает. Статус не закрывает ресурс: сервер только предлагает блокировку (K19 §1), её подтверждают в карточке ремонта.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import {
  EQUIPMENT_BADGE, EQUIPMENT_STATUS, PRIORITY, REPAIR_BADGE, REPAIR_STATUS, errorText, fmtAt, ruDate,
  type BlockProposal, type CategoryDto, type EquipmentDto, type EquipmentStatus, type PlaceOption, type PlacementRow, type RepairDto, type WarrantyDto,
} from '../lib/equipment.ts';
import Attachments from './Attachments.tsx';
import { rub } from './CashJournal.tsx';
import EquipmentAccounts from './EquipmentAccounts.tsx';
import EquipmentForm from './EquipmentForm.tsx';
import MoveEquipment from './MoveEquipment.tsx';

export interface EquipmentCardProps {
  initial: EquipmentDto;
  timezone: string;
  categories: CategoryDto[];
  branches: Array<{ id: string; name: string; timezone: string }>;
  roomsByBranch: Record<string, PlaceOption[]>;
  unitsByBranch: Record<string, PlaceOption[]>;
  categoryNames: Record<string, string>;
  branchNames: Record<string, string>;
  roomNames: Record<string, string>;
  unitNames: Record<string, string>;
  staffNames: Record<string, string>;
  meId: string;
  actions: string[];
}
type Tab = 'main' | 'place' | 'accounts' | 'repairs' | 'warranty' | 'docs' | 'history';
const TAB_LABEL: Record<Tab, string> = { main: 'Основное', place: 'Размещение', accounts: 'Учётные записи', repairs: 'Ремонт', warranty: 'Гарантия', docs: 'Документы', history: 'История' };
interface AuditItem { id: string; at: string; action: string; actor?: { name?: string } | null; reason: string | null }
const AUDIT: Record<string, string> = {
  'equipment.created': 'Поставлено на учёт', 'equipment.updated': 'Изменена карточка', 'equipment.serial_changed': 'Изменён серийный номер', 'equipment.status_changed': 'Смена статуса',
  'equipment.written_off': 'Списано', 'equipment.moved': 'Перемещение',
};

/** Загрузка вкладки при открытии и после изменений (key). */
function useTab<T>(active: boolean, path: string, key: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ status: number; text: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError(null);
    browserCall<T>(path)
      .then((d) => { if (live) setData(d); })
      .catch((e: unknown) => { if (live) setError({ status: (e as { status?: number }).status ?? 0, text: errorText(e) }); });
    return () => { live = false; };
  }, [active, path, key]);
  return { data, error };
}

export default function EquipmentCard(p: EquipmentCardProps) {
  const [e, setE] = useState<EquipmentDto>(p.initial);
  const [tab, setTab] = useState<Tab>('main');
  const [notice, setNotice] = useState('');
  const [proposal, setProposal] = useState<BlockProposal | null>(null);
  const [version, setVersion] = useState(0);
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [dlg, setDlg] = useState<'status' | 'writeoff' | 'warranty' | 'warranty-off' | null>(null);
  const [status, setStatus] = useState<EquipmentStatus>('in_service');
  const [reason, setReason] = useState('');
  const [wFrom, setWFrom] = useState('');
  const [wTo, setWTo] = useState('');
  const [wTerms, setWTerms] = useState('');
  const [wIssuer, setWIssuer] = useState('');
  const [wTarget, setWTarget] = useState<WarrantyDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const can = (a: string) => p.actions.includes(a);
  const writtenOff = e.status === 'written_off';
  const hasAccounts = 'accounts' in e;
  const tabs: Tab[] = ['main', 'place', ...(hasAccounts ? (['accounts'] as const) : []), 'repairs', 'warranty', 'docs', 'history'];
  const who = (id: string) => (id === p.meId ? 'Вы' : p.staffNames[id] ?? 'Сотрудник');
  const place = (r: { branchId: string; roomId: string | null; unitId: string | null }) =>
    [p.branchNames[r.branchId] ?? 'Филиал', r.roomId ? p.roomNames[r.roomId] ?? 'Комната' : null, r.unitId ? p.unitNames[r.unitId] ?? 'Единица' : null].filter(Boolean).join(' · ');

  const placements = useTab<{ items: PlacementRow[] }>(tab === 'place', `/equipment/${e.id}/placements`, version);
  const repairs = useTab<{ items: RepairDto[] }>(tab === 'repairs', `/repairs?equipmentId=${e.id}`, version);
  const warranties = useTab<{ items: WarrantyDto[] }>(tab === 'warranty', `/equipment/${e.id}/warranties`, version);
  const history = useTab<{ items: AuditItem[] }>(tab === 'history', `/audit/timeline?objectType=equipment&objectId=${e.id}&limit=50`, version);

  const reload = async () => {
    setE(await browserCall<EquipmentDto>(`/equipment/${e.id}`));
    setVersion((v) => v + 1);
  };
  const open = (k: NonNullable<typeof dlg>, w: WarrantyDto | null = null) => {
    setDlg(k);
    setError('');
    setReason('');
    setStatus(k === 'writeoff' ? 'written_off' : e.status === 'in_service' ? 'diagnostics' : 'in_service');
    setWFrom('');
    setWTo('');
    setWTerms('');
    setWIssuer('');
    setWTarget(w);
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
    setDlg(null);
  };
  const statusOptions = (Object.keys(EQUIPMENT_STATUS) as EquipmentStatus[]).filter((s) => s !== e.status && s !== 'written_off' && s !== 'lost');
  const reasonNeeded = dlg === 'writeoff' || status === 'unavailable' || e.status === 'lost';
  const canChangeStatus = can('equipment.manage') && (e.status !== 'lost' || can('equipment.write_off'));

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy || !dlg) return;
    setError('');
    if ((dlg === 'status' || dlg === 'writeoff') && reasonNeeded && !reason.trim()) return setError('Укажите причину – без неё не сохранить.');
    if (dlg === 'warranty' && (!wFrom || !wTo)) return setError('Укажите начало и конец гарантии.');
    if (dlg === 'warranty' && wTo < wFrom) return setError('Конец гарантии раньше начала.');
    if (dlg === 'warranty-off' && !reason.trim()) return setError('Укажите причину.');
    setBusy(true);
    try {
      if (dlg === 'status' || dlg === 'writeoff') {
        const r = await browserCall<{ equipment: EquipmentDto; blockProposal: BlockProposal | null }>(`/equipment/${e.id}/status`, { method: 'POST', body: { rowVersion: e.rowVersion, status, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
        setProposal(r.blockProposal);
        setNotice(`Статус: ${EQUIPMENT_STATUS[r.equipment.status]}.`);
      } else if (dlg === 'warranty') {
        await browserCall(`/equipment/${e.id}/warranties`, { method: 'POST', body: { kind: 'manufacturer', startsOn: wFrom, endsOn: wTo, ...(wTerms.trim() ? { terms: wTerms.trim() } : {}), ...(wIssuer.trim() ? { issuer: wIssuer.trim() } : {}) } });
        setNotice('Гарантия добавлена.');
      } else if (wTarget) {
        await browserCall(`/warranties/${wTarget.id}/invalidate`, { method: 'POST', body: { reason: reason.trim() } });
        setNotice('Гарантия отмечена недействительной.');
      }
      close();
      await reload();
    } catch (err) {
      setError(errorText(err));
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="yc-eq">
      <section class="yc-panel yc-eq__top" aria-label="Главное">
        <h1 data-testid="eq-title">{e.name}</h1>
        <div class="yc-eq__facts">
          <span data-testid="eq-number">{e.inventoryNumber}</span>
          <span class={`yc-badge yc-badge--${EQUIPMENT_BADGE[e.status]}`} data-testid="eq-status">{EQUIPMENT_STATUS[e.status]}</span>
          <span data-testid="eq-place">{place(e.placement)}</span>
          <span class={e.openRepairsCount > 0 ? 'yc-badge yc-badge--decide' : 'yc-eq__muted'} data-testid="eq-open-repairs">
            {e.openRepairsCount > 0 ? `Открытых неисправностей: ${e.openRepairsCount}` : 'Открытых неисправностей нет'}
          </span>
        </div>
        {writtenOff && <p class="yc-eq__muted" data-testid="eq-readonly">Списано – карточка только для чтения, документы можно добавлять.{e.statusReason ? ` Причина: ${e.statusReason}.` : ''}</p>}
      </section>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="eq-notice">{notice}</p>}
      {proposal?.target && (
        <section class="yc-eq__warn" data-testid="eq-proposal">
          <strong>Система предлагает закрыть место блокировкой – сама она ничего не закрыла.</strong>
          <span>Цель: {proposal.target.ids.map((id) => p.unitNames[id] ?? p.roomNames[id] ?? 'Место').join(', ')}. Затронуто броней: {proposal.affectedBookings.length}, мероприятий: {proposal.affectedEvents.length}.</span>
          {can('repair.register') && <a href={`/repairs/new?equipmentId=${e.id}`}>Зарегистрировать неисправность и подтвердить блокировку</a>}
        </section>
      )}

      <div class="yc-eq__tabs" role="tablist" aria-label="Разделы карточки">
        {tabs.map((t) => <button key={t} type="button" role="tab" class="yc-eq__tab" aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
      </div>

      {tab === 'main' && editing && (
        <section class="yc-panel" role="tabpanel" aria-label="Основное">
          <EquipmentForm
            initial={e}
            categories={p.categories}
            branches={p.branches}
            defaultBranchId={e.placement.branchId}
            roomsByBranch={p.roomsByBranch}
            unitsByBranch={p.unitsByBranch}
            canFinancial={can('equipment.financial.edit')}
            onCancel={() => setEditing(false)}
            onSaved={(_saved, text) => {
              setEditing(false);
              setNotice(text);
              void reload();
            }}
          />
        </section>
      )}
      {tab === 'main' && !editing && (
        <section class="yc-panel" role="tabpanel" aria-label="Основное">
          <dl class="yc-props">
            <dt>Инвентарный номер</dt><dd>{e.inventoryNumber}</dd>
            <dt>Прежний номер</dt><dd>{e.legacyNumber ?? '–'}</dd>
            <dt>Категория</dt><dd>{p.categoryNames[e.categoryId] ?? '–'}</dd>
            <dt>Производитель</dt><dd>{e.manufacturer ?? '–'}</dd>
            <dt>Модель</dt><dd>{e.model ?? '–'}</dd>
            <dt>Серийный номер</dt><dd data-testid="eq-serial">{e.serialNumber ?? '–'}</dd>
            <dt>Дата покупки</dt><dd>{ruDate(e.purchaseDate)}</dd>
            <dt>Стоимость</dt><dd>{e.purchaseCostKop === null ? '–' : rub(e.purchaseCostKop)}</dd>
            <dt>Введено в работу</dt><dd>{ruDate(e.commissionedOn)}</dd>
            <dt>Гарантия до</dt><dd>{ruDate(e.warrantyUntil)}</dd>
            <dt>Причина статуса</dt><dd>{e.statusReason ?? '–'}</dd>
            <dt>Комментарий</dt><dd>{e.comment ?? '–'}</dd>
          </dl>
          {!writtenOff && can('equipment.manage') && (
            <div class="yc-eq__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setEditing(true)}>Изменить…</button>
              {canChangeStatus && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('status')}>Сменить статус…</button>}
              {can('equipment.write_off') && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => open('writeoff')}>Убрать из работы…</button>}
            </div>
          )}
        </section>
      )}

      {tab === 'place' && (
        <section class="yc-panel" role="tabpanel" aria-label="Размещение">
          <h2>Сейчас: {place(e.placement)}</h2>
          <p class="yc-eq__muted">С {fmtAt(e.placement.since, p.timezone)}.</p>
          {!writtenOff && can('equipment.move') && <div class="yc-eq__actions"><button type="button" class="yc-btn yc-btn--ghost" onClick={() => setMoving(true)}>Переместить…</button></div>}
          {moving && (
            <MoveEquipment
              equipment={e}
              timezone={p.timezone}
              branches={p.branches}
              roomsByBranch={p.roomsByBranch}
              unitsByBranch={p.unitsByBranch}
              onClose={() => setMoving(false)}
              onMoved={(r) => {
                setProposal(r.blockProposal);
                setNotice(r.affectedBookingIds.length > 0 ? `Перемещено. Брони не тронуты (${r.affectedBookingIds.length}), ваше решение записано в историю.` : 'Перемещено.');
                setE(r.equipment);
                void reload();
              }}
            />
          )}
          {placements.error && <p class="yc-alert yc-alert--error" role="alert">{placements.error.text}</p>}
          <ul class="yc-eq__rows" data-testid="eq-placements">
            {placements.data?.items.map((r) => (
              <li class="yc-eq__row" key={r.id}>
                <strong>{place(r)}</strong>
                <span class="yc-eq__muted">{fmtAt(r.placedAt, p.timezone)} – {r.removedAt ? fmtAt(r.removedAt, p.timezone) : 'сейчас'} · {who(r.movedBy)}</span>
                <span>{r.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'accounts' && hasAccounts && (
        <EquipmentAccounts
          equipmentId={e.id}
          branchId={e.placement.branchId}
          timezone={p.timezone}
          accounts={e.accounts ?? []}
          canManage={!writtenOff && can('equipment.manage')}
          onChanged={(text) => {
            setNotice(text);
            void reload();
          }}
        />
      )}

      {tab === 'repairs' && (
        <section class="yc-panel" role="tabpanel" aria-label="Ремонт">
          {!writtenOff && can('repair.register') && <div class="yc-eq__actions"><a class="yc-btn" href={`/repairs/new?equipmentId=${e.id}`}>Зарегистрировать неисправность</a></div>}
          {repairs.error && <p class="yc-alert yc-alert--error" role="alert">{repairs.error.text}</p>}
          {repairs.data?.items.length === 0 && <p class="yc-empty">Ремонтов не было.</p>}
          <ul class="yc-eq__rows" data-testid="eq-repairs">
            {repairs.data?.items.map((r) => (
              <li class="yc-eq__row" key={r.id}>
                <a href={`/repairs/${r.id}`}><strong>{r.number}</strong></a>
                <span><span class={`yc-badge yc-badge--${REPAIR_BADGE[r.status]}`}>{REPAIR_STATUS[r.status]}</span> · {PRIORITY[r.priority]} · {fmtAt(r.detectedAt, p.timezone)}</span>
                <span>{r.symptoms}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'warranty' && (
        <section class="yc-panel" role="tabpanel" aria-label="Гарантия">
          {!writtenOff && can('repair.manage') && <div class="yc-eq__actions"><button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('warranty')}>Добавить гарантию…</button></div>}
          {warranties.error && <p class="yc-alert yc-alert--error" role="alert">{warranties.error.text}</p>}
          {warranties.data?.items.length === 0 && <p class="yc-empty">Гарантий нет.</p>}
          <ul class="yc-eq__rows" data-testid="eq-warranties">
            {warranties.data?.items.map((w) => (
              <li class="yc-eq__row" key={w.id}>
                <strong>{ruDate(w.startsOn)} – {ruDate(w.endsOn)}</strong>
                <span class="yc-eq__muted">{w.kind === 'manufacturer' ? 'На оборудование' : 'На работы'}{w.issuer ? ` · ${w.issuer}` : ''}{w.status === 'invalid' ? ' · недействительна' : ''}</span>
                {w.terms && <span>{w.terms}</span>}
                {w.repairId && <a href={`/repairs/${w.repairId}`}>Ремонт</a>}
                {w.status === 'active' && !writtenOff && can('repair.manage') && <span><button type="button" class="yc-btn yc-btn--ghost" onClick={() => open('warranty-off', w)}>Недействительна…</button></span>}
              </li>
            ))}
          </ul>
          <p class="yc-eq__muted">Гарантийный случай система не признаёт сама: решение за сотрудником.</p>
        </section>
      )}

      {tab === 'docs' && <Attachments ownerType="equipment" ownerId={e.id} timezone={p.timezone} canAttach={can('repair.attach')} />}

      {tab === 'history' && (
        <section class="yc-panel" role="tabpanel" aria-label="История">
          {history.error && (
            <p class="yc-empty" data-testid="eq-history-denied">
              {history.error.status === 404 || history.error.status === 403 ? 'История изменений этой карточки доступна Владельцу; перемещения видны на вкладке «Размещение», ремонты – на вкладке «Ремонт».' : history.error.text}
            </p>
          )}
          {history.data?.items.length === 0 && <p class="yc-empty">Изменений пока нет.</p>}
          <ul class="yc-eq__rows" data-testid="eq-history">
            {history.data?.items.map((h) => (
              <li class="yc-eq__row" key={h.id}>
                <strong>{AUDIT[h.action] ?? h.action}</strong>
                <span class="yc-eq__muted">{fmtAt(h.at, p.timezone)}{h.actor?.name ? ` · ${h.actor.name}` : ''}</span>
                {h.reason && <span>{h.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="eq-dialog-title" onClose={() => setDlg(null)}>
        <form class="yc-dialog__body" novalidate onSubmit={submit}>
          {dlg === 'status' && (
            <>
              <h2 id="eq-dialog-title">Сменить статус</h2>
              <p class="yc-field__hint">Статус не закрывает ресурс: при неисправности система только предложит блокировку.</p>
              <label class="yc-field"><span class="yc-field__label">Новый статус</span>
                <select class="yc-input" value={status} onChange={(x) => setStatus((x.currentTarget as HTMLSelectElement).value as EquipmentStatus)}>
                  {statusOptions.map((s) => <option key={s} value={s}>{EQUIPMENT_STATUS[s]}</option>)}
                </select>
              </label>
            </>
          )}
          {dlg === 'writeoff' && (
            <>
              <h2 id="eq-dialog-title">Убрать оборудование из работы?</h2>
              <p class="yc-field__hint">Карточки не удаляются: запись уходит в архив со всей историей и остаётся в списке по фильтру статуса. Списание окончательное.</p>
              <label class="yc-check"><input type="radio" name="eq-off" checked={status === 'written_off'} onChange={() => setStatus('written_off')} />В архив как «Списано»</label>
              <label class="yc-check"><input type="radio" name="eq-off" checked={status === 'lost'} onChange={() => setStatus('lost')} />В архив как «Утеряно»</label>
            </>
          )}
          {(dlg === 'status' || dlg === 'writeoff') && (
            <label class="yc-field"><span class="yc-field__label">Причина{reasonNeeded ? ' *' : ''}</span>
              <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(x) => setReason((x.currentTarget as HTMLTextAreaElement).value)} />
            </label>
          )}
          {dlg === 'warranty' && (
            <>
              <h2 id="eq-dialog-title">Гарантия на оборудование</h2>
              <label class="yc-field"><span class="yc-field__label">Начало *</span><input class="yc-input" type="date" value={wFrom} onInput={(x) => setWFrom((x.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Конец *</span><input class="yc-input" type="date" value={wTo} onInput={(x) => setWTo((x.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Кто дал</span><input class="yc-input" maxLength={300} value={wIssuer} onInput={(x) => setWIssuer((x.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Условия</span><input class="yc-input" maxLength={2000} value={wTerms} onInput={(x) => setWTerms((x.currentTarget as HTMLInputElement).value)} /></label>
            </>
          )}
          {dlg === 'warranty-off' && (
            <>
              <h2 id="eq-dialog-title">Гарантия недействительна</h2>
              <p class="yc-field__hint">Запись останется в списке с отметкой.</p>
              <label class="yc-field"><span class="yc-field__label">Причина *</span>
                <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(x) => setReason((x.currentTarget as HTMLTextAreaElement).value)} />
              </label>
            </>
          )}
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={close}>Не менять</button>
            <button type="submit" class="yc-btn" disabled={busy}>Сохранить</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

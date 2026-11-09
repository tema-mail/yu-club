// Блокировка из ремонта (S3-80, K19 №345, §8; TC-12): предпросмотр ничего не пишет; блокировка ставится только после подтверждения
// сотрудника. Затронутые брони не отменяются и не переносятся: список «требуют решения» с действиями K11 №6 (отмена клубом с причиной –
// клиенту сервисное уведомление) и №7 (перенос). Мероприятия – отдельным списком, их не трогаем. Снятие блокировки за закрытым ремонтом –
// K11 №14: шлём rowVersion блокировки из карточки ремонта; конфликт – сообщение «изменил другой», без тихого повтора.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { STATUS_LABEL, bookingApi, fmtRange, type BookingCard, type CrmBookingRow } from '../lib/booking.ts';
import { errorText, fmtAt, fromLocalInput, isOpenRepair, toLocalInput, type BlockProposal, type RepairDto } from '../lib/equipment.ts';
import RescheduleDialog from './RescheduleDialog.tsx';

export interface RepairBlockPanelProps {
  repair: RepairDto;
  timezone: string;
  rooms: Array<{ id: string; name: string }>;
  units: Array<{ id: string; name: string }>;
  cancelReasons: Array<{ id: string; name: string }>;
  canBlock: boolean;
  canCancelBooking: boolean;
  canReschedule: boolean;
  justRegistered: boolean;
  onChanged: (notice: string) => void;
}

export default function RepairBlockPanel(p: RepairBlockPanelProps) {
  const r = p.repair;
  const open = isOpenRepair(r);
  const [proposal, setProposal] = useState<BlockProposal | null>(null);
  const [type, setType] = useState<'unit' | 'room'>('unit');
  const [targetId, setTargetId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [comment, setComment] = useState('');
  const [bookings, setBookings] = useState<CrmBookingRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<'confirm' | 'cancel' | 'reschedule' | null>(null);
  const [cur, setCur] = useState<CrmBookingRow | null>(null);
  const [card, setCard] = useState<BookingCard | null>(null);
  const [reasonId, setReasonId] = useState('');
  const [text, setText] = useState('');
  const [dialogError, setDialogError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const names = (ids: string[]) => ids.map((id) => p.units.find((u) => u.id === id)?.name ?? p.rooms.find((x) => x.id === id)?.name ?? 'Место').join(', ');
  const activeBlocks = r.blocks.filter((b) => b.active);

  const fetchProposal = async (q = '') => {
    setError('');
    try {
      const pr = await browserCall<BlockProposal>(`/repairs/${r.id}/block-proposal${q}`);
      setProposal(pr);
      setBookings(pr.affectedBookings);
      if (pr.target) {
        setType(pr.target.type);
        setTargetId(pr.target.ids[0] ?? '');
      }
      if (pr.period) {
        setStart(toLocalInput(pr.period.start, p.timezone));
        setEnd(toLocalInput(pr.period.end, p.timezone));
      }
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (open) void fetchProposal();
  }, [r.id, open]);

  const preview = async () => {
    if (!targetId) return setError('Выберите, что закрыть.');
    if (!start || !end || start >= end) return setError('Конец блокировки должен быть позже начала.');
    const q = new URLSearchParams({ targetType: type, targetId, start: fromLocalInput(start, p.timezone), end: fromLocalInput(end, p.timezone) });
    await fetchProposal(`?${q}`);
  };
  const openDlg = (k: NonNullable<typeof dlg>, row: CrmBookingRow | null = null) => {
    setDlg(k);
    setCur(row);
    setCard(null);
    setReasonId(p.cancelReasons[0]?.id ?? '');
    setText('');
    setDialogError('');
    dialog.current?.showModal();
  };
  const closeDlg = () => {
    dialog.current?.close();
    setDlg(null);
  };
  const refreshRow = async (id: string) => {
    const c = await bookingApi.card(id);
    setBookings((rows) => rows.map((b) => (b.id === id ? { ...b, status: c.status, start: c.start, end: c.end, resourceName: c.resourceName, rowVersion: c.rowVersion } : b)));
  };
  const confirmBlock = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setDialogError('');
    try {
      const done = await browserCall<{ blockId: string; affectedBookings: CrmBookingRow[]; affectedEventIds: string[] }>(`/repairs/${r.id}/blocks`, {
        method: 'POST',
        body: { target: { type, ids: [targetId] }, period: { start: fromLocalInput(start, p.timezone), end: fromLocalInput(end, p.timezone) }, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      setBookings(done.affectedBookings);
      closeDlg();
      p.onChanged(done.affectedBookings.length > 0 ? `Блокировка поставлена. Записи не отменены – требуют решения: ${done.affectedBookings.length}.` : 'Блокировка поставлена.');
    } catch (err) {
      setDialogError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const cancelBooking = async (e: Event) => {
    e.preventDefault();
    if (busy || !cur) return;
    if (!reasonId) return setDialogError('Выберите причину.');
    if (!text.trim()) return setDialogError('Укажите комментарий.');
    setBusy(true);
    setDialogError('');
    try {
      await bookingApi.cancel(cur.id, { rowVersion: cur.rowVersion, initiator: 'club', reasonId, comment: text.trim() });
      await refreshRow(cur.id);
      closeDlg();
    } catch (err) {
      setDialogError(errorText(err));
      await refreshRow(cur.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const openReschedule = async (row: CrmBookingRow) => {
    openDlg('reschedule', row);
    try {
      setCard(await bookingApi.card(row.id));
    } catch (err) {
      setDialogError(errorText(err));
    }
  };
  const lift = async (blockId: string, rowVersion: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await browserCall(`/blocks/${blockId}/lift`, { method: 'POST', body: { rowVersion, comment: `Снято из ремонта ${r.number}` } });
      p.onChanged('Блокировка снята, запись о ней осталась в истории.');
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'VERSION_CONFLICT' ? 'Блокировку уже изменил другой сотрудник – обновите страницу и проверьте её состояние.' : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const targets = type === 'unit' ? p.units : p.rooms;
  return (
    <section class="yc-panel" aria-labelledby="rp-block" data-testid="rp-block-panel">
      <h2 id="rp-block">Блокировка ресурса</h2>
      {p.justRegistered && open && proposal?.target && <p class="yc-alert yc-alert--ok" role="status" data-testid="rp-suggest">Неисправность зарегистрирована. Система предлагает закрыть место блокировкой – сама она ничего не закрыла.</p>}
      {r.blocks.length > 0 && (
        <ul class="yc-eq__rows" data-testid="rp-blocks">
          {r.blocks.map((b) => (
            <li class="yc-eq__row" key={b.blockId}>
              <span><strong>{b.active ? 'Активна' : 'Снята'}</strong> · {fmtRange(b.period.start, b.period.end, p.timezone)}{b.liftedAt ? ` · снята ${fmtAt(b.liftedAt, p.timezone)}` : ''}</span>
              {b.active && !open && p.canBlock && <span data-testid="rp-still-blocked">Ремонт закрыт, а блокировка стоит: снимите её, когда место будет готово. <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void lift(b.blockId, b.rowVersion)}>Снять блокировку</button></span>}
            </li>
          ))}
        </ul>
      )}
      {!open && activeBlocks.length === 0 && r.blocks.length === 0 && <p class="yc-empty">Блокировок по этому ремонту не было.</p>}
      {open && (
        <>
          {p.canBlock && (
            <div class="yc-eq__pair">
              <label class="yc-field"><span class="yc-field__label">Что закрыть</span>
                <select class="yc-input" value={type} onChange={(e) => { setType((e.currentTarget as HTMLSelectElement).value as 'unit' | 'room'); setTargetId(''); }}>
                  <option value="unit">Место (единица)</option>
                  <option value="room">Комнату целиком</option>
                </select>
              </label>
              <label class="yc-field"><span class="yc-field__label">{type === 'unit' ? 'Место' : 'Комната'}</span>
                <select class="yc-input" value={targetId} onChange={(e) => setTargetId((e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">Выберите…</option>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label class="yc-field"><span class="yc-field__label">С (время филиала)</span><input class="yc-input" type="datetime-local" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} /></label>
              <label class="yc-field"><span class="yc-field__label">По</span><input class="yc-input" type="datetime-local" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} /></label>
            </div>
          )}
          {!p.canBlock && proposal?.target && <p>Предложено закрыть: {names(proposal.target.ids)}.</p>}
          {proposal && !proposal.target && <p class="yc-empty">У ремонта нет места: выберите, что закрыть, и нажмите «Показать затронутых».</p>}
          {proposal && proposal.otherOpenRepairs.length > 0 && <p class="yc-eq__muted" data-testid="rp-other-repairs">На этом месте есть другие открытые ремонты: {proposal.otherOpenRepairs.length}.</p>}
          {p.canBlock && (
            <div class="yc-eq__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void preview()}>Показать затронутых</button>
              <button type="button" class="yc-btn" disabled={!targetId || !start || !end} onClick={() => openDlg('confirm')}>Заблокировать…</button>
            </div>
          )}
        </>
      )}
      <p class="yc-alert yc-alert--error" role="alert">{error}</p>
      {bookings.length > 0 && (
        <div data-testid="rp-affected">
          <h3>Брони – требуют решения</h3>
          <p class="yc-field__hint">Блокировка не отменяет и не переносит записи сама: по каждой решает сотрудник.</p>
          <ul class="yc-eq__rows">
            {bookings.map((b) => (
              <li class="yc-eq__row" key={b.id} data-testid={`rp-booking-${b.id}`}>
                <span><a href={`/bookings/${b.id}`}><strong>№{b.number}</strong></a> · {b.resourceName} · {fmtRange(b.start, b.end, p.timezone)}</span>
                <span>{b.client.name ?? 'Клиент'} · {b.client.phoneMasked} · <span data-testid="rp-booking-status">{STATUS_LABEL[b.status]}</span></span>
                {b.status === 'confirmed' && (
                  <span class="yc-eq__actions">
                    {p.canReschedule && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void openReschedule(b)}>Перенести…</button>}
                    {p.canCancelBooking && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => openDlg('cancel', b)}>Отменить клубом…</button>}
                  </span>
                )}
                {b.status === 'cancelled_by_club' && <span class="yc-eq__muted">Клиент получит сервисное уведомление об отмене.</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposal && proposal.affectedEvents.length > 0 && (
        <div data-testid="rp-events">
          <h3>Мероприятия на этих местах</h3>
          <p class="yc-field__hint">Блокировка их не трогает: перенос или отмена – в карточке мероприятия.</p>
          <ul class="yc-eq__rows">
            {proposal.affectedEvents.map((ev) => <li class="yc-eq__row" key={ev.eventId}><span><a href={`/events/${ev.eventId}`} target="_blank" rel="noopener"><strong>{ev.number ?? `Мероприятие ${ev.eventId.slice(-6)}`}</strong></a>{ev.start && ev.end ? ` · ${fmtRange(ev.start, ev.end, p.timezone)}` : ''}</span></li>)}
          </ul>
        </div>
      )}
      <dialog ref={dialog} class={`yc-dialog${dlg === 'reschedule' ? ' yc-dialog--wide' : ''}`} aria-labelledby={dlg === 'reschedule' ? 'bk-dialog-title' : 'rp-block-title'} onClose={() => setDlg(null)}>
        {dlg === 'confirm' && (
          <form class="yc-dialog__body" novalidate onSubmit={confirmBlock}>
            <h2 id="rp-block-title">Заблокировать: {names([targetId])}?</h2>
            <p>С {start.replace('T', ' ')} по {end.replace('T', ' ')}. Новые записи на это время будут невозможны.</p>
            <p class="yc-field__hint" data-testid="rp-confirm-note">Существующие записи ({bookings.length}) не отменятся: они останутся в списке «требуют решения».</p>
            <label class="yc-field"><span class="yc-field__label">Комментарий</span><input class="yc-input" maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLInputElement).value)} /></label>
            <p class="yc-alert yc-alert--error" role="alert">{dialogError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={closeDlg}>Не блокировать</button>
              <button type="submit" class="yc-btn" disabled={busy}>Подтвердить блокировку</button>
            </div>
          </form>
        )}
        {dlg === 'cancel' && cur && (
          <form class="yc-dialog__body" novalidate onSubmit={cancelBooking}>
            <h2 id="rp-block-title">Отменить запись №{cur.number} клубом?</h2>
            <p class="yc-field__hint">Клиенту уйдёт сервисное уведомление об отмене. Время освободится для записи после снятия блокировки.</p>
            <label class="yc-field"><span class="yc-field__label">Причина *</span>
              <select class="yc-input" value={reasonId} onChange={(e) => setReasonId((e.currentTarget as HTMLSelectElement).value)}>
                {p.cancelReasons.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label class="yc-field"><span class="yc-field__label">Комментарий *</span>
              <textarea class="yc-input" rows={2} maxLength={1000} value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
            </label>
            <p class="yc-alert yc-alert--error" role="alert">{dialogError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={closeDlg}>Не отменять</button>
              <button type="submit" class="yc-btn yc-btn--danger" disabled={busy}>Отменить запись</button>
            </div>
          </form>
        )}
        {dlg === 'reschedule' && !card && <div class="yc-dialog__body"><h2 id="bk-dialog-title">Перенести запись</h2><p class="yc-alert yc-alert--error" role="alert">{dialogError}</p><div class="yc-dialog__actions"><button type="button" class="yc-btn yc-btn--ghost" onClick={closeDlg}>Закрыть</button></div></div>}
        {dlg === 'reschedule' && card && (
          <RescheduleDialog
            booking={card}
            busy={busy}
            error={dialogError}
            onCancel={closeDlg}
            onSubmit={async (body) => {
              setBusy(true);
              setDialogError('');
              try {
                await bookingApi.reschedule(card.id, { rowVersion: card.rowVersion, ...body });
                await refreshRow(card.id);
                closeDlg();
              } catch (err) {
                setDialogError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </dialog>
    </section>
  );
}

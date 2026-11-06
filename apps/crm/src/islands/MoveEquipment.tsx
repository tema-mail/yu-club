// Перемещение оборудования (S3-77, K19 №334, §4, §18; 02 §10): новое место, момент и причина. Если на прежнем месте есть будущие брони,
// удержания или мероприятия – сервер отвечает EQUIPMENT_MOVE_HAS_BOOKINGS: окно показывает список и без галочки «беру решение на себя»
// повторно не отправляет. С подтверждением брони не трогаются, автор и список уходят в аудит, ответ несёт предложение блокировки.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { bookingApi, fmtRange, type CrmBookingRow } from '../lib/booking.ts';
import { errorText, fromLocalInput, toLocalInput, type BlockProposal, type EquipmentDto, type PlaceOption } from '../lib/equipment.ts';

export interface MoveEquipmentProps {
  equipment: EquipmentDto;
  timezone: string;
  branches: Array<{ id: string; name: string; timezone: string }>;
  roomsByBranch: Record<string, PlaceOption[]>;
  unitsByBranch: Record<string, PlaceOption[]>;
  onMoved: (r: { equipment: EquipmentDto; affectedBookingIds: string[]; blockProposal: BlockProposal | null }) => void;
  onClose: () => void;
}
interface Conflict { bookings: Array<Pick<CrmBookingRow, 'id' | 'number' | 'resourceName' | 'start' | 'end'>>; unknownBookings: number; holds: number; eventIds: string[] }

export default function MoveEquipment(p: MoveEquipmentProps) {
  const e = p.equipment;
  const dialog = useRef<HTMLDialogElement>(null);
  const [branchId, setBranchId] = useState(e.placement.branchId);
  const [roomId, setRoomId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [at, setAt] = useState(toLocalInput(Date.now(), p.timezone));
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const rooms = p.roomsByBranch[branchId] ?? [];
  const units = (p.unitsByBranch[branchId] ?? []).filter((u) => !roomId || u.roomId === roomId);
  const notPlaceable = e.status === 'reserve' || e.status === 'lost';
  const changed = () => {
    setConflict(null);
    setAck(false);
    setError('');
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    if (!reason.trim()) return setError('Укажите причину перемещения.');
    if (!at) return setError('Укажите момент перемещения.');
    if (conflict && !ack) return setError('Отметьте, что берёте решение по затронутым записям на себя, – без этого перемещения не будет.');
    setBusy(true);
    setError('');
    try {
      const r = await browserCall<Parameters<MoveEquipmentProps['onMoved']>[0]>(`/equipment/${e.id}/move`, {
        method: 'POST',
        body: { rowVersion: e.rowVersion, to: { branchId, roomId: roomId || null, unitId: unitId || null }, at: fromLocalInput(at, p.timezone), reason: reason.trim(), ...(conflict && ack ? { acknowledgeBookings: true } : {}) },
      });
      dialog.current?.close();
      p.onMoved(r);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EQUIPMENT_MOVE_HAS_BOOKINGS') {
        const d = err.details as { bookingIds?: string[]; holdIds?: string[]; eventIds?: string[] };
        const ids = d.bookingIds ?? [];
        const cards = await Promise.all(ids.map((id) => bookingApi.card(id).catch(() => null)));
        const bookings = cards.filter((c): c is NonNullable<typeof c> => c !== null);
        setConflict({ bookings, unknownBookings: ids.length - bookings.length, holds: d.holdIds?.length ?? 0, eventIds: d.eventIds ?? [] });
        setAck(false);
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="eq-move-title" onClose={p.onClose}>
      <form class="yc-dialog__body" novalidate onSubmit={submit}>
        <h2 id="eq-move-title">Переместить оборудование</h2>
        <label class="yc-field"><span class="yc-field__label">Филиал</span>
          <select class="yc-input" value={branchId} onChange={(x) => { setBranchId((x.currentTarget as HTMLSelectElement).value); setRoomId(''); setUnitId(''); changed(); }}>
            {p.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        {notPlaceable ? (
          <p class="yc-field__hint">Резервное и утерянное не ставится в комнату: только на склад филиала.</p>
        ) : (
          <div class="yc-eq__pair">
            <label class="yc-field"><span class="yc-field__label">Комната</span>
              <select class="yc-input" value={roomId} onChange={(x) => { setRoomId((x.currentTarget as HTMLSelectElement).value); setUnitId(''); changed(); }}>
                <option value="">Склад филиала</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label class="yc-field"><span class="yc-field__label">Место (единица)</span>
              <select class="yc-input" value={unitId} onChange={(x) => { setUnitId((x.currentTarget as HTMLSelectElement).value); changed(); }}>
                <option value="">Без места</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          </div>
        )}
        <label class="yc-field"><span class="yc-field__label">Когда перемещено * (время филиала)</span>
          <input class="yc-input" type="datetime-local" value={at} onInput={(x) => setAt((x.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="yc-field"><span class="yc-field__label">Причина *</span>
          <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(x) => setReason((x.currentTarget as HTMLTextAreaElement).value)} />
        </label>
        {conflict && (
          <section class="yc-eq__warn" data-testid="move-conflict">
            <strong>На прежнем месте есть будущие записи. Они останутся как есть: перемещение их не отменит.</strong>
            {conflict.bookings.length + conflict.unknownBookings > 0 && (
              <ul class="yc-eq__rows" data-testid="move-bookings">
                {conflict.bookings.map((b) => <li key={b.id}><a href={`/bookings/${b.id}`} target="_blank" rel="noopener">Бронь №{b.number}</a> · {b.resourceName} · {fmtRange(b.start, b.end, p.timezone)}</li>)}
                {conflict.unknownBookings > 0 && <li>Ещё броней вне вашего доступа: {conflict.unknownBookings}</li>}
              </ul>
            )}
            {conflict.eventIds.length > 0 && <p data-testid="move-events">Затронуто мероприятий: {conflict.eventIds.length} ({conflict.eventIds.map((id) => id.slice(-6)).join(', ')})</p>}
            {conflict.holds > 0 && <p>Незавершённых удержаний на сайте: {conflict.holds}</p>}
            <label class="yc-check"><input type="checkbox" checked={ack} onChange={(x) => setAck((x.currentTarget as HTMLInputElement).checked)} />Видел список, беру решение на себя</label>
          </section>
        )}
        <p class="yc-alert yc-alert--error" role="alert">{error}</p>
        <div class="yc-dialog__actions">
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Не перемещать</button>
          <button type="submit" class="yc-btn" disabled={busy}>{conflict ? 'Переместить с подтверждением' : 'Переместить'}</button>
        </div>
      </form>
    </dialog>
  );
}

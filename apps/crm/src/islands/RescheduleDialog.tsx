// Перенос брони (S1-23, K11 №7): новый слот выбирается в календаре филиала (режим pick – свободное время после
// «сейчас» в часах работы), длительность сохраняется, время можно уточнить. Причина обязательна (сервер – COMMENT_REQUIRED).
// Перед отправкой – «было → станет»; занятость и часы проверяет сервер теми же правилами, что при создании.
import { useState } from 'preact/hooks';
import { fmtRange, inZone, zonedIso, type BookingCard } from '../lib/booking.ts';
import { BeforeAfter } from './BookingCard.tsx';
import BranchCalendar, { type SlotPick } from './BranchCalendar.tsx';

export interface RescheduleDialogProps {
  booking: BookingCard;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (body: { resourceId: string; start: string; end: string; reason: string }) => void;
}

export default function RescheduleDialog({ booking: b, busy, error, onCancel, onSubmit }: RescheduleDialogProps) {
  const tz = b.timezone;
  const minutes = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000);
  const [pick, setPick] = useState<SlotPick | null>(null);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState('');

  const choose = (s: SlotPick) => {
    setPick(s);
    setTime(s.hm);
    setLocal('');
  };
  const start = pick && /^\d{2}:\d{2}$/.test(time) ? zonedIso(pick.date, time, tz) : null;
  const end = start ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : null;

  const submit = (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!pick || !start || !end) return setLocal('Выберите новое время в календаре.');
    if (!reason.trim()) return setLocal('Укажите причину переноса.');
    setLocal('');
    onSubmit({ resourceId: pick.resourceId, start, end, reason: reason.trim() });
  };

  return (
    <form class="yc-dialog__body" novalidate onSubmit={submit}>
      <h2 id="bk-dialog-title">Перенести запись</h2>
      <p class="yc-field__hint">Нажмите на свободное время – длительность сохранится ({minutes} мин). Время филиала ({tz}).</p>
      <BranchCalendar branchId={b.branchId} timezone={tz} view="day" date={inZone(b.start, tz).date} mode="pick" onSlot={choose} highlightId={b.id} />
      {pick && (
        <div class="yc-board__pair">
          <div class="yc-field">
            <span class="yc-field__label">Новое место</span>
            <span data-testid="pick-place">{pick.resourceName}, {pick.date.slice(8, 10)}.{pick.date.slice(5, 7)}</span>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="rs-time">Начало</label>
            <input id="rs-time" class="yc-input" type="time" step={900} value={time} onInput={(e) => setTime((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
      )}
      {start && end && <BeforeAfter before={`${b.resourceName}, ${fmtRange(b.start, b.end, tz)}`} after={`${pick!.resourceName}, ${fmtRange(start, end, tz)}`} />}
      <div class="yc-field">
        <label class="yc-field__label" for="rs-reason">Причина переноса *</label>
        <textarea id="rs-reason" class="yc-input" rows={2} maxLength={1000} value={reason} onInput={(e) => (setReason((e.currentTarget as HTMLTextAreaElement).value), setLocal(''))} />
      </div>
      <p class="yc-alert yc-alert--error" role="alert">{local || error}</p>
      <div class="yc-dialog__actions">
        <button type="button" class="yc-btn yc-btn--ghost" onClick={onCancel}>Не менять</button>
        <button type="submit" class="yc-btn" disabled={busy}>Перенести</button>
      </div>
    </form>
  );
}

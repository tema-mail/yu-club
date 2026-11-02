// «К оплате» на рабочем столе (S2-64, K10 №22): пришедшие и завершённые за сутки филиала без живого платежа (и после
// полного возврата). Первая страница – с сервера при отрисовке; при возврате на вкладку или кнопкой «Назад» (bfcache)
// список перечитывается – оплаченная в карточке запись исчезает. Время – по зоне филиала. Суммы – копейки → рубли.
import { useEffect, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { bookingError, fmtRange } from '../lib/booking.ts';
import { rub } from './CashJournal.tsx';

export interface UnpaidRow {
  bookingId: string; number: number; status: string; clientId: string; resourceName: string | null;
  start: string; end: string; amountDueKop: number; paymentStatus: 'unpaid' | 'refunded';
}
export interface UnpaidPage { items: UnpaidRow[]; nextCursor: string | null }
export interface UnpaidListProps { branchId: string; timezone: string; date: string; isToday: boolean; initial: UnpaidPage }

const url = (branchId: string, date: string, cursor?: string) =>
  `/branches/${encodeURIComponent(branchId)}/unpaid?date=${date}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

export default function UnpaidList({ branchId, timezone: tz, date, isToday, initial }: UnpaidListProps) {
  const [items, setItems] = useState(initial.items);
  const [next, setNext] = useState(initial.nextCursor);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const r = await browserCall<UnpaidPage>(url(branchId, date));
      setItems(r.items);
      setNext(r.nextCursor);
      setError('');
    } catch (e) {
      setError(bookingError(e));
    }
  };
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && void reload();
    const onVisible = () => document.visibilityState === 'visible' && void reload();
    addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [branchId, date]);

  const more = async () => {
    if (!next || busy) return;
    setBusy(true);
    try {
      const r = await browserCall<UnpaidPage>(url(branchId, date, next));
      setItems((x) => [...x, ...r.items]);
      setNext(r.nextCursor);
    } catch (e) {
      setError(bookingError(e));
    } finally {
      setBusy(false);
    }
  };
  const total = items.reduce((s, i) => s + i.amountDueKop, 0);

  return (
    <section class="yc-panel yc-desk__panel" aria-labelledby="desk-unpaid" data-testid="desk-unpaid">
      <h2 id="desk-unpaid">К оплате <span class="yc-desk__count">{items.length}{next ? '+' : ''}</span></h2>
      {error && <p class="yc-alert yc-alert--error" role="alert">Список не обновился: {error} <button type="button" class="yc-link" onClick={() => void reload()}>Повторить</button></p>}
      {items.length === 0 ? (
        <p class="yc-empty">{isToday ? 'Все пришедшие сегодня оплатили.' : 'За этот день неоплаченных посещений нет.'}</p>
      ) : (
        <>
          <p class="yc-desk__hint">Клиент пришёл, оплата не проведена{next ? '' : ` – всего ${rub(total)}`}. Откройте запись и проведите оплату.</p>
          <ul class="yc-desk__list">
            {items.map((i) => (
              <li class="yc-desk__row" key={i.bookingId} data-testid="unpaid-row">
                <a href={`/bookings/${encodeURIComponent(i.bookingId)}`}>№{i.number} · {fmtRange(i.start, i.end, tz, false)}{i.resourceName ? ` · ${i.resourceName}` : ''}</a>
                <span>
                  к оплате {rub(i.amountDueKop)}
                  {i.paymentStatus === 'refunded' && <span class="yc-badge yc-badge--decide yc-badge--system">после возврата</span>}
                </span>
              </li>
            ))}
          </ul>
          {next && <p><button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void more()}>Показать ещё</button></p>}
        </>
      )}
    </section>
  );
}

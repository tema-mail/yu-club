// «Мои записи» в ЛК (S1-17, карта сайта 3.6, K9): вкладки будущие / прошлые / отменённые – GET /me/bookings?tab=,
// история посещений – GET /me/visits (только фактические приходы). Идущий сеанс API отдаёт в «будущих».
// Отмена – только у записи с canCancel (подтверждена, сеанс не начался): окно подтверждения, POST /bookings/{id}/cancel
// с одним Idempotency-Key на окно. Денег нет: предоплаты нет, отмена бесплатна (R-12). Сервер видит только записи
// вошедшего клиента – остров ничего не фильтрует сам.
import { useEffect, useRef, useState } from 'preact/hooks';
import { bookingApi, dayLabel, rub, timeIn, type MyBookingDto, type MyTab, type MyVisitDto } from '../lib/booking.ts';
import { ClientApiError, errorText } from '../lib/client.ts';

type Tab = MyTab | 'visits';
const TABS: Array<{ id: Tab; label: string; empty: string }> = [
  { id: 'upcoming', label: 'Будущие', empty: 'Будущих записей нет.' },
  { id: 'past', label: 'Прошлые', empty: 'Прошедших записей пока нет.' },
  { id: 'cancelled', label: 'Отменённые', empty: 'Отменённых записей нет.' },
  { id: 'visits', label: 'Посещения', empty: 'Посещений пока нет: здесь появятся визиты, отмеченные администратором клуба.' },
];

interface List<T> { items: T[]; next: string | null }
type Lists = { [K in MyTab]?: List<MyBookingDto> } & { visits?: List<MyVisitDto> };

const localDay = (iso: string, tz: string) => dayLabel(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso))).day;
/** У посещения в K9 нет зоны филиала – время по часам устройства (клиент обычно в том же городе). */
const visitTime = (iso: string, withDay = false) =>
  new Intl.DateTimeFormat('ru-RU', withDay ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const when = (start: string, end: string, tz: string) => `${localDay(start, tz)}, ${timeIn(start, tz)}–${timeIn(end, tz)}`;

function statusOf(b: MyBookingDto, now: number): string {
  const going = Date.parse(b.start) <= now && now < Date.parse(b.end);
  switch (b.status) {
    case 'confirmed': return going ? 'Идёт сеанс' : Date.parse(b.end) <= now ? 'Прошла' : 'Подтверждена';
    case 'arrived': return going ? 'Идёт сеанс – вы в клубе' : 'Вы были в клубе';
    case 'completed': return 'Завершена';
    case 'no_show': return 'Неявка';
    case 'cancelled_by_client': return 'Отменена вами';
    case 'cancelled_by_club': return 'Отменена клубом';
    default: return '';
  }
}

export default function MyBookings() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const [lists, setLists] = useState<Lists>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<MyBookingDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelKey = useRef('');

  async function load(t: Tab, more = false) {
    setLoading(true);
    setError('');
    try {
      const cursor = more ? (lists[t]?.next ?? undefined) : undefined;
      if (t === 'visits') {
        const p = await bookingApi.myVisits(cursor);
        setLists((l) => ({ ...l, visits: { items: [...(more ? (l.visits?.items ?? []) : []), ...p.items], next: p.nextCursor } }));
      } else {
        const p = await bookingApi.myBookings(t, cursor);
        setLists((l) => ({ ...l, [t]: { items: [...(more ? (l[t]?.items ?? []) : []), ...p.items], next: p.nextCursor } }));
      }
    } catch (e) {
      if (e instanceof ClientApiError && e.status === 401) {
        location.assign(`/login/?next=${encodeURIComponent('/account/')}`);
        return;
      }
      setError(`Не удалось загрузить записи. ${errorText(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!lists[tab]) void load(tab);
  }, [tab]);

  function ask(b: MyBookingDto) {
    cancelKey.current = crypto.randomUUID();
    setCancelError('');
    setTarget(b);
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
    setTarget(null);
  }

  async function cancel() {
    if (!target || cancelling) return;
    setCancelling(true);
    setCancelError('');
    try {
      const b = await bookingApi.cancel(target.id, cancelKey.current);
      close();
      setNotice(`Запись № ${b.number} отменена. Время освободилось для других гостей.`);
      setLists((l) => ({ ...l, upcoming: l.upcoming && { ...l.upcoming, items: l.upcoming.items.filter((x) => x.id !== b.id) }, cancelled: undefined }));
    } catch (e) {
      if (e instanceof ClientApiError && e.code === 'BOOKING_NOT_CANCELLABLE') {
        setCancelError('Эту запись уже нельзя отменить онлайн: сеанс начался или клуб изменил запись. Позвоните в клуб.');
        setLists((l) => ({ ...l, upcoming: undefined }));
        void load('upcoming');
      } else setCancelError(errorText(e));
    } finally {
      setCancelling(false);
    }
  }

  const now = Date.now();
  const current = TABS.find((t) => t.id === tab)!;
  const list = lists[tab];

  return (
    <section class="yu-account__block yu-mybookings" aria-labelledby="mybookings-title" data-testid="my-bookings">
      <div class="yu-mybookings__head">
        <h2 id="mybookings-title">Мои записи</h2>
        <a class="yu-btn" href="/schedule/" data-testid="book-more">Записаться ещё</a>
      </div>
      <div class="yu-tabs" role="tablist" aria-label="Мои записи">
        {TABS.map((t) => (
          <button
            key={t.id} type="button" role="tab" id={`mb-tab-${t.id}`} class="yu-tabs__tab"
            aria-selected={tab === t.id} aria-controls="mb-panel" onClick={() => { setNotice(''); setTab(t.id); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p class="yu-notice yu-mybookings__notice" role="status" hidden={!notice}>{notice}</p>
      <div id="mb-panel" role="tabpanel" aria-labelledby={`mb-tab-${tab}`} aria-busy={loading}>
        {error && (
          <p class="yu-alert" role="alert">
            {error} <button type="button" class="yu-link-btn" onClick={() => load(tab)}>Повторить</button>
          </p>
        )}
        {!list && !error && <p class="yu-body">Загружаем…</p>}
        {list && list.items.length === 0 && (
          <p class="yu-body" data-testid="my-empty">
            {current.empty} {tab === 'upcoming' && <a href="/schedule/">Выбрать время</a>}
          </p>
        )}
        {list && list.items.length > 0 && (
          <ul class="yu-mybookings__list" data-testid={`my-list-${tab}`}>
            {tab === 'visits'
              ? (list.items as MyVisitDto[]).map((v) => (
                <li key={v.bookingId} class="yu-mybookings__item">
                  <p class="yu-mybookings__title">№ {v.number} · {v.resourceName}</p>
                  <p class="yu-mybookings__meta">{v.branchName}</p>
                  <p class="yu-mybookings__meta">Сеанс {visitTime(v.plannedStart, true)}–{visitTime(v.plannedEnd)}, пришли в {visitTime(v.arrivedAt)}</p>
                </li>
              ))
              : (list.items as MyBookingDto[]).map((b) => (
                <li key={b.id} class="yu-mybookings__item" data-testid="my-booking">
                  <div class="yu-mybookings__row">
                    <p class="yu-mybookings__title">№ {b.number} · {b.resourceName}{b.roomName && b.roomName !== b.resourceName ? `, ${b.roomName}` : ''}</p>
                    <span class="yu-mybookings__status" data-status={b.status}>{statusOf(b, now)}</span>
                  </div>
                  <p class="yu-mybookings__meta">{when(b.start, b.end, b.timezone)} · {b.durationMinutes} мин</p>
                  <p class="yu-mybookings__meta">{b.cityName}, {b.branchName}, {b.branchAddress}</p>
                  <p class="yu-mybookings__meta">{rub(b.priceKop)} – оплата в клубе</p>
                  {b.canCancel && (
                    <button type="button" class="yu-btn yu-btn--ghost" onClick={() => ask(b)}>Отменить запись</button>
                  )}
                </li>
              ))}
          </ul>
        )}
        {list?.next && (
          <button type="button" class="yu-btn yu-btn--ghost" onClick={() => load(tab, true)} disabled={loading}>Показать ещё</button>
        )}
      </div>

      <dialog ref={dialog} class="yu-dialog" aria-labelledby="cancel-title" onClose={() => setTarget(null)}>
        {target && (
          <div class="yu-dialog__body">
            <h3 id="cancel-title">Отменить запись № {target.number}?</h3>
            <p class="yu-body">{target.resourceName}, {when(target.start, target.end, target.timezone)}, {target.branchName}.</p>
            <p class="yu-body"><strong>Предоплаты нет, отмена бесплатна.</strong> Время освободится для других гостей.</p>
            {cancelError && <p class="yu-alert" role="alert">{cancelError}</p>}
            <div class="yu-hold__actions">
              <button type="button" class="yu-btn" onClick={cancel} disabled={cancelling}>{cancelling ? 'Отменяем…' : 'Да, отменить'}</button>
              <button type="button" class="yu-btn yu-btn--ghost" onClick={close} disabled={cancelling}>Не отменять</button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}

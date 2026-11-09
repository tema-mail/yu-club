// ЛК «Мои мероприятия» (S3-93, K20 §10, П3 GET /me/events): мероприятия, где клиент – заказчик, от «подтверждено»; дата, филиал,
// состав (названия и количество – без цен и себестоимости, их в ответе нет), связанные записи – только чтение (11 §12).
// Время – часами браузера: в П3 нет зоны филиала (сеть сейчас в UTC+7; расхождение записано в отчёт S3-93).
import { useEffect, useState } from 'preact/hooks';
import { browserCall, errorText } from '../lib/client.ts';

/** Элемент П3 (events/routes.public.ts). */
export interface MyEventDto {
  id: string; number: string; title: string;
  status: 'confirmed' | 'preparing' | 'in_progress' | 'completed';
  start: string | null; end: string | null;
  branch: { name: string; address: string };
  lines: Array<{ name: string; quantity: number; unit: string }>;
  bookingIds: string[];
}

const STATUS: Record<MyEventDto['status'], string> = { confirmed: 'Подтверждено', preparing: 'Готовим', in_progress: 'Идёт', completed: 'Прошло' };
const LOOK: Record<MyEventDto['status'], string> = { confirmed: 'confirmed', preparing: 'confirmed', in_progress: 'arrived', completed: 'completed' };
const day = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const time = (iso: string) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const qty = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);

export default function MyEvents() {
  const [items, setItems] = useState<MyEventDto[] | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setItems((await browserCall<{ items: MyEventDto[] }>('/me/events')).items);
    } catch (e) {
      setError(`Не удалось загрузить мероприятия. ${errorText(e)}`);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <section class="yu-account__block" aria-labelledby="events-title" data-testid="my-events">
      <h2 id="events-title">Мои мероприятия</h2>
      {error && <p class="yu-alert" role="alert">{error} <button type="button" class="yu-link-btn" onClick={load}>Повторить</button></p>}
      {!items && !error && <p class="yu-body">Загружаем…</p>}
      {items && items.length === 0 && (
        <p class="yu-body" data-testid="events-empty">Мероприятий пока нет. Праздник можно заказать на странице <a href="/birthday/">«День рождения»</a> – после подтверждения клубом он появится здесь.</p>
      )}
      {items && items.length > 0 && (
        <ul class="yu-mybookings__list">
          {items.map((e) => (
            <li key={e.id} class="yu-mybookings__item" data-testid="event">
              <div class="yu-mybookings__row">
                <p class="yu-mybookings__title">{e.title} <span style={{ whiteSpace: 'nowrap' }}>№ {e.number}</span></p>
                <span class="yu-mybookings__status" data-status={LOOK[e.status]}>{STATUS[e.status]}</span>
              </div>
              <p class="yu-mybookings__meta" data-testid="event-when">
                {e.start ? `${day(e.start)}, ${time(e.start)}${e.end ? `–${time(e.end)}` : ''}` : 'Дата согласуется с клубом'}
              </p>
              <p class="yu-mybookings__meta">{e.branch.name}, {e.branch.address}</p>
              {e.lines.length > 0 && (
                <ul class="yu-body" data-testid="event-lines">
                  {e.lines.map((l, i) => <li key={`${l.name}-${i}`}>{l.name} – {qty(l.quantity)} {l.unit}</li>)}
                </ul>
              )}
              {e.bookingIds.length > 0 && <p class="yu-mybookings__meta">Связанных записей: {e.bookingIds.length} – они в разделе «Мои записи».</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Чек-лист подготовки (S3-82, K20 §5, №367, 11 §6): 10 пунктов при создании, свои добавляются; ненужный помечается «Не нужно», удаления нет.
// Пункт «Проверка оплаты» показывает остаток к оплате и деньги не меняет. Правка мероприятия – event.manage; после завершения – только чтение
// сервер не запрещает отметки, поэтому чек-лист остаётся доступным и в закрытом мероприятии.
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { CHECK_STATUS, atText, eventError, type ChecklistItem } from '../lib/events.ts';
import { rub } from './CashJournal.tsx';
import type { EventTabProps } from './EventParts.tsx';

const ORDER: ChecklistItem['status'][] = ['todo', 'done', 'not_needed'];

export default function EventChecklist(p: EventTabProps) {
  const c = p.card;
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState<Record<string, string>>({});
  const key = useRef(crypto.randomUUID());
  const canEdit = p.actions.includes('event.manage');
  const done = c.checklist.filter((i) => i.status === 'done').length;
  const needed = c.checklist.filter((i) => i.status !== 'not_needed').length;
  const who = (id: string | null) => p.staff.find((s) => s.id === id)?.name ?? 'Сотрудник';

  const patch = async (item: ChecklistItem, change: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}/checklist`, { method: 'PATCH', body: { itemId: item.id, ...change } });
      await p.onChanged();
    } catch (err) {
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) return setError('Напишите, что нужно сделать.');
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}/checklist`, { method: 'POST', key: key.current, body: { title: title.trim() } });
      key.current = crypto.randomUUID();
      setTitle('');
      await p.onChanged('Пункт добавлен.');
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p data-testid="check-progress">Сделано {done} из {needed}. Чек-лист не заменяет финансовых операций: оплату вносите на вкладке «Поступления».</p>
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      <ul class="yc-ev__checks" data-testid="event-checklist">
        {c.checklist.map((i) => (
          <li class={`yc-ev__check yc-ev__check--${i.status}`} key={i.id} data-testid={`check-${i.code ?? i.title}`}>
            <div class="yc-ev__stack">
              <strong>{i.title}</strong>
              {i.code === 'payment' && i.dueKop !== undefined && <span data-testid="check-due">Остаток к оплате: {rub(i.dueKop)}</span>}
              {i.updatedAt && <span class="yc-ev__muted">{who(i.updatedBy)}, {atText(i.updatedAt, c.timezone)}</span>}
            </div>
            {canEdit ? (
              <>
                <div class="yc-seg yc-ev__seg" role="group" aria-label={`Статус: ${i.title}`}>
                  {ORDER.map((s) => <button key={s} type="button" class="yc-seg__btn" aria-pressed={i.status === s} disabled={busy} onClick={() => i.status !== s && patch(i, { status: s })}>{CHECK_STATUS[s]}</button>)}
                </div>
                <label class="yc-field"><span class="yc-field__label">Комментарий</span>
                  <input class="yc-input" type="text" maxLength={2000} value={comment[i.id] ?? i.comment ?? ''} onInput={(e) => setComment({ ...comment, [i.id]: e.currentTarget.value })}
                    onBlur={() => comment[i.id] !== undefined && comment[i.id] !== (i.comment ?? '') && patch(i, { comment: comment[i.id]!.trim() || null })} /></label>
              </>
            ) : <span>{CHECK_STATUS[i.status]}{i.comment ? `: ${i.comment}` : ''}</span>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form class="yc-ev__row" novalidate onSubmit={add}>
          <label class="yc-field"><span class="yc-field__label">Новый пункт</span><input class="yc-input" type="text" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
          <button class="yc-btn yc-btn--ghost" type="submit" disabled={busy}>Добавить</button>
        </form>
      )}
    </>
  );
}

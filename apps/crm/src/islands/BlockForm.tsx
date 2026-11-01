// Блокировка ресурсов (S1-24, booking/blocks.ts, 01 §13): ремонт, обслуживание, закрытие места или комнаты на период.
// Блокировка ложится поверх броней и их НЕ удаляет: сервер возвращает список затронутых – решение по каждой за
// сотрудником. Снятие – через окно подтверждения. Списка блокировок в API пока нет: экран показывает созданную сейчас.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

interface Block { id: string; targetType: string; targetIds: string[]; start: string; end: string; reasonId: string; comment: string | null; status: 'active' | 'lifted'; unitIds: string[]; rowVersion: number }

export interface BlockFormProps {
  branchId: string;
  timezone: string;
  rooms: Array<{ id: string; name: string }>;
  resources: Array<{ id: string; name: string }>;
  reasons: Array<{ id: string; name: string; requiresComment: boolean }>;
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');
const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function BlockForm(props: BlockFormProps) {
  const { rooms, resources, reasons } = props;
  const [type, setType] = useState<'resources' | 'room'>('resources');
  const [ids, setIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  const [start, setStart] = useState(local(new Date(Date.now() + 60 * 60_000)));
  const [end, setEnd] = useState(local(new Date(Date.now() + 3 * 3600_000)));
  const [reasonId, setReasonId] = useState(reasons[0]?.id ?? '');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [created, setCreated] = useState<{ block: Block; affected: string[] } | null>(null);
  const [liftComment, setLiftComment] = useState('');
  const [liftError, setLiftError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: props.timezone });
  const reason = reasons.find((r) => r.id === reasonId);
  const targetName = (b: Block) =>
    b.targetIds.map((id) => (b.targetType === 'room' ? rooms : resources).find((x) => x.id === id)?.name ?? id).join(', ');

  const submit = async (e: Event) => {
    e.preventDefault();
    setMsg(null);
    const target = type === 'room' ? { type: 'room', ids: roomId ? [roomId] : [] } : { type: ids.length === 1 ? 'resource' : 'resources', ids };
    const s = new Date(start);
    const en = new Date(end);
    if (target.ids.length === 0) return setMsg({ ok: false, text: 'Выберите, что блокировать.' });
    if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime()) || !(s < en)) return setMsg({ ok: false, text: 'Конец блокировки должен быть позже начала.' });
    if (reason?.requiresComment && !comment.trim()) return setMsg({ ok: false, text: 'Для этой причины нужен комментарий.' });
    setBusy(true);
    try {
      const r = await browserCall<{ block: Block; affectedBookingIds: string[]; affectedHoldIds: string[] }>(
        `/branches/${encodeURIComponent(props.branchId)}/blocks`,
        { method: 'POST', body: { target, start: s.toISOString(), end: en.toISOString(), reasonId, ...(comment.trim() ? { comment: comment.trim() } : {}) } },
      );
      setCreated({ block: r.block, affected: [...r.affectedBookingIds, ...r.affectedHoldIds] });
      setMsg({ ok: true, text: 'Блокировка создана.' });
    } catch (err) {
      setMsg({ ok: false, text: `Не создано: ${errorText(err)}.` });
    } finally {
      setBusy(false);
    }
  };

  const lift = async () => {
    if (!created) return;
    setBusy(true);
    setLiftError('');
    try {
      const b = await browserCall<Block>(`/blocks/${encodeURIComponent(created.block.id)}/lift`, {
        method: 'POST', body: { rowVersion: created.block.rowVersion, ...(liftComment.trim() ? { comment: liftComment.trim() } : {}) },
      });
      setCreated({ ...created, block: b });
      dialog.current?.close();
    } catch (err) {
      setLiftError(err instanceof ApiError && err.code === 'VERSION_CONFLICT'
        ? 'Блокировку уже изменил другой сотрудник. Обновите страницу.'
        : `Не получилось: ${errorText(err)}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section class="yc-panel" aria-labelledby="block-title">
        <h2 id="block-title">Новая блокировка</h2>
        <form class="yc-form" novalidate onSubmit={submit}>
          <div class="yc-field">
            <label class="yc-field__label" for="block-type">Что блокировать</label>
            <select id="block-type" class="yc-input" value={type} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value as 'resources' | 'room')}>
              <option value="resources">Места</option>
              <option value="room">Комнату целиком (все её единицы)</option>
            </select>
          </div>
          {type === 'resources' ? (
            <fieldset class="yc-week">
              <legend class="yc-field__label">Места</legend>
              {resources.map((r) => (
                <label class="yc-check" key={r.id}>
                  <input type="checkbox" checked={ids.includes(r.id)}
                    onChange={(e) => setIds((e.currentTarget as HTMLInputElement).checked ? [...ids, r.id] : ids.filter((x) => x !== r.id))} />
                  {r.name}
                </label>
              ))}
            </fieldset>
          ) : (
            <div class="yc-field">
              <label class="yc-field__label" for="block-room">Комната</label>
              <select id="block-room" class="yc-input" value={roomId} onChange={(e) => setRoomId((e.currentTarget as HTMLSelectElement).value)}>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <div class="yc-field">
            <label class="yc-field__label" for="block-start">Начало</label>
            <input id="block-start" class="yc-input" type="datetime-local" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="block-end">Конец</label>
            <input id="block-end" class="yc-input" type="datetime-local" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="block-reason">Причина</label>
            <select id="block-reason" class="yc-input" value={reasonId} onChange={(e) => setReasonId((e.currentTarget as HTMLSelectElement).value)}>
              {reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="block-comment">Комментарий{reason?.requiresComment ? ' *' : ''}</label>
            <input id="block-comment" class="yc-input" value={comment} maxLength={2000} onInput={(e) => setComment((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <p class="yc-field__hint">Брони на это время не удаляются и не переносятся – после создания покажем список затронутых.</p>
          <div><button type="submit" class="yc-btn" disabled={busy}>Заблокировать</button></div>
          <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
        </form>
      </section>

      {created && (
        <section class="yc-panel" aria-labelledby="created-block-title" data-testid="block-created">
          <h2 id="created-block-title">Блокировка: {targetName(created.block)}</h2>
          <p>
            {fmt.format(new Date(created.block.start))} – {fmt.format(new Date(created.block.end))} ·{' '}
            {reasons.find((r) => r.id === created.block.reasonId)?.name ?? ''} ·{' '}
            <span class={`yc-badge yc-badge--${created.block.status === 'active' ? 'blocked' : 'archived'}`} data-testid="block-status">
              {created.block.status === 'active' ? 'Действует' : 'Снята'}
            </span>
          </p>
          {created.affected.length ? (
            <div data-testid="block-affected">
              <p><strong>Затронутые брони: {created.affected.length}.</strong> Они не удалены и не перенесены – решите каждую вручную.</p>
              <ul>{created.affected.map((id) => <li key={id}>{id}</li>)}</ul>
            </div>
          ) : (
            <p data-testid="block-affected">Броней на это время нет.</p>
          )}
          {created.block.status === 'active' && (
            <div><button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setLiftError(''); dialog.current?.showModal(); }}>Снять блокировку…</button></div>
          )}
        </section>
      )}

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="lift-title">
        <div class="yc-dialog__body">
          <h2 id="lift-title">Снять блокировку?</h2>
          <p>Места снова станут доступны для записи с этого момента. Запись о блокировке останется в истории.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="lift-comment">Комментарий</label>
            <input id="lift-comment" class="yc-input" value={liftComment} maxLength={2000} onInput={(e) => setLiftComment((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{liftError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn" disabled={busy} onClick={() => void lift()}>Снять</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

// Состав ресурса (S1-24, K6, resources/routes.ts): снимок «из каких единиц состоит место сейчас» и смена состава с даты.
// Составная конфигурация – например, VR-комната целиком = VR1 + VR2 + PS4. Перед сохранением – проверка (dryRun):
// список будущих броней на старом составе. Есть такие – сервер откажет (COMPOSITION_HAS_FUTURE_BOOKINGS): каждую бронь
// сотрудник решает вручную, автоматической отмены нет. Единица без своего места (PS4 в VR-комнате) добавляется здесь же.
import { useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

export interface UnitView { id: string; code: string; name: string; roomId: string | null; status: 'active' | 'archived' }

export interface CompositionProps {
  resourceId: string;
  branchId: string;
  roomId: string | null;
  units: UnitView[];
  current: string[];
  rooms: Array<{ id: string; name: string }>;
  canManage: boolean;
  archived: boolean;
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');
const pad = (n: number) => String(n).padStart(2, '0');
/** Значение datetime-local через 10 минут (время браузера). */
function soon(): string {
  const d = new Date(Date.now() + 10 * 60_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CompositionForm(props: CompositionProps) {
  const [units, setUnits] = useState(props.units);
  const [current, setCurrent] = useState(props.current);
  const [picked, setPicked] = useState<string[]>(props.current);
  const [from, setFrom] = useState(soon());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [affected, setAffected] = useState<string[] | null>(null);
  const [unitForm, setUnitForm] = useState({ code: '', name: '', roomId: props.roomId ?? props.rooms[0]?.id ?? '' });
  const [unitMsg, setUnitMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const label = (id: string) => {
    const u = units.find((x) => x.id === id);
    return u ? `${u.code} – ${u.name}` : id;
  };
  const active = units.filter((u) => u.status === 'active');

  const send = async (dryRun: boolean) => {
    setMsg(null);
    setAffected(null);
    if (picked.length === 0) {
      setMsg({ ok: false, text: 'Отметьте хотя бы одну единицу.' });
      return;
    }
    const at = new Date(from);
    if (Number.isNaN(at.getTime())) {
      setMsg({ ok: false, text: 'Укажите, с какого момента действует новый состав.' });
      return;
    }
    setBusy(true);
    try {
      const r = await browserCall<{ affectedBookingIds: string[]; affectedHoldIds: string[]; applied: boolean }>(
        `/resources/${encodeURIComponent(props.resourceId)}/composition`,
        { method: 'POST', body: { unitIds: picked, validFrom: at.toISOString(), ...(dryRun ? { dryRun: true } : {}) } },
      );
      const hit = [...r.affectedBookingIds, ...r.affectedHoldIds];
      if (dryRun) {
        setAffected(hit);
        setMsg(hit.length
          ? { ok: false, text: `На старом составе есть будущие брони (${hit.length}) – сохранить не получится, пока каждая не решена.` }
          : { ok: true, text: 'Будущих броней на старом составе нет – можно сохранять.' });
      } else if (r.applied) {
        setCurrent([...picked].sort());
        setMsg({ ok: true, text: `Состав сохранён, действует с ${at.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}.` });
      } else setMsg({ ok: true, text: 'Состав не изменился.' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COMPOSITION_HAS_FUTURE_BOOKINGS') {
        const ids = [...((e.details?.bookingIds as string[] | undefined) ?? []), ...((e.details?.holdIds as string[] | undefined) ?? [])];
        setAffected(ids);
        setMsg({ ok: false, text: 'Состав не изменён: у места есть будущие брони. Решите каждую (перенос или отмена) и повторите.' });
      } else setMsg({ ok: false, text: `Не получилось: ${errorText(e)}.` });
    } finally {
      setBusy(false);
    }
  };

  const addUnit = async (e: Event) => {
    e.preventDefault();
    setUnitMsg(null);
    if (!unitForm.code.trim() || !unitForm.name.trim() || !unitForm.roomId) {
      setUnitMsg({ ok: false, text: 'Заполните код, название и комнату.' });
      return;
    }
    setBusy(true);
    try {
      const u = await browserCall<UnitView>(`/branches/${encodeURIComponent(props.branchId)}/units`, {
        method: 'POST', body: { code: unitForm.code.trim(), name: unitForm.name.trim(), roomId: unitForm.roomId },
      });
      setUnits([...units, u]);
      setUnitForm({ ...unitForm, code: '', name: '' });
      setUnitMsg({ ok: true, text: `Единица ${u.code} добавлена – отметьте её в составе.` });
    } catch (err) {
      setUnitMsg({ ok: false, text: `Не добавлено: ${errorText(err)}.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="yc-panel" aria-labelledby="composition-title" data-testid="composition">
      <h2 id="composition-title">Состав места</h2>
      <p>Сейчас:</p>
      {current.length ? (
        <ul data-testid="composition-current">{current.map((id) => <li key={id}>{label(id)}</li>)}</ul>
      ) : (
        <p class="yc-empty" data-testid="composition-current">Состав не задан – место недоступно для записи.</p>
      )}

      {props.canManage && !props.archived && (
        <>
          <fieldset class="yc-week">
            <legend class="yc-field__label">Новый состав</legend>
            {active.map((u) => (
              <label class="yc-check" key={u.id}>
                <input type="checkbox" checked={picked.includes(u.id)}
                  onChange={(e) => setPicked((e.currentTarget as HTMLInputElement).checked ? [...picked, u.id] : picked.filter((x) => x !== u.id))} />
                {u.code} – {u.name}
              </label>
            ))}
          </fieldset>
          <div class="yc-field">
            <label class="yc-field__label" for="composition-from">Действует с</label>
            <input id="composition-from" class="yc-input" type="datetime-local" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
            <p class="yc-field__hint">Прошлое не переписывается: брони, уже созданные на старый состав, сохраняют свой снимок.</p>
          </div>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void send(true)}>Проверить брони</button>
            <button type="button" class="yc-btn" disabled={busy} onClick={() => void send(false)}>Сохранить состав</button>
          </div>
        </>
      )}
      <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
      {affected && affected.length > 0 && (
        <div data-testid="composition-affected">
          <p>Затронутые брони:</p>
          <ul>{affected.map((id) => <li key={id}>{id}</li>)}</ul>
        </div>
      )}

      {props.canManage && !props.archived && props.rooms.length > 0 && (
        <form class="yc-form" onSubmit={addUnit} novalidate>
          <h3>Единица без своего места</h3>
          <p class="yc-field__hint">Например, PS4 в VR-комнате: её нельзя забронировать отдельно, но она входит в аренду комнаты.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="unit-code">Код</label>
            <input id="unit-code" class="yc-input" value={unitForm.code} onInput={(e) => setUnitForm({ ...unitForm, code: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="unit-name">Название</label>
            <input id="unit-name" class="yc-input" value={unitForm.name} onInput={(e) => setUnitForm({ ...unitForm, name: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="unit-room">Комната</label>
            <select id="unit-room" class="yc-input" value={unitForm.roomId} onChange={(e) => setUnitForm({ ...unitForm, roomId: (e.currentTarget as HTMLSelectElement).value })}>
              {props.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div><button type="submit" class="yc-btn yc-btn--ghost" disabled={busy}>Добавить единицу</button></div>
          <p class={`yc-alert ${unitMsg ? (unitMsg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{unitMsg?.text ?? ''}</p>
        </form>
      )}
    </section>
  );
}

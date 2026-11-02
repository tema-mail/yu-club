// Карточка брони (S1-23, K11 №5–12): данные, посещение, отмена, версии и хронология. Кнопки – только из
// allowedActions сервера (статус, время, права на филиал брони). Отмена, неявка и исправление – через окно внутри
// записи с «было → станет»; комментарий отмены и причина исправления обязательны. Устаревшая карточка (409 по
// rowVersion) – понятное сообщение и перечитывание карточки. Двойной клик – одна операция (кнопки заняты до ответа).
// S2-63: блок «Оплата» (PaymentPanel) под данными записи; перечитывается при смене статуса (пришёл – можно платить).
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  STATUS_LABEL, bookingApi, bookingError, fmtRange, fmtRub, inZone, isConflict, type BookingCard as Card, type CrmBooking, type TimelineEvent,
} from '../lib/booking.ts';
import PaymentPanel from './PaymentPanel.tsx';
import RescheduleDialog from './RescheduleDialog.tsx';

export interface Reason { id: string; name: string; domain: string }
export interface BookingCardProps {
  initial: Card;
  reasons: Reason[];
  canComment: boolean;
}

type DialogKind = 'cancel' | 'no_show' | 'revert_visit' | 'reschedule';
const EVENT_LABEL: Record<string, string> = {
  'booking.confirmed': 'Запись создана',
  'booking.cancelled': 'Запись отменена',
  'booking.rescheduled': 'Запись перенесена',
  'booking.updated': 'Изменён служебный комментарий',
  'visit.confirmed': 'Отмечен приход',
  'visit.completed': 'Сеанс завершён',
  'no_show.marked': 'Отмечена неявка',
  'visit.reverted': 'Отметка прихода исправлена',
  'no_show.reverted': 'Отметка неявки исправлена',
};
const ACTOR: Record<string, string> = { owner: 'Владелец', director: 'Директор', admin: 'Администратор' };
const actorOf = (e: TimelineEvent) => (e.actorType === 'staff' ? (e.actorRole ? ACTOR[e.actorRole] ?? 'Сотрудник' : 'Сотрудник') : e.actorType === 'client' ? 'Клиент' : 'Система');
const SOURCE = { site: 'Сайт', crm: 'CRM' } as const;
/** booking.created пишут и сайт, и CRM – источник в after.source; у старых записей его нет. */
const CREATED_AT: Record<string, string> = { site: 'Запись создана на сайте', crm: 'Запись создана в CRM' };
const labelOf = (e: TimelineEvent) => {
  if (e.action !== 'booking.created') return EVENT_LABEL[e.action] ?? e.action;
  const src = (e.after as { source?: unknown } | null)?.source;
  return (typeof src === 'string' && CREATED_AT[src]) || 'Запись создана';
};

export default function BookingCard({ initial, reasons, canComment }: BookingCardProps) {
  const [b, setB] = useState<Card>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [kind, setKind] = useState<DialogKind | null>(null);
  const [dlgError, setDlgError] = useState('');
  const [initiator, setInitiator] = useState<'club' | 'client_by_phone'>('club');
  const [reasonId, setReasonId] = useState('');
  const [text, setText] = useState('');
  const [comment, setComment] = useState(initial.internalComment ?? '');
  const dialog = useRef<HTMLDialogElement>(null);
  const tz = b.timezone;
  const at = (iso: string) => fmtRange(iso, iso, tz).split('–')[0]; // «03.11, 12:00»
  const can = (a: CrmBooking['allowedActions'][number]) => b.allowedActions.includes(a);
  const domainReasons = (d: string) => reasons.filter((r) => r.domain === d);
  const cancelDomain = initiator === 'club' ? 'booking_cancel_club' : 'booking_cancel_client';

  const reload = async () => {
    try {
      const fresh = await bookingApi.card(b.id);
      setB(fresh);
      setComment(fresh.internalComment ?? '');
    } catch (e) {
      setNotice({ ok: false, text: `Не удалось обновить карточку: ${bookingError(e)}` });
    }
  };

  /** Команда: занято до ответа; успех – карточка с хронологией; 409 по версии – сообщение и перечитывание. */
  const run = async (op: () => Promise<CrmBooking>, ok: string, inDialog = false): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    setDlgError('');
    try {
      await op();
      await reload();
      setNotice({ ok: true, text: ok });
      return true;
    } catch (e) {
      if (isConflict(e)) {
        await reload();
        dialog.current?.close();
        setKind(null);
        setNotice({ ok: false, text: bookingError(e) });
      } else if (inDialog) setDlgError(bookingError(e));
      else setNotice({ ok: false, text: bookingError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openDialog = (k: DialogKind) => {
    setKind(k);
    setDlgError('');
    setText('');
    setInitiator('club');
    setReasonId(k === 'cancel' ? (domainReasons('booking_cancel_club')[0]?.id ?? '') : '');
    dialog.current?.showModal();
  };
  const closeDialog = () => {
    dialog.current?.close();
    setKind(null);
  };

  const confirmDialog = async (e: Event) => {
    e.preventDefault();
    let done = false;
    if (kind === 'cancel') {
      if (!reasonId) return setDlgError('Выберите причину отмены.');
      if (!text.trim()) return setDlgError('Укажите комментарий – без него отмену не сохранить.');
      done = await run(() => bookingApi.cancel(b.id, { rowVersion: b.rowVersion, initiator, reasonId, comment: text.trim() }), 'Запись отменена.', true);
    } else if (kind === 'no_show') {
      done = await run(() => bookingApi.noShow(b.id, b.rowVersion, reasonId || undefined), 'Отмечена неявка.', true);
    } else if (kind === 'revert_visit') {
      if (!text.trim()) return setDlgError('Укажите причину исправления.');
      done = await run(() => bookingApi.revertVisit(b.id, b.rowVersion, text.trim()), 'Отметка исправлена – запись снова подтверждена.', true);
    }
    if (done) closeDialog();
  };

  const saveComment = (e: Event) => {
    e.preventDefault();
    void run(() => bookingApi.comment(b.id, b.rowVersion, comment.trim() || null), 'Комментарий сохранён.');
  };

  const now = `${STATUS_LABEL[b.status]} · ${b.resourceName}, ${fmtRange(b.start, b.end, tz)}`;
  const after: Partial<Record<DialogKind, string>> = {
    cancel: `${initiator === 'club' ? STATUS_LABEL.cancelled_by_club : STATUS_LABEL.cancelled_by_client} · время освободится для записи`,
    no_show: `${STATUS_LABEL.no_show} · посещение не создаётся`,
    revert_visit: `${STATUS_LABEL.confirmed} · отметка «${b.status === 'no_show' ? 'неявка' : 'пришёл'}» снимается`,
  };
  const title: Record<DialogKind, string> = { cancel: 'Отменить запись?', no_show: 'Отметить неявку?', revert_visit: 'Исправить отметку?', reschedule: 'Перенести запись' };
  // Q-101: до окна прихода сервер не даёт arrive, но присылает arriveFrom – кнопка видна неактивной с подсказкой
  const arriveLater = !can('arrive') && b.arriveFrom !== null;
  const arriveFromText = b.arriveFrom
    ? inZone(b.arriveFrom, tz).date === inZone(Date.now(), tz).date ? inZone(b.arriveFrom, tz).hm : at(b.arriveFrom)
    : '';
  useEffect(() => {
    if (!arriveLater || !b.arriveFrom) return;
    const wait = Date.parse(b.arriveFrom) - Date.now() + 1000;
    if (wait > 6 * 3600_000) return; // далёкое окно – откроется при следующем входе в карточку
    const t = setTimeout(() => void reload(), Math.max(wait, 0));
    return () => clearTimeout(t);
  }, [arriveLater, b.arriveFrom]);
  const minutes = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000);

  return (
    <>
      <div class="yc-head">
        <p class="yc-crumbs"><a href={`/schedule?branch=${encodeURIComponent(b.branchId)}&date=${inZone(b.start, tz).date}`}>Расписание</a> / Запись №{b.number}</p>
        <h1>Запись №{b.number}</h1>
        <p>
          <span class={`yc-badge yc-badge--bk-${b.status}`} data-testid="booking-status">{STATUS_LABEL[b.status]}</span>
          {b.needsDecision && <span class="yc-badge yc-badge--decide yc-badge--system">Требует решения: отметьте приход или неявку</span>}
        </p>
      </div>
      <p class={`yc-alert ${notice ? (notice.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="booking-notice">{notice?.text ?? ''}</p>

      {(b.allowedActions.length > 0 || arriveLater) && (
        <section class="yc-panel yc-bk__actions" aria-label="Действия" data-testid="booking-actions">
          {can('arrive') && <button type="button" class="yc-btn" disabled={busy} onClick={() => void run(() => bookingApi.arrive(b.id, b.rowVersion), 'Приход отмечен.')}>Отметить приход</button>}
          {arriveLater && (
            <span>
              <button type="button" class="yc-btn" disabled aria-describedby="bk-arrive-hint">Отметить приход</button>{' '}
              <span id="bk-arrive-hint" class="yc-field__hint" data-testid="arrive-hint">Можно отметить с {arriveFromText}</span>
            </span>
          )}
          {can('complete') && <button type="button" class="yc-btn" disabled={busy} onClick={() => void run(() => bookingApi.complete(b.id, b.rowVersion), 'Сеанс завершён.')}>Завершить сеанс</button>}
          {can('no_show') && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => openDialog('no_show')}>Неявка…</button>}
          {can('revert_visit') && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => openDialog('revert_visit')}>Исправить отметку…</button>}
          {can('reschedule') && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => openDialog('reschedule')}>Перенести…</button>}
          {can('cancel') && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={() => openDialog('cancel')}>Отменить запись…</button>}
        </section>
      )}

      <section class="yc-panel" aria-labelledby="bk-props">
        <h2 id="bk-props">Запись</h2>
        <dl class="yc-props" data-testid="booking-props">
          <dt>Клиент</dt>
          <dd>
            <a href={`/clients/${encodeURIComponent(b.client.id)}`}>{b.client.name ?? 'Без имени'}</a> {b.client.phoneMasked}
            {b.client.isGuest && <span class="yc-badge yc-badge--system">без профиля</span>}
          </dd>
          <dt>Место</dt><dd>{b.resourceName}</dd>
          <dt>Время</dt><dd data-testid="booking-time">{fmtRange(b.start, b.end, tz)} <span class="yc-field__hint">({minutes} мин, время филиала)</span></dd>
          <dt>Стоимость</dt><dd>{fmtRub(b.priceKop)}</dd>
          <dt>Источник</dt><dd>{SOURCE[b.source]}</dd>
          {b.visit && (
            <>
              <dt>Посещение</dt>
              <dd data-testid="booking-visit">пришёл в {inZone(b.visit.arrivedAt, tz).hm}{b.visit.completedAt ? `, завершено в ${inZone(b.visit.completedAt, tz).hm}` : ''}</dd>
            </>
          )}
          {b.cancel && (
            <>
              <dt>Отмена</dt>
              <dd data-testid="booking-cancel">{at(b.cancel.at)} · {b.cancel.by}{b.cancel.reasonName ? ` · ${b.cancel.reasonName}` : ''}{b.cancel.comment ? ` · «${b.cancel.comment}»` : ''}</dd>
            </>
          )}
        </dl>
        {canComment ? (
          <form class="yc-form yc-form--wide" onSubmit={saveComment}>
            <div class="yc-field">
              <label class="yc-field__label" for="bk-comment">Служебный комментарий</label>
              <input id="bk-comment" class="yc-input" maxLength={1000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLInputElement).value)} />
            </div>
            {comment.trim() !== (b.internalComment ?? '') && <div><button type="submit" class="yc-btn yc-btn--ghost" disabled={busy}>Сохранить комментарий</button></div>}
          </form>
        ) : b.internalComment && <p>Комментарий: {b.internalComment}</p>}
      </section>

      <PaymentPanel bookingId={b.id} branchId={b.branchId} timezone={tz} status={b.status} />

      {b.versions.length > 1 && (
        <section class="yc-panel" aria-labelledby="bk-versions">
          <h2 id="bk-versions">Версии</h2>
          <ol class="yc-history" data-testid="booking-versions">
            {[...b.versions].reverse().map((v) => (
              <li class="yc-history__item" key={v.version}>
                <span class="yc-history__head">
                  <strong>Версия {v.version}{v.version === b.currentVersion ? ' (текущая)' : ''}</strong>: {v.resourceName}, {fmtRange(v.start, v.end, tz)} · {fmtRub(v.priceKop)}
                </span>
                <span class="yc-field__hint">создана {at(v.createdAt)}{v.reason ? ` · причина: ${v.reason}` : ''}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section class="yc-panel" aria-labelledby="bk-timeline">
        <h2 id="bk-timeline">Хронология</h2>
        {b.timeline.length === 0 ? <p class="yc-empty">Событий пока нет.</p> : (
          <ol class="yc-history" data-testid="booking-timeline">
            {[...b.timeline].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).map((e) => (
              <li class="yc-history__item" key={e.id}>
                <span class="yc-history__head"><strong>{labelOf(e)}</strong> · {at(e.at)} · {actorOf(e)}</span>
                {e.reason && <span class="yc-field__hint">Причина: {e.reason}</span>}
                {e.action === 'booking.rescheduled' && <Moved e={e} tz={tz} />}
              </li>
            ))}
          </ol>
        )}
      </section>

      <dialog ref={dialog} class={`yc-dialog${kind === 'reschedule' ? ' yc-dialog--wide' : ''}`} aria-labelledby="bk-dialog-title" onClose={() => setKind(null)}>
        {kind === 'reschedule' ? (
          <RescheduleDialog booking={b} busy={busy} error={dlgError} onCancel={closeDialog}
            onSubmit={async (body) => (await run(() => bookingApi.reschedule(b.id, { rowVersion: b.rowVersion, ...body }), 'Запись перенесена.', true)) && closeDialog()} />
        ) : kind && (
          <form class="yc-dialog__body" novalidate onSubmit={confirmDialog}>
            <h2 id="bk-dialog-title">{title[kind]}</h2>
            <BeforeAfter before={now} after={after[kind]!} />
            {kind === 'cancel' && (
              <>
                <fieldset class="yc-week">
                  <legend class="yc-field__label">Кто отменяет</legend>
                  <label class="yc-check"><input type="radio" name="init" checked={initiator === 'club'} onChange={() => (setInitiator('club'), setReasonId(domainReasons('booking_cancel_club')[0]?.id ?? ''))} />Клуб</label>
                  <label class="yc-check"><input type="radio" name="init" checked={initiator === 'client_by_phone'} onChange={() => (setInitiator('client_by_phone'), setReasonId(domainReasons('booking_cancel_client')[0]?.id ?? ''))} />Клиент по телефону</label>
                </fieldset>
                <Field id="bk-reason" label="Причина *">
                  <select id="bk-reason" class="yc-input" value={reasonId} onChange={(e) => setReasonId((e.currentTarget as HTMLSelectElement).value)}>
                    {domainReasons(cancelDomain).map((r) => <option value={r.id} key={r.id}>{r.name}</option>)}
                  </select>
                </Field>
              </>
            )}
            {kind === 'no_show' && domainReasons('no_show').length > 0 && (
              <Field id="bk-reason" label="Причина (необязательно)">
                <select id="bk-reason" class="yc-input" value={reasonId} onChange={(e) => setReasonId((e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">Без причины</option>
                  {domainReasons('no_show').map((r) => <option value={r.id} key={r.id}>{r.name}</option>)}
                </select>
              </Field>
            )}
            {(kind === 'cancel' || kind === 'revert_visit') && (
              <Field id="bk-text" label={kind === 'cancel' ? 'Комментарий *' : 'Причина исправления *'}>
                <textarea id="bk-text" class="yc-input" rows={3} maxLength={1000} value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
              </Field>
            )}
            <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={closeDialog}>Не менять</button>
              <button type="submit" class={`yc-btn${kind === 'cancel' ? ' yc-btn--danger' : ''}`} disabled={busy}>
                {kind === 'cancel' ? 'Отменить запись' : kind === 'no_show' ? 'Отметить неявку' : 'Исправить'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

export function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <dl class="yc-props yc-bk__diff" data-testid="before-after">
      <dt>Было</dt><dd>{before}</dd>
      <dt>Станет</dt><dd><strong>{after}</strong></dd>
    </dl>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ComponentChildren }) {
  return (
    <div class="yc-field">
      <label class="yc-field__label" for={id}>{label}</label>
      {children}
    </div>
  );
}

function Moved({ e, tz }: { e: TimelineEvent; tz: string }) {
  const b = (e.before ?? {}) as { start?: string; end?: string };
  const a = (e.after ?? {}) as { start?: string; end?: string; resourceName?: string };
  if (!b.start || !b.end || !a.start || !a.end) return null;
  return <span class="yc-field__hint">{fmtRange(b.start, b.end, tz)} → {a.resourceName ? `${a.resourceName}, ` : ''}{fmtRange(a.start, a.end, tz)}</span>;
}


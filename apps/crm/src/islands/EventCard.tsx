// Карточка мероприятия (S3-81, K20 №362–363, 11 §11.2–11.3): вверху дата, филиал, статус, заказчик и финсводка отдельными показателями,
// ниже 9 вкладок. Показатели плана и результата – только когда сервер их отдал (event.money.view); без права в карточке один остаток к оплате.
// Статус – по таблице переходов K20 §2; отмена и «не состоялось» – окном внутри записи с причиной и списком «требует решения»: система связанное
// не трогает (11 §10). Время – по зоне филиала мероприятия. Вкладка – в адресе (#money), перечитывание карточки её не сбрасывает.
import { useEffect, useState } from 'preact/hooks';
import { browserCall, ROLE_LABEL, type StaffRole } from '../lib/api.ts';
import { inZone } from '../lib/booking.ts';
import {
  EVENT_BADGE, EVENT_STATUS, PARTY_FORMAT, TRANSITIONS, atText, eventError, fullMoney, isClosed, periodText, toIso,
  type EventCardDto, type EventDto, type EventStatus, type PartyFormat, type TimelineItem,
} from '../lib/events.ts';
import { rub } from './CashJournal.tsx';
import EventChecklist from './EventChecklist.tsx';
import { ClientPicker, type PickedClient } from './EventForm.tsx';
import EventLines from './EventLines.tsx';
import { ReasonDialog, type EventTabProps } from './EventParts.tsx';
import EventResources from './EventResources.tsx';

export interface EventCardProps {
  initial: EventCardDto;
  typeName: string;
  branchName: string;
  branches: Array<{ id: string; name: string; cityId: string }>;
  actions: string[];
  staff: Array<{ id: string; name: string }>;
  minMinutes: number;
  maxGuests: number;
}

const TABS = [
  ['main', 'Основное'], ['people', 'Заказчик и участники'], ['lines', 'Состав и пакет'], ['resources', 'Брони и ресурсы'], ['checklist', 'Чек-лист'],
  ['income', 'Поступления'], ['expenses', 'Расходы и себестоимость'], ['gifts', 'Подарки'], ['history', 'История'],
] as const;
type Tab = (typeof TABS)[number][0];
const NEXT_LABEL: Partial<Record<EventStatus, string>> = {
  negotiation: 'На согласование', awaiting_confirmation: 'Ждёт подтверждения', confirmed: 'Подтвердить', preparing: 'В подготовку', in_progress: 'Началось', completed: 'Завершить', cancelled: 'Отменить…', not_held: 'Не состоялось…',
};
const ACTION_LABEL: Record<string, string> = {
  'event.created': 'Создано', 'event.updated': 'Изменены данные', 'event.status_changed': 'Смена статуса', 'event.rescheduled': 'Перенос', 'event.line_added': 'Добавлена строка состава',
  'event.line_updated': 'Изменена строка состава', 'event.line_removed': 'Удалена строка состава', 'event.package_applied': 'Применён пакет', 'event.resource_reserved': 'Занят ресурс',
  'event.resource_released': 'Освобождён ресурс', 'event.booking_linked': 'Связана бронь', 'event.booking_unlinked': 'Снята связь с бронью', 'event.checklist_changed': 'Изменён чек-лист', 'event.money_linked': 'Привязан расход',
};

function TimelineView(p: { items: TimelineItem[]; tz: string; staff: EventCardProps['staff']; hasDiff: boolean }) {
  const who = (t: TimelineItem) => (t.actorType === 'staff' ? (p.staff.find((s) => s.id === t.actorId)?.name ?? (t.actorRole && ROLE_LABEL[t.actorRole as StaffRole]) ?? 'Сотрудник') : t.actorType === 'client' ? 'Клиент' : 'Система');
  const status = (v: unknown) => EVENT_STATUS[v as EventStatus] ?? String(v);
  const change = (t: TimelineItem) => {
    if (t.action === 'event.status_changed' && t.before && t.after) return `${status(t.before.status)} → ${status(t.after.status)}`;
    if (t.action === 'event.line_removed' || t.action === 'event.line_added') return (t.after?.name as string | undefined) ?? '';
    return '';
  };
  if (p.items.length === 0) return <p class="yc-empty">Записей пока нет.</p>;
  return (
    <>
      {!p.hasDiff && <p class="yc-field__hint">Подробности изменений видят Директор и Владелец.</p>}
      <ul class="yc-history" data-testid="event-timeline">
        {p.items.map((t) => (
          <li class="yc-history__item" key={t.id}>
            <span class="yc-history__head">{atText(t.at, p.tz)} · {who(t)}</span>
            <span>{ACTION_LABEL[t.action] ?? t.action}{change(t) ? `: ${change(t)}` : ''}</span>
            {t.reason && <span>Причина: {t.reason}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Вкладки 1–2: только изменённые поля + rowVersion; при занятых ресурсах дату меняет перенос. */
function MainTab(p: EventTabProps) {
  const c = p.card;
  const tz = c.timezone;
  const startL = c.plannedStart ? inZone(c.plannedStart, tz) : null;
  const endL = c.plannedEnd ? inZone(c.plannedEnd, tz) : null;
  const [title, setTitle] = useState(c.title);
  const [date, setDate] = useState(startL?.date ?? '');
  const [from, setFrom] = useState(startL?.hm ?? '');
  const [to, setTo] = useState(endL?.hm ?? '');
  const [responsible, setResponsible] = useState(c.responsibleStaffId ?? '');
  const [wishes, setWishes] = useState(c.wishes ?? '');
  const [format, setFormat] = useState<PartyFormat>(c.party?.format ?? 'h2');
  const [catering, setCatering] = useState(c.party?.catering ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = c.resources.some((r) => r.status === 'active');
  const closed = isClosed(c.status);
  const canEdit = p.actions.includes('event.manage') && !closed;
  const isParty = c.typeCode === 'birthday_party';
  const responsibleName = p.staff.find((s) => s.id === c.responsibleStaffId)?.name ?? (c.responsibleStaffId ? 'Назначен' : 'Не назначен');
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) return setError('Укажите название.');
    if ((date || from || to) && !(date && from && to)) return setError('Дата, начало и конец заполняются вместе.');
    if (date && to <= from) return setError('Конец должен быть позже начала.');
    const body: Record<string, unknown> = { rowVersion: c.rowVersion };
    if (title.trim() !== c.title) body.title = title.trim();
    const ps = toIso(date, from, tz);
    const pe = toIso(date, to, tz);
    if (!locked && ps !== (c.plannedStart && new Date(c.plannedStart).toISOString())) body.plannedStart = ps;
    if (!locked && pe !== (c.plannedEnd && new Date(c.plannedEnd).toISOString())) body.plannedEnd = pe;
    if (responsible !== (c.responsibleStaffId ?? '')) body.responsibleStaffId = responsible || null;
    if (wishes.trim() !== (c.wishes ?? '')) body.wishes = wishes.trim() || null;
    if (isParty && (format !== c.party?.format || catering !== c.party?.catering)) body.party = { format, guests: c.party?.guests ?? c.participantsCount ?? 1, catering };
    if (Object.keys(body).length === 1) return setError('Изменений нет.');
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}`, { method: 'PATCH', body });
      await p.onChanged('Данные сохранены.');
    } catch (err) {
      await p.onChanged().catch(() => undefined);
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <dl class="yc-props">
        <dt>Источник</dt><dd>{c.source === 'site' ? 'Заявка с сайта' : 'CRM'}</dd>
        <dt>Ответственный</dt><dd data-testid="event-responsible">{responsibleName}</dd>
        {c.party && <><dt>Праздник</dt><dd>{PARTY_FORMAT[c.party.format]}, гостей: {c.party.guests}{c.party.catering ? ', праздничный стол' : ''}</dd></>}
        {c.cancel && <><dt>Причина отмены</dt><dd data-testid="event-cancel-reason">{c.cancel.reason} ({atText(c.cancel.at, tz)})</dd></>}
      </dl>
      {closed && <p class="yc-field__hint">Мероприятие завершено: оргданные не меняются. Поздняя оплата и расходы по счёту подрядчика – на вкладках денег.</p>}
      {canEdit && (
        <form class="yc-form yc-form--wide" novalidate onSubmit={submit} data-testid="event-main-form">
          <label class="yc-field"><span class="yc-field__label">Название</span><input class="yc-input" type="text" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
          {locked && <p class="yc-field__hint">Ресурсы заняты: дату меняет перенос на вкладке «Брони и ресурсы».</p>}
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Дата</span><input class="yc-input" type="date" value={date} disabled={locked} onInput={(e) => setDate(e.currentTarget.value)} /></label>
            <div class="yc-ev__row">
              <label class="yc-field"><span class="yc-field__label">Начало</span><input class="yc-input" type="time" value={from} disabled={locked} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Конец</span><input class="yc-input" type="time" value={to} disabled={locked} onInput={(e) => setTo(e.currentTarget.value)} /></label>
            </div>
          </div>
          {p.staff.length > 0 && (
            <label class="yc-field"><span class="yc-field__label">Ответственный</span>
              <select class="yc-input" value={responsible} onChange={(e) => setResponsible(e.currentTarget.value)}><option value="">Не назначен</option>{p.staff.map((s) => <option value={s.id}>{s.name}</option>)}</select></label>
          )}
          {isParty && (
            <div class="yc-ev__grid">
              <label class="yc-field"><span class="yc-field__label">Формат праздника</span>
                <select class="yc-input" value={format} onChange={(e) => setFormat(e.currentTarget.value as PartyFormat)}>{(Object.keys(PARTY_FORMAT) as PartyFormat[]).map((f) => <option value={f}>{PARTY_FORMAT[f]}</option>)}</select></label>
              <label class="yc-check"><input type="checkbox" checked={catering} onChange={(e) => setCatering(e.currentTarget.checked)} /> Праздничный стол</label>
            </div>
          )}
          <label class="yc-field"><span class="yc-field__label">Пожелания</span><textarea class="yc-input" rows={3} maxLength={4000} value={wishes} onInput={(e) => setWishes(e.currentTarget.value)} /></label>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div><button class="yc-btn" type="submit" disabled={busy}>Сохранить</button></div>
        </form>
      )}
    </>
  );
}

function PeopleTab(p: EventTabProps & { maxGuests: number }) {
  const c = p.card;
  const [name, setName] = useState(c.customer.name);
  const [phone, setPhone] = useState('');
  const [client, setClient] = useState<PickedClient | null>(c.customer.clientId ? { id: c.customer.clientId, name: c.customer.name } : null);
  const [hero, setHero] = useState(c.birthdayPerson.name ?? '');
  const [heroClient, setHeroClient] = useState<PickedClient | null>(c.birthdayPerson.clientId ? { id: c.birthdayPerson.clientId, name: c.birthdayPerson.name ?? 'Карточка клиента' } : null);
  const [count, setCount] = useState(c.participantsCount === null ? '' : String(c.participantsCount));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = p.actions.includes('event.manage') && !isClosed(c.status);
  const isBirthday = c.typeCode === 'birthday_party' || c.typeCode === 'birthday';
  const isParty = c.typeCode === 'birthday_party';
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Укажите имя заказчика.');
    if (phone && phone.replace(/\D/g, '').length < 10) return setError('Телефон – 10 цифр и код страны. Оставьте пустым, чтобы не менять.');
    const guests = count ? Number(count) : null;
    if (count && (!Number.isInteger(guests) || guests! < 1)) return setError('Количество участников – целое число больше нуля.');
    if (isParty && guests !== null && guests > p.maxGuests) return setError(`На платном празднике – не больше ${p.maxGuests} гостей.`);
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}`, {
        method: 'PATCH',
        body: {
          rowVersion: c.rowVersion, customer: { clientId: client?.id ?? null, name: name.trim(), ...(phone ? { phone } : {}) },
          ...(isBirthday ? { birthdayPerson: { clientId: heroClient?.id ?? null, name: hero.trim() || null } } : {}),
          participantsCount: guests,
          ...(isParty && c.party && guests !== null && guests !== c.party.guests ? { party: { ...c.party, guests } } : {}),
        },
      });
      await p.onChanged('Заказчик и участники сохранены.');
    } catch (err) {
      await p.onChanged().catch(() => undefined);
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <dl class="yc-props">
        <dt>Заказчик</dt><dd>{c.customer.clientId ? <a href={`/clients/${c.customer.clientId}`}>{c.customer.name}</a> : `${c.customer.name} (без профиля)`}</dd>
        <dt>Телефон</dt><dd data-testid="event-phone">{c.customer.phoneMasked}</dd>
        {isBirthday && <><dt>Именинник</dt><dd>{c.birthdayPerson.clientId ? <a href={`/clients/${c.birthdayPerson.clientId}`}>{c.birthdayPerson.name ?? 'Карточка клиента'}</a> : (c.birthdayPerson.name ?? 'не указан')}</dd></>}
        <dt>Участников</dt><dd>{c.participantsCount ?? 'не указано'}</dd>
      </dl>
      {canEdit && (
        <form class="yc-form yc-form--wide" novalidate onSubmit={submit} data-testid="event-people-form">
          <label class="yc-field"><span class="yc-field__label">Заказчик: имя</span><input class="yc-input" type="text" maxLength={200} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label class="yc-field"><span class="yc-field__label">Заказчик: новый телефон</span><input class="yc-input" type="tel" autoComplete="off" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /><span class="yc-field__hint">Пусто – телефон не меняется.</span></label>
          <ClientPicker label="Профиль заказчика" value={client} onChange={setClient} testId="pick-customer-edit" />
          {isBirthday && (
            <>
              <label class="yc-field"><span class="yc-field__label">Именинник: имя</span><input class="yc-input" type="text" maxLength={200} value={hero} onInput={(e) => setHero(e.currentTarget.value)} /></label>
              <ClientPicker label="Профиль именинника (нужен для подарка)" value={heroClient} onChange={setHeroClient} testId="pick-hero-edit" />
            </>
          )}
          <label class="yc-field"><span class="yc-field__label">{isParty ? `Гостей (1–${p.maxGuests})` : 'Участников'}</span><input class="yc-input" type="number" min={1} inputMode="numeric" value={count} onInput={(e) => setCount(e.currentTarget.value)} /></label>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div><button class="yc-btn" type="submit" disabled={busy}>Сохранить</button></div>
        </form>
      )}
    </>
  );
}

export default function EventCard(p: EventCardProps) {
  const [c, setC] = useState<EventCardDto>(p.initial);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('main');
  const [closing, setClosing] = useState<'cancelled' | 'not_held' | null>(null);
  const [decision, setDecision] = useState<{ bookingIds: string[]; giftIds: string[]; dueKop: number; receivedKop?: number } | null>(null);
  const can = (a: string) => p.actions.includes(a);
  const m = c.money;
  const tz = c.timezone;

  useEffect(() => {
    const h = location.hash.slice(1) as Tab;
    if (TABS.some(([k]) => k === h)) setTab(h);
  }, []);
  const show = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };
  const reload = async () => setC(await browserCall<EventCardDto>(`/events/${c.id}`));
  const onChanged = async (text?: string) => {
    await reload();
    setNotice(text ?? '');
    setError('');
  };
  const go = async (to: EventStatus) => {
    if (busy) return;
    if (to === 'cancelled' || to === 'not_held') return setClosing(to);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await browserCall(`/events/${c.id}/status`, { method: 'POST', body: { rowVersion: c.rowVersion, to } });
      await onChanged(`Статус: ${EVENT_STATUS[to]}.`);
    } catch (err) {
      await reload().catch(() => undefined);
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  const close = async (reason: string, key: string) => {
    const r = await browserCall<{ event: EventDto; needsDecision: NonNullable<typeof decision> | null }>(`/events/${c.id}/status`, { method: 'POST', key, body: { rowVersion: c.rowVersion, to: closing, reason } });
    setClosing(null);
    setDecision(r.needsDecision);
    await onChanged(`Статус: ${EVENT_STATUS[r.event.status]}. Занятые ресурсы освобождены.`);
  };
  const tabProps: EventTabProps = { card: c, actions: p.actions, staff: p.staff, onChanged };
  const next = can('event.manage') ? TRANSITIONS[c.status] : [];

  return (
    <>
      <section class="yc-panel yc-ev__top" aria-label="Главное">
        <div class="yc-ev__headline">
          <p class="yc-ev__number" data-testid="event-number">{c.number}</p>
          <span class={`yc-badge yc-badge--${EVENT_BADGE[c.status]}`} data-testid="event-status">{EVENT_STATUS[c.status]}</span>
        </div>
        <dl class="yc-props yc-ev__facts">
          <div><dt>Название</dt><dd>{c.title}</dd></div>
          <div><dt>Тип</dt><dd>{p.typeName}</dd></div>
          <div><dt>Дата и время (филиала)</dt><dd data-testid="event-when">{periodText(c.plannedStart, c.plannedEnd, tz)}</dd></div>
          <div><dt>Филиал</dt><dd>{p.branchName}</dd></div>
          <div><dt>Заказчик</dt><dd>{c.customer.name}, {c.customer.phoneMasked}</dd></div>
        </dl>
        {fullMoney(m) ? (
          <dl class="yc-ev__sum" data-testid="event-summary">
            <div><dt>Согласованная стоимость</dt><dd data-testid="sum-agreed">{rub(m.agreedKop)}</dd></div>
            <div><dt>Фактически получено</dt><dd data-testid="sum-received">{rub(m.receivedKop)}</dd></div>
            <div><dt>Возвраты</dt><dd data-testid="sum-refunded">{rub(m.refundedKop)}</dd></div>
            <div><dt>{m.dueKop < 0 ? 'Переплата' : 'Остаток к оплате'}</dt><dd data-testid="sum-due">{rub(Math.abs(m.dueKop))}</dd></div>
            <div><dt>Плановая себестоимость</dt><dd data-testid="sum-plan">{rub(m.planCostKop)}</dd></div>
            <div><dt>Фактическая себестоимость</dt><dd data-testid="sum-fact">{rub(m.factCostKop)}</dd></div>
            <div><dt>Финансовый результат</dt><dd data-testid="sum-result">{rub(m.resultKop)}</dd></div>
            <div><dt>{m.deviationKop > 0 ? 'Перерасход к плану' : 'Отклонение от плана'}</dt><dd data-testid="sum-deviation">{rub(m.deviationKop, true)}</dd></div>
            <div><dt>Скидки (не в результате)</dt><dd>{rub(m.discountsKop)}</dd></div>
            <div><dt>Подарков выдано</dt><dd>{m.giftsIssued}</dd></div>
          </dl>
        ) : (
          <dl class="yc-ev__sum" data-testid="event-summary">
            <div><dt>{m.dueKop < 0 ? 'Переплата' : 'Остаток к оплате'}</dt><dd data-testid="sum-due">{rub(Math.abs(m.dueKop))}</dd></div>
          </dl>
        )}
        {next.length > 0 && (
          <div class="yc-tabs" data-testid="event-actions">
            {next.map((s) => <button key={s} class={`yc-btn${s === 'cancelled' || s === 'not_held' ? ' yc-btn--ghost' : ''}`} type="button" disabled={busy} onClick={() => go(s)}>{NEXT_LABEL[s]}</button>)}
          </div>
        )}
        {c.status === 'new_request' && c.resources.some((r) => r.status === 'active') && <p class="yc-alert yc-alert--warn" data-testid="request-warning">Комната занята под необработанную заявку и снимется автоматически по сроку удержания.</p>}
      </section>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="event-notice">{notice}</p>}
      {error && <p class="yc-alert yc-alert--error" role="alert" data-testid="event-error">{error}</p>}
      {decision && (
        <section class="yc-panel" aria-label="Требует решения" data-testid="needs-decision">
          <h2>Требует решения</h2>
          <p>Система ничего из этого не отменяла и не возвращала – решите вручную.</p>
          {decision.bookingIds.length > 0 ? <ul class="yc-ev__links">{decision.bookingIds.map((id, i) => <li key={id}><a href={`/bookings/${id}`}>Связанная бронь {i + 1}</a></li>)}</ul> : <p class="yc-empty">Связанных броней нет.</p>}
          <p>Выданных подарков: {decision.giftIds.length}.</p>
          {decision.receivedKop !== undefined && <p>Получено денег: {rub(decision.receivedKop)}. Возврат – на вкладке «Поступления».</p>}
          <p>Остаток к оплате: {rub(decision.dueKop)}.</p>
        </section>
      )}
      <div class="yc-ev__tabs" role="tablist" aria-label="Разделы мероприятия">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="event-tab" class="yc-tabs__link yc-ev__tab" onClick={() => show(k)}>{label}</button>)}
      </div>
      <section class="yc-panel" id="event-tab" role="tabpanel" aria-labelledby={`tab-${tab}`} data-testid={`tab-${tab}`}>
        {tab === 'main' && <MainTab key={c.rowVersion} {...tabProps} />}
        {tab === 'people' && <PeopleTab key={c.rowVersion} {...tabProps} maxGuests={p.maxGuests} />}
        {tab === 'lines' && <EventLines {...tabProps} />}
        {tab === 'resources' && <EventResources {...tabProps} minMinutes={p.minMinutes} />}
        {tab === 'checklist' && <EventChecklist {...tabProps} />}
        
        
        
        {tab === 'history' && <TimelineView items={c.timeline} tz={tz} staff={p.staff} hasDiff={fullMoney(m)} />}
      </section>
      <ReasonDialog open={closing !== null} title={closing === 'not_held' ? `Мероприятие ${c.number} не состоялось` : `Отменить мероприятие ${c.number}?`} label="Причина" confirm={closing === 'not_held' ? 'Отметить «не состоялось»' : 'Отменить мероприятие'} danger testId="event-close-dialog"
        text={<p>Занятые ресурсы освободятся. Финансовые операции останутся, связанные брони и подарки система не тронет – вы увидите их списком.</p>} onClose={() => setClosing(null)} onConfirm={close} />
    </>
  );
}

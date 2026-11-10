// Новое мероприятие (S3-81, K20 №362, 11 §3, §4.1): создаётся без брони и без профиля; заказчик – контакт, профиль по телефону
// не создаётся, привязка клиента – явным выбором. У платного праздника – формат и гости по правилам R-22: проверка до сохранения,
// окончательно решает сервер. Дата и время – по зоне выбранного филиала. Окно внутри списка, адрес списка не меняется.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { eventError, PARTY_FORMAT, toIso, type EventDto, type EventType, type PartyFormat } from '../lib/events.ts';

export interface PickedClient { id: string; name: string }

/** Поиск клиента (K11 №15): выбор – явный, никакого создания профиля. */
export function ClientPicker(p: { label: string; value: PickedClient | null; onChange: (c: PickedClient | null) => void; testId?: string }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickedClient[]>([]);
  const [note, setNote] = useState('');
  const search = async () => {
    setNote('');
    if (q.trim().length < 2) return setNote('Введите телефон или фамилию – хотя бы 2 символа.');
    try {
      const r = await browserCall<{ items: Array<{ id: string; firstName: string | null; lastName: string | null; phoneMasked: string }> }>(`/clients?q=${encodeURIComponent(q.trim())}&limit=10`);
      setItems(r.items.map((c) => ({ id: c.id, name: `${[c.lastName, c.firstName].filter(Boolean).join(' ') || 'Без имени'}, ${c.phoneMasked}` })));
      if (r.items.length === 0) setNote('Клиент не найден. Без профиля тоже можно: достаточно имени и телефона.');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Поиск не сработал. Повторите.');
    }
  };
  return (
    <div class="yc-field" data-testid={p.testId}>
      <span class="yc-field__label">{p.label}</span>
      {p.value ? (
        <p class="yc-ev__picked">
          <a href={`/clients/${p.value.id}`}>{p.value.name}</a>
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => p.onChange(null)}>Убрать</button>
        </p>
      ) : (
        <>
          <div class="yc-ev__row">
            <input class="yc-input" type="search" aria-label={`${p.label}: телефон или фамилия`} value={q} maxLength={100} onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
            <button class="yc-btn yc-btn--ghost" type="button" onClick={search}>Найти</button>
          </div>
          {note && <p class="yc-field__hint">{note}</p>}
          {items.length > 0 && (
            <ul class="yc-ev__found">
              {items.map((c) => <li key={c.id}><button class="yc-btn yc-btn--ghost" type="button" onClick={() => { p.onChange(c); setItems([]); setQ(''); }}>{c.name}</button></li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export interface EventFormProps {
  types: EventType[];
  branches: Array<{ id: string; name: string; timezone: string }>;
  defaultBranchId: string;
  staff: Array<{ id: string; name: string }>;
  maxGuests: number;
  /** Открыть сразу: переход из карточки клиента. */
  autoOpen?: boolean;
  preset?: PickedClient | null;
}

export default function EventForm(p: EventFormProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const activeTypes = p.types.filter((t) => t.status === 'active');
  const [typeId, setTypeId] = useState(activeTypes[0]?.id ?? '');
  const [branchId, setBranchId] = useState(p.defaultBranchId);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [name, setName] = useState(p.preset ? p.preset.name.split(',')[0]! : '');
  const [phone, setPhone] = useState('');
  const [client, setClient] = useState<PickedClient | null>(p.preset ?? null);
  const [hero, setHero] = useState('');
  const [heroClient, setHeroClient] = useState<PickedClient | null>(null);
  const [count, setCount] = useState('');
  const [responsible, setResponsible] = useState('');
  const [wishes, setWishes] = useState('');
  const [format, setFormat] = useState<PartyFormat>('h2');
  const [catering, setCatering] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const type = activeTypes.find((t) => t.id === typeId);
  const isParty = type?.code === 'birthday_party';
  const isBirthday = isParty || type?.code === 'birthday';
  const tz = p.branches.find((b) => b.id === branchId)?.timezone ?? 'Asia/Novosibirsk';

  useEffect(() => {
    if (p.autoOpen) dialog.current?.showModal();
  }, []);
  // Выбранный клиент: подставляем имя и телефон, если право позволяет его видеть; иначе вводит сотрудник. Сменили клиента – подставленное
  // прежним меняется, введённое руками остаётся; ответ по прежнему клиенту, пришедший позже, не применяется (§10 OTCHET).
  const auto = useRef({ name: p.preset ? p.preset.name.split(',')[0]! : '', phone: '' });
  useEffect(() => {
    if (!client) return;
    let live = true;
    const nm = client.name.split(',')[0]!;
    const wasName = auto.current.name;
    auto.current.name = nm;
    setName((n) => (!n || n === wasName ? nm : n));
    browserCall<{ full: { phoneE164: string | null } | null }>(`/clients/${client.id}`).then((c) => {
      if (!live) return;
      const ph = c.full?.phoneE164 ?? '';
      const wasPhone = auto.current.phone;
      auto.current.phone = ph;
      setPhone((v) => (!v || v === wasPhone ? ph : v));
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [client?.id]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Укажите имя заказчика.');
    if (phone.replace(/\D/g, '').length < 10) return setError('Укажите телефон заказчика: 10 цифр и код страны.');
    const guests = count ? Number(count) : null;
    if (count && (!Number.isInteger(guests) || guests! < 1)) return setError('Количество участников – целое число больше нуля.');
    if (isParty && guests !== null && guests > p.maxGuests) return setError(`На платном празднике – не больше ${p.maxGuests} гостей.`);
    if ((from || to || date) && !(date && from && to)) return setError('Дата, начало и конец заполняются вместе. Можно оставить все три пустыми.');
    if (date && to <= from) return setError('Конец должен быть позже начала.');
    setBusy(true);
    setError('');
    try {
      const created = await browserCall<EventDto>('/events', {
        method: 'POST',
        key: key.current,
        body: {
          typeId, branchId, ...(title.trim() ? { title: title.trim() } : {}),
          plannedStart: toIso(date, from, tz), plannedEnd: toIso(date, to, tz),
          customer: { clientId: client?.id ?? null, name: name.trim(), phone },
          ...(isBirthday ? { birthdayPerson: { clientId: heroClient?.id ?? null, name: hero.trim() || null } } : {}),
          participantsCount: guests, responsibleStaffId: responsible || null, wishes: wishes.trim() || null,
          party: isParty && guests !== null ? { format, guests, catering } : null,
        },
      });
      location.assign(`/events/${created.id}`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
      setBusy(false);
    }
  };

  return (
    <>
      <button class="yc-btn" type="button" onClick={() => dialog.current?.showModal()} disabled={activeTypes.length === 0}>Новое мероприятие</button>
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="ev-new" data-testid="event-form">
        <form class="yc-dialog__body" novalidate onSubmit={submit}>
          <h2 id="ev-new">Новое мероприятие</h2>
          <p class="yc-field__hint">Брони и профиля клиента не требуется: дату, комнату и состав можно заполнить позже. Время – филиала ({tz}).</p>
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Тип</span>
              <select class="yc-input" value={typeId} onChange={(e) => setTypeId(e.currentTarget.value)}>{activeTypes.map((t) => <option value={t.id}>{t.name}</option>)}</select></label>
            <label class="yc-field"><span class="yc-field__label">Филиал</span>
              <select class="yc-input" value={branchId} onChange={(e) => setBranchId(e.currentTarget.value)}>{p.branches.map((b) => <option value={b.id}>{b.name}</option>)}</select></label>
            <label class="yc-field yc-ev__wide"><span class="yc-field__label">Название (необязательно)</span>
              <input class="yc-input" type="text" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Дата</span><input class="yc-input" type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} /></label>
            <div class="yc-ev__row">
              <label class="yc-field"><span class="yc-field__label">Начало</span><input class="yc-input" type="time" step={300} value={from} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
              <label class="yc-field"><span class="yc-field__label">Конец</span><input class="yc-input" type="time" step={300} value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label>
            </div>
            <label class="yc-field"><span class="yc-field__label">Заказчик: имя</span><input class="yc-input" type="text" maxLength={200} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Заказчик: телефон</span><input class="yc-input" type="tel" autoComplete="off" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></label>
            <div class="yc-ev__wide"><ClientPicker label="Профиль заказчика (необязательно)" value={client} onChange={setClient} testId="pick-customer" /></div>
            {isBirthday && (
              <>
                <label class="yc-field"><span class="yc-field__label">Именинник: имя</span><input class="yc-input" type="text" maxLength={200} value={hero} onInput={(e) => setHero(e.currentTarget.value)} /></label>
                <div><ClientPicker label="Профиль именинника (нужен для подарка)" value={heroClient} onChange={setHeroClient} testId="pick-hero" /></div>
              </>
            )}
            <label class="yc-field"><span class="yc-field__label">{isParty ? `Гостей (1–${p.maxGuests})` : 'Участников'}</span><input class="yc-input" type="number" min={1} inputMode="numeric" value={count} onInput={(e) => setCount(e.currentTarget.value)} /></label>
            {p.staff.length > 0 && (
              <label class="yc-field"><span class="yc-field__label">Ответственный</span>
                <select class="yc-input" value={responsible} onChange={(e) => setResponsible(e.currentTarget.value)}><option value="">Не назначен</option>{p.staff.map((s) => <option value={s.id}>{s.name}</option>)}</select></label>
            )}
            {isParty && (
              <>
                <label class="yc-field"><span class="yc-field__label">Формат праздника</span>
                  <select class="yc-input" value={format} onChange={(e) => setFormat(e.currentTarget.value as PartyFormat)}>{(Object.keys(PARTY_FORMAT) as PartyFormat[]).map((f) => <option value={f}>{PARTY_FORMAT[f]}</option>)}</select></label>
                <label class="yc-check"><input type="checkbox" checked={catering} onChange={(e) => setCatering(e.currentTarget.checked)} /> Праздничный стол</label>
              </>
            )}
            <label class="yc-field yc-ev__wide"><span class="yc-field__label">Пожелания</span><textarea class="yc-input" rows={2} maxLength={4000} value={wishes} onInput={(e) => setWishes(e.currentTarget.value)} /></label>
          </div>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dialog.current?.close()}>Назад</button>
            <button class="yc-btn" type="submit" disabled={busy}>Создать</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

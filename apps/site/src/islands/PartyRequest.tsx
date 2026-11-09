// Заявка на праздник с /birthday/ (S3-90, K20 §10, П4 POST /event-requests): клуб (только с комнатой VR+PS4), желаемая дата, формат,
// гости (1…maxGuests из П5 – не зашито), имя, телефон, пожелания. Галочка согласия пустая; без неё кнопка неактивна, а сервер всё равно
// отвечает CONSENT_REQUIRED. Ключ Idempotency-Key – один на попытку: двойное нажатие не создаёт вторую заявку. Успех – только номер из ответа.
// Здесь же – условия подарка имениннику словами 11 §9.1 (их показывают /birthday/ и ЛК «Мой подарок»: одна формулировка на сайт).
import { useRef, useState } from 'preact/hooks';
import { ClientApiError, browserCall, errorText } from '../lib/client.ts';

export type PartyFormat = 'h2' | 'h3plus' | 'full_day';
export const FORMAT_LABEL: Record<PartyFormat, string> = { h2: '2 часа', h3plus: '3 часа и больше', full_day: 'Весь день' };

/** Снимок условий подарка (GiftTerms API) и срок в днях. */
export interface GiftTermsView {
  devices: number; device: string; minutesEach: number; roomMinutes: number;
  weekdays: number[]; excludesHolidays: boolean; notIncluded: string[];
}
const NOT_INCLUDED: Record<string, string> = { PS4: 'PS4', 'PS VR': 'PS VR', food: 'еда' };
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 100, u = n % 10;
  return d >= 11 && d <= 14 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
};
const listRu = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} и ${xs.at(-1)}`);

/** Условия подарка словами 11 §9.1 – из снимка, а не из вёрстки. */
export function giftTermLines(t: GiftTermsView, validDays: number): string[] {
  const workweek = t.weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => t.weekdays.includes(d));
  const lines = [
    `${t.devices} ${plural(t.devices, 'устройство', 'устройства', 'устройств')} ${t.device}`,
    `по ${t.minutesEach} минут на каждое устройство`,
    `суммарная продолжительность использования комнаты – ${t.roomMinutes} минут с учётом подготовки`,
    `срок действия – ${validDays} ${plural(validDays, 'день', 'дня', 'дней')}`,
    'посещение по предварительной записи',
  ];
  if (workweek) lines.push(`доступность с понедельника по пятницу${t.excludesHolidays ? ', кроме праздничных дней' : ''}`);
  const out = t.notIncluded.map((x) => NOT_INCLUDED[x] ?? x);
  if (out.length) lines.push(`${listRu(out)} в подарок не ${out.length > 1 ? 'входят' : 'входит'}`);
  return lines;
}

/** Десять цифр после +7: «8 913…», «+7 913…», «913…» – одинаково (как на /login/ и в оформлении). */
function digitsOf(value: string): string {
  let d = value.replace(/\D/g, '');
  if (value.trim().startsWith('+7')) d = d.slice(1);
  if (d.length > 10 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  return d.slice(0, 10);
}
function formatPhone(d: string): string {
  if (!d) return '';
  let s = '+7 (' + d.slice(0, 3);
  if (d.length >= 3) s += ')';
  if (d.length > 3) s += ' ' + d.slice(3, 6);
  if (d.length > 6) s += '-' + d.slice(6, 8);
  if (d.length > 8) s += '-' + d.slice(8, 10);
  return s;
}

interface Props {
  branches: Array<{ id: string; name: string }>;
  formats: PartyFormat[];
  maxGuests: number;
  /** Сегодня по зоне сети – минимальная дата. */
  today: string;
  /** Выбранный посетителем клуб, если в нём есть комната. */
  preselect: string | null;
}

/** Ошибка сервера → фраза у поля или общая. */
function describe(e: unknown, maxGuests: number): { field: string | null; text: string } {
  if (!(e instanceof ClientApiError)) return { field: null, text: errorText(e) };
  if (e.code === 'CONSENT_REQUIRED') return { field: 'consent', text: 'Отметьте согласие на обработку персональных данных.' };
  if (e.code === 'PARTY_GUESTS_LIMIT') return { field: 'guests', text: `Гостей на празднике – от 1 до ${Number(e.details.max ?? maxGuests)}.` };
  if (e.code === 'RATE_LIMITED') return { field: null, text: 'С этого номера уже отправлено много заявок. Попробуйте завтра или позвоните в клуб.' };
  if (e.code === 'NOT_FOUND') return { field: 'branchId', text: 'Этот клуб сейчас не принимает заявки. Выберите другой.' };
  if (e.code === 'VALIDATION_FAILED') {
    const field = typeof e.details.field === 'string' ? e.details.field : null;
    if (field === 'phone') return { field, text: 'Проверьте номер: нужен российский мобильный, 10 цифр после +7.' };
    if (field === 'preferredDate') return { field, text: 'Выберите дату не раньше сегодняшней.' };
    if (field === 'branchId') return { field, text: e.message || 'В этом клубе нет комнаты для праздника.' };
    return { field: null, text: e.message === 'Заявки сейчас не принимаются' ? 'Заявки сейчас не принимаются. Позвоните в клуб.' : 'Проверьте поля формы.' };
  }
  return { field: null, text: errorText(e) };
}

export default function PartyRequest({ branches, formats, maxGuests, today, preselect }: Props) {
  const [branchId, setBranchId] = useState(preselect ?? branches[0]?.id ?? '');
  const [date, setDate] = useState('');
  const [format, setFormat] = useState<PartyFormat>(formats[0] ?? 'h2');
  const [guests, setGuests] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: string | null; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  async function submit(ev: Event) {
    ev.preventDefault();
    if (!consent || busy) return;
    const g = Number(guests);
    const d = digitsOf(phone);
    if (!date || date < today) return setError({ field: 'preferredDate', text: 'Выберите дату не раньше сегодняшней.' });
    if (!Number.isInteger(g) || g < 1 || g > maxGuests) return setError({ field: 'guests', text: `Гостей на празднике – от 1 до ${maxGuests}.` });
    if (!name.trim()) return setError({ field: 'name', text: 'Как к вам обращаться?' });
    if (d.length !== 10) return setError({ field: 'phone', text: 'Введите номер полностью: 10 цифр после +7.' });
    setBusy(true);
    setError(null);
    try {
      const r = await browserCall<{ requestNumber: string }>(
        '/event-requests',
        { branchId, preferredDate: date, format, guests: g, name: name.trim(), phone: `+7${d}`, ...(comment.trim() ? { comment: comment.trim() } : {}), consent },
        key.current,
      );
      setDone(r.requestNumber);
    } catch (e) {
      setError(describe(e, maxGuests));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div class="yu-notice" role="status" data-testid="party-done">
        Заявка № {done} принята. Администратор клуба позвонит, чтобы согласовать дату, формат и цену. Комната закрепляется после подтверждения.
      </div>
    );
  }

  const fieldError = (f: string) => (error?.field === f ? <p class="yu-alert" role="alert">{error.text}</p> : null);
  return (
    <form class="yu-form yu-party__form" onSubmit={submit} noValidate data-testid="party-form">
      <label class="yu-field">
        <span class="yu-field__label">Клуб</span>
        <select class="yu-input" value={branchId} onChange={(e) => setBranchId((e.target as HTMLSelectElement).value)}>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {fieldError('branchId')}
      <label class="yu-field">
        <span class="yu-field__label">Желаемая дата</span>
        <input class="yu-input" type="date" min={today} value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </label>
      {fieldError('preferredDate')}
      <fieldset class="yu-pay">
        <legend class="yu-field__label">Формат</legend>
        {formats.map((f) => (
          <label class="yu-check" key={f}>
            <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
            <span>{FORMAT_LABEL[f]}</span>
          </label>
        ))}
      </fieldset>
      <label class="yu-field">
        <span class="yu-field__label">Гостей, до {maxGuests}</span>
        <input class="yu-input" type="number" inputMode="numeric" min={1} max={maxGuests} value={guests} onInput={(e) => setGuests((e.target as HTMLInputElement).value)} />
      </label>
      {fieldError('guests')}
      <label class="yu-field">
        <span class="yu-field__label">Ваше имя</span>
        <input class="yu-input" type="text" autoComplete="name" maxLength={200} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      {fieldError('name')}
      <label class="yu-field">
        <span class="yu-field__label">Телефон</span>
        <input
          class="yu-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 (___) ___-__-__" value={phone}
          onFocus={() => !phone && setPhone('+7 (')}
          onInput={(e) => setPhone(formatPhone(digitsOf((e.target as HTMLInputElement).value)) || '+7 (')}
        />
      </label>
      {fieldError('phone')}
      <label class="yu-field">
        <span class="yu-field__label">Пожелания – необязательно</span>
        <textarea class="yu-input" rows={3} maxLength={2000} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label class="yu-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent((e.target as HTMLInputElement).checked)} />
        <span>Даю <a href="/personal-data-consent/" target="_blank" rel="noopener">согласие на обработку персональных данных</a></span>
      </label>
      {fieldError('consent')}
      {error && error.field === null && <p class="yu-alert" role="alert">{error.text}</p>}
      <button class="yu-btn" type="submit" disabled={busy || !consent}>{busy ? 'Отправляем…' : 'Отправить заявку'}</button>
    </form>
  );
}

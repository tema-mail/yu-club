// Слияние дублей клиента (03 §11.2, K9 «Слияние», K11 №253–254; решения D5-01…D5-08). Кнопку страница показывает при праве
// client.merge (Владелец) на живой карточке. Опасное действие с подтверждением (04 §10.4): шаг 1 – найти вторую карточку
// поиском; шаг 2 – предпросмотр «было / стало» (обе карточки, брони, посещения, платежи, баллы, сертификаты, мероприятия,
// уведомления, конфликтующие поля), выбор основной, галочка «это один человек» и основание кодом; итог – переход на основную
// с отметкой ?merged=<id второй>. Права и статусы решает сервер; ошибки 409 – понятным текстом.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

const REASONS = [
  { code: 'same_person_confirmed', label: 'Клиент подтвердил, что это он' },
  { code: 'duplicate_registration', label: 'Повторная регистрация' },
  { code: 'phone_changed', label: 'Клиент сменил телефон' },
] as const;

const FIELD_LABEL: Record<string, string> = {
  firstName: 'Имя', lastName: 'Фамилия', phone: 'Телефон', email: 'Email', birthDate: 'Дата рождения', status: 'Статус',
};
const STATUS_LABEL: Record<string, string> = {
  guest: 'Гость', active: 'Активен', restricted: 'Ограничен', blocked: 'Заблокирован', deletion_requested: 'Запрошено удаление', anonymized: 'Обезличен', merged: 'Объединён',
};

interface Ref { id: string; status: string; firstName: string | null; lastName: string | null; phoneMasked: string }
interface Card extends Ref { registeredAt: string | null }
type Mod = Record<string, number | boolean>;
interface Preview {
  primary: Card; secondary: Card;
  modules: Record<string, { primary: Mod; secondary: Mod }>;
  conflicts: Array<{ field: string; primary: string; secondary: string }>;
  fills: Array<{ field: string; value: string }>;
  statusAfter: string; canMerge: boolean; blocker: string | null;
}

export interface MergeClientProps { clientId: string; name: string }

const nameOf = (c: { firstName: string | null; lastName: string | null }) => [c.lastName, c.firstName].filter(Boolean).join(' ') || 'Без имени';
const rub = (kop: number) => `${(kop / 100).toLocaleString('ru-RU')} ₽`;
const pts = (centi: number) => `${(centi / 100).toLocaleString('ru-RU')} балл.`;
const val = (f: string, v: string) => (f === 'status' ? (STATUS_LABEL[v] ?? v) : f === 'birthDate' ? v.split('-').reverse().join('.') : v);

/** Строки «было / стало» по модулям: что у каждой карточки и что будет у основной (суммы не складываются вслепую – правила модулей). */
function moduleRows(m: Preview['modules']): Array<{ label: string; p: string; s: string; after: string }> {
  const n = (k: string, side: 'primary' | 'secondary', f: string) => Number(m[k]?.[side]?.[f] ?? 0);
  const sum = (k: string, f: string) => n(k, 'primary', f) + n(k, 'secondary', f);
  const bal = (side: 'primary' | 'secondary') => n('loyalty', side, 'balanceCenti');
  const after = Math.max(bal('primary') + bal('secondary'), Math.min(bal('primary'), -5000));
  return [
    { label: 'Брони впереди', p: String(n('booking', 'primary', 'upcoming')), s: String(n('booking', 'secondary', 'upcoming')), after: String(sum('booking', 'upcoming')) },
    { label: 'Все брони', p: String(n('booking', 'primary', 'total')), s: String(n('booking', 'secondary', 'total')), after: String(sum('booking', 'total')) },
    { label: 'Посещения', p: String(n('booking', 'primary', 'visits')), s: String(n('booking', 'secondary', 'visits')), after: String(sum('booking', 'visits')) },
    { label: 'Неявки', p: String(n('booking', 'primary', 'noShows')), s: String(n('booking', 'secondary', 'noShows')), after: String(sum('booking', 'noShows')) },
    { label: 'Платежи', p: rub(n('finance', 'primary', 'paidKop')), s: rub(n('finance', 'secondary', 'paidKop')), after: rub(sum('finance', 'paidKop')) },
    { label: 'Баллы', p: pts(bal('primary')), s: pts(bal('secondary')), after: pts(after) },
    { label: 'Сертификаты', p: String(n('certificates', 'primary', 'active')), s: String(n('certificates', 'secondary', 'active')), after: String(sum('certificates', 'active')) },
    { label: 'Мероприятия', p: String(n('events', 'primary', 'events')), s: String(n('events', 'secondary', 'events')), after: String(sum('events', 'events')) },
    { label: 'Уведомления', p: String(n('notifications', 'primary', 'messages')), s: String(n('notifications', 'secondary', 'messages')), after: String(sum('notifications', 'messages')) },
  ];
}

function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не удалось выполнить. Повторите.';
  const reason = e.details?.reason;
  if (e.code === 'CLIENT_MERGED') return 'Одна из карточек уже объединена – обновите страницу.';
  if (e.code === 'CLIENT_NOT_MERGEABLE') {
    return reason === 'primary_must_be_registered'
      ? 'Основной должна быть зарегистрированная карточка: поменяйте карточки местами.'
      : 'Эту карточку объединять нельзя: она обезличена или по ней запрошено удаление.';
  }
  if (e.code === 'CLIENT_MERGE_CONFLICT') {
    if (reason === 'busy') return 'По второй карточке прямо сейчас оформляется запись – повторите через минуту.';
    if (e.details?.module === 'events') return 'У обеих карточек подарок имениннику за один год – сначала отмените лишний.';
    return 'У обеих карточек есть записи на одно и то же время – сначала отмените одну из них.';
  }
  if (e.code === 'FORBIDDEN') return 'Объединять карточки может только Владелец.';
  if (e.status === 404) return 'Карточка не найдена или недоступна.';
  return e.message;
}

export default function MergeClient(p: MergeClientProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<'pick' | 'preview'>('pick');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Ref[] | null>(null);
  const [pair, setPair] = useState<{ primaryId: string; secondaryId: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sure, setSure] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const open = () => {
    setStep('pick'); setQ(''); setFound(null); setPair(null); setPreview(null); setSure(false); setReason(''); setError('');
    setKey(crypto.randomUUID());
    dialog.current?.showModal();
  };

  const search = async (ev: Event) => {
    ev.preventDefault();
    setError('');
    if (q.trim() === '') return setError('Введите телефон, ФИО, email или ID второй карточки.');
    try {
      const r = await browserCall<{ items: Ref[] }>(`/clients?q=${encodeURIComponent(q.trim())}&limit=20`);
      setFound(r.items.filter((x) => x.id !== p.clientId));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const load = async (primaryId: string, secondaryId: string) => {
    setBusy(true);
    setError('');
    try {
      setPreview(await browserCall<Preview>(`/clients/${encodeURIComponent(primaryId)}/merge-preview?with=${encodeURIComponent(secondaryId)}`));
      setPair({ primaryId, secondaryId });
      setStep('preview');
      setKey(crypto.randomUUID());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy || !pair || !preview) return;
    if (!sure) return setError('Подтвердите, что это один и тот же человек.');
    if (!reason) return setError('Выберите основание.');
    setBusy(true);
    setError('');
    try {
      await browserCall(`/clients/${encodeURIComponent(pair.primaryId)}/merge`, { method: 'POST', body: { secondaryId: pair.secondaryId, reason }, key });
      location.assign(`/clients/${encodeURIComponent(pair.primaryId)}?merged=${encodeURIComponent(pair.secondaryId)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <section class="yc-panel" aria-labelledby="client-merge" data-testid="client-merge">
      <h2 id="client-merge">Дубли</h2>
      <p>Если у клиента две карточки, объедините их: брони, деньги, баллы и сертификаты перейдут на основную, вторая останется ссылкой на неё.</p>
      <p><button type="button" class="yc-btn yc-btn--ghost" onClick={open}>Объединить с…</button></p>
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="client-merge-title">
        {step === 'pick' ? (
          <form class="yc-dialog__body" novalidate onSubmit={search}>
            <h2 id="client-merge-title">Объединить карточку {p.name} с…</h2>
            <label class="yc-field">
              <span class="yc-field__label">Вторая карточка</span>
              <input class="yc-input" type="search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Телефон, ФИО, email или ID" />
            </label>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Отмена</button>
              <button type="submit" class="yc-btn">Найти</button>
            </div>
            <p class="yc-alert yc-alert--error" role="alert">{error}</p>
            {found && (found.length === 0 ? <p data-testid="merge-empty">Других карточек не найдено.</p> : (
              <ul class="yc-list" data-testid="merge-found">
                {found.map((c) => (
                  <li key={c.id}>
                    <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void load(p.clientId, c.id)}>
                      {nameOf(c)} · {c.phoneMasked || 'без телефона'} · {STATUS_LABEL[c.status] ?? c.status}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </form>
        ) : preview && pair ? (
          <form class="yc-dialog__body" novalidate onSubmit={submit} data-testid="merge-preview">
            <h2 id="client-merge-title">Объединить карточки?</h2>
            <p><strong>Действие необратимо.</strong> Основная: <b data-testid="merge-primary">{nameOf(preview.primary)}</b>. Вторая: <b data-testid="merge-secondary">{nameOf(preview.secondary)}</b> – станет ссылкой на основную, её телефон освободится, вход в личный кабинет закроется.</p>
            <p><button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void load(pair.secondaryId, pair.primaryId)}>Сделать основной другую карточку</button></p>
            <table class="yc-table" data-testid="merge-modules">
              <thead><tr><th>Что</th><th>Основная</th><th>Вторая</th><th>Станет у основной</th></tr></thead>
              <tbody>
                {moduleRows(preview.modules).map((r) => (
                  <tr key={r.label}>
                    <td class="yc-table__main">{r.label}</td>
                    <td data-label="Основная">{r.p}</td>
                    <td data-label="Вторая">{r.s}</td>
                    <td data-label="Станет">{r.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="yc-field__hint">Баллы переносятся частями со своими сроками; долг второй – не ниже −50 у основной. Платежи и сертификаты не складываются – меняется только владелец.</p>
            {preview.conflicts.length > 0 && (
              <div data-testid="merge-conflicts">
                <p><b>Разные данные</b> – останутся значения основной:</p>
                <ul>
                  {preview.conflicts.map((c) => <li key={c.field}>{FIELD_LABEL[c.field] ?? c.field}: {val(c.field, c.primary)} (основная) / {val(c.field, c.secondary)} (вторая)</li>)}
                </ul>
              </div>
            )}
            {preview.fills.length > 0 && (
              <p data-testid="merge-fills">Заполнится из второй: {preview.fills.map((f) => FIELD_LABEL[f.field] ?? f.field).join(', ')}.</p>
            )}
            {preview.statusAfter !== preview.primary.status && <p>Статус основной станет: {STATUS_LABEL[preview.statusAfter] ?? preview.statusAfter}.</p>}
            {!preview.canMerge && <p class="yc-alert yc-alert--error">Основной должна быть зарегистрированная карточка – сделайте основной другую.</p>}
            <label class="yc-check">
              <input type="checkbox" checked={sure} onChange={(e) => { setSure((e.target as HTMLInputElement).checked); setError(''); }} />
              Я проверил: это один и тот же человек
            </label>
            <fieldset class="yc-field">
              <legend class="yc-field__label">Основание *</legend>
              {REASONS.map((r) => (
                <label key={r.code} class="yc-check">
                  <input type="radio" name="merge-reason" value={r.code} checked={reason === r.code} onChange={() => { setReason(r.code); setError(''); }} />
                  {r.label}
                </label>
              ))}
            </fieldset>
            <p class="yc-alert yc-alert--error" role="alert">{error}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setStep('pick'); setError(''); }}>Назад</button>
              <button type="submit" class="yc-btn yc-btn--danger" disabled={busy || !preview.canMerge}>Объединить навсегда</button>
            </div>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}

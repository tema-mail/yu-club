// Экран «Настройки» (K7 «HTTP CRM»): ключи группами с человеческими названиями, единицами и пределами
// (пределы приходят с сервера из той же схемы, что он проверяет), бейдж источника, будущие изменения,
// изменение с даты начала, «вернуть к наследованию» через окно подтверждения, история ключа.
// Что можно менять и откуда значение – считает сервер (editable, source, upcoming); здесь только показ и ввод.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

type Level = 'system' | 'network' | 'city' | 'branch';
type Constraints =
  | { kind: 'integer'; min: number | null; max: number | null; nullable: boolean }
  | { kind: 'boolean' | 'list' | 'time' | 'datetime' | 'hours'; nullable: boolean }
  | { kind: 'enum'; options: string[]; nullable: boolean }
  | { kind: 'multi'; options: string[]; minItems: number; nullable: boolean }
  | { kind: 'text'; maxLength: number; nullable: boolean };

export interface SettingItem {
  key: string; value: unknown; systemDefault: unknown;
  source: { level: Level; valueId: string | null; validFrom: string | null; own: boolean; cityName: string | null };
  levels: Array<Exclude<Level, 'system'>>; levelAllowed: boolean; editAction: string; editable: boolean;
  constraints: Constraints; upcoming: Array<{ valueId: string; level: Level; value: unknown; validFrom: string }>; rowVersion: string;
}
export interface SettingsPage {
  scope: { level: Exclude<Level, 'system'>; id: string | null; name: string | null; city: { id: string; name: string } | null; timezone: string | null; today: string };
  items: SettingItem[];
}
interface HistoryRow { valueId: string; level: Level; value: unknown; validFrom: string; validTo: string | null; reason: string | null; own: boolean; status: 'active' | 'planned' | 'ended' }

interface Meta { label: string; hint: string; unit?: string; nullLabel?: string; options?: Record<string, string>; money?: boolean }
const DAYS = 'дн.';
const MIN = 'мин';
const META: Record<string, Meta> = {
  'booking.window_default_days': { label: 'Окно записи по умолчанию', unit: DAYS, hint: 'На сколько дней вперёд сайт открывает расписание. Не больше максимального окна.' },
  'booking.window_max_days': { label: 'Максимальное окно записи', unit: DAYS, hint: 'Дальше этого срока записаться нельзя. Не меньше окна по умолчанию.' },
  'booking.hold_minutes': { label: 'Удержание места при оформлении', unit: MIN, hint: 'Сколько минут место держится за клиентом, пока он оформляет запись. Уже начатое удержание не меняется.' },
  'booking.buffer_minutes': { label: 'Перерыв между сеансами', unit: MIN, hint: 'Пауза после брони, когда место не продаётся. 0 – без перерыва.' },
  'booking.max_hold_items': { label: 'Мест в одном оформлении', unit: 'шт.', hint: 'Сколько мест клиент может держать одновременно.' },
  'booking.max_anonymous_holds_per_branch': { label: 'Удержаний без входа на филиал', unit: 'шт.', hint: 'Защита от ботов: сколько мест одновременно держат посетители, не вошедшие на сайт.' },
  'booking.client_cancel_enabled': { label: 'Клиент отменяет запись сам', hint: 'В личном кабинете есть кнопка «Отменить запись».' },
  'visit.arrive_early_min': { label: 'Отметка прихода заранее', unit: MIN, hint: 'За сколько минут до начала сеанса Администратор может отметить приход.' },
  'notifications.reminder_day_before_time': { label: 'Напоминание накануне', hint: 'Во сколько по времени филиала накануне приходит напоминание о записи.' },
  'notifications.reminder_before_minutes': { label: 'Напоминание перед началом', unit: MIN, hint: 'За сколько минут до сеанса приходит второе напоминание.' },
  'notifications.push_retry_limit': { label: 'Повторы отправки push', unit: 'раз', hint: 'Сколько раз повторить отправку, если сервис уведомлений не ответил.' },
  'staff.session_idle_minutes': { label: 'Выход сотрудника при бездействии', unit: MIN, hint: 'Через сколько минут без действий CRM попросит войти снова.' },
  'staff.session_absolute_hours': { label: 'Наибольшая длина сессии сотрудника', unit: 'ч', hint: 'Даже при работе в CRM вход нужно повторить через это время.' },
  'staff.login_max_failures': { label: 'Неверных паролей до паузы', unit: 'раз', hint: 'После стольких ошибок подряд вход сотрудника временно закрывается.' },
  'staff.login_lock_minutes': { label: 'Пауза входа после ошибок', unit: MIN, hint: 'На сколько закрывается вход после неверных паролей.' },
  'client.otp_ttl_seconds': { label: 'Срок действия кода входа', unit: 'сек.', hint: 'Сколько действует код из SMS для входа клиента.' },
  'client.otp_max_attempts': { label: 'Попыток ввода кода', unit: 'раз', hint: 'После стольких неверных вводов код перестаёт действовать.' },
  'client.otp_resend_cooldown_seconds': { label: 'Пауза перед повторным кодом', unit: 'сек.', hint: 'Через сколько секунд можно запросить код ещё раз.' },
  'client.otp_max_per_phone_per_hour': { label: 'Кодов на номер в час', unit: 'шт.', hint: 'Защита от подбора: больше кодов на один номер за час не отправляется.' },
  'client.session_days': { label: 'Вход клиента действует', unit: DAYS, hint: 'Сколько дней клиент остаётся в личном кабинете без повторного входа.' },
  'branch.default_hours': { label: 'Часы работы нового филиала', hint: 'Подставляются в график только при создании филиала. Графики работающих филиалов не меняются.' },
  'payment.certificate_topup_enabled': { label: 'Доплата к сертификату', hint: 'Если номинала не хватает на сеанс, разницу можно доплатить.' },
  'finance.negative_balance_allowed': { label: 'Касса может уйти в минус', hint: 'Разрешить расход, когда в кассе не хватает денег.' },
  'finance.cash_shift_enabled': { label: 'Кассовые смены', hint: 'Закрытие смены Администратора с пересчётом наличных.' },
  'certificate.sale_methods': { label: 'Способы оплаты сертификата', hint: 'Чем можно оплатить покупку сертификата. Хотя бы один способ.', options: { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' } },
  'certificate.nominal_min_kop': { label: 'Наименьший номинал сертификата', unit: '₽', money: true, nullLabel: 'Без ограничения', hint: 'Меньше этой суммы сертификат не продаётся. Не больше наибольшего номинала.' },
  'certificate.nominal_max_kop': { label: 'Наибольший номинал сертификата', unit: '₽', money: true, nullLabel: 'Без ограничения', hint: 'Больше этой суммы сертификат не продаётся.' },
  'loyalty.batch_ttl_days': { label: 'Срок жизни баллов', unit: DAYS, nullLabel: 'Бессрочно', hint: 'Через сколько дней начисленные баллы сгорают. Уже начисленные хранят свой срок.' },
  'loyalty.penalty_scope': { label: 'Штраф за неявку', hint: 'За что снимаются баллы, если клиент не пришёл.', options: { visit: 'За визит (брони подряд – один штраф)', booking: 'За каждую бронь' } },
  'loyalty.penalties_from': { label: 'Штрафы за неявку начисляются с', nullLabel: 'Не начисляются', hint: 'С этого момента за неявку снимаются баллы. Раньше этой даты штрафов нет.' },
  'loyalty.points_resource_types': { label: 'Места, которые оплачиваются баллами', hint: 'Коды типов мест через запятую (pc, vr_seat, ps_room…). Пусто – баллами не оплачивается ничего.' },
  'loyalty.accrue_for_points': { label: 'Баллы за оплату баллами', hint: 'Начислять баллы, если сеанс оплачен баллами.' },
  'loyalty.accrue_for_certificate': { label: 'Баллы за оплату сертификатом', hint: 'Начислять баллы, если сеанс оплачен сертификатом.' },
  'notifications.marketing_title_prefix': { label: 'Пометка рекламного сообщения', hint: 'С этих слов начинается заголовок каждой рекламной рассылки.' },
  // Реквизиты оператора (K7): сайт показывает блок на «Контактах» только из заполненных полей; пусто – блока нет.
  'legal.operator_name': { label: 'Юридическое лицо', nullLabel: 'Не указано', hint: 'Оператор персональных данных: ООО или ИП, как в документах. Показывается на сайте в «Контактах» и в юридических текстах.' },
  'legal.inn': { label: 'ИНН', nullLabel: 'Не указан', hint: '10 цифр у организации, 12 – у ИП.' },
  'legal.ogrn': { label: 'ОГРН', nullLabel: 'Не указан', hint: '13 цифр у организации, 15 – ОГРНИП.' },
  'legal.address': { label: 'Юридический адрес', nullLabel: 'Не указан', hint: 'Адрес оператора персональных данных с индексом.' },
  'legal.phone': { label: 'Телефон оператора', nullLabel: 'Не указан', hint: 'Телефон для обращений по персональным данным и реквизитам.' },
  'legal.email': { label: 'Почта оператора', nullLabel: 'Не указана', hint: 'Почта для обращений по персональным данным.' },
};
const GROUPS: Array<{ prefix: string[]; title: string }> = [
  { prefix: ['booking', 'visit'], title: 'Запись и посещения' },
  { prefix: ['notifications'], title: 'Напоминания' },
  { prefix: ['payment', 'finance'], title: 'Оплата и касса' },
  { prefix: ['certificate'], title: 'Сертификаты' },
  { prefix: ['loyalty'], title: 'Баллы' },
  { prefix: ['staff', 'client'], title: 'Вход сотрудников и клиентов' },
  { prefix: ['branch'], title: 'Новые филиалы' },
  { prefix: ['legal'], title: 'Реквизиты оператора' },
];
const LEVEL_LABEL: Record<Level, string> = { system: 'система', network: 'сеть', city: 'город', branch: 'филиал' };
const STATUS_LABEL: Record<HistoryRow['status'], string> = { active: 'Действует', planned: 'Запланировано', ended: 'Завершено' };

/** Точка в конце фразы без двойной («дн.» + «.»). */
const dot = (t: string) => (t.endsWith('.') ? t : `${t}.`);
const meta = (key: string): Meta => META[key] ?? { label: key, hint: '' };

function show(item: Pick<SettingItem, 'key' | 'constraints'>, value: unknown): string {
  const m = meta(item.key);
  if (value === null || value === undefined || value === '') return m.nullLabel ?? 'Не задано'; // пустой текст – «не задано» (реквизиты)
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'number') return m.money ? `${(value / 100).toLocaleString('ru-RU')} ₽` : `${value}${m.unit ? ` ${m.unit}` : ''}`;
  if (Array.isArray(value)) return value.length === 0 ? 'Ничего' : value.map((v) => m.options?.[String(v)] ?? String(v)).join(', ');
  if (typeof value === 'object') {
    const h = value as { open?: string; close?: string };
    return `${h.open ?? '?'}–${h.close ?? '?'}`;
  }
  if (item.constraints.kind === 'datetime') return new Date(String(value)).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  return m.options?.[String(value)] ?? String(value);
}

function rangeText(item: SettingItem): string {
  const c = item.constraints;
  const m = meta(item.key);
  if (c.kind !== 'integer' || (c.min === null && c.max === null)) return '';
  const f = (n: number) => (m.money ? `${(n / 100).toLocaleString('ru-RU')}` : n.toLocaleString('ru-RU'));
  return `от ${f(c.min ?? 0)} до ${f(c.max ?? 0)}${m.unit ? ` ${m.unit}` : ''}`;
}

function sourceText(item: SettingItem, cityLabel: string | null): string {
  const s = item.source;
  if (s.own) return 'Свой уровень';
  if (s.level === 'system') return 'Системное значение';
  if (s.level === 'network') return 'Унаследовано от сети';
  return `Унаследовано от города${s.cityName ?? cityLabel ? ` ${s.cityName ?? cityLabel}` : ''}`;
}

/** Ошибка API → понятная фраза (коды K7 и K11). */
function human(e: unknown, item: SettingItem, isOwner: boolean): string {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка. Повторите.';
  const issue = (e.details?.issues as Array<{ message: string }> | undefined)?.[0]?.message ?? '';
  const pair = /window_max_days \((\d+)\) < window_default_days \((\d+)\)/.exec(issue);
  switch (e.code) {
    case 'SETTING_INVALID':
      if (pair) return `Максимальное окно записи (${pair[1]} ${DAYS}) не может быть меньше окна по умолчанию (${pair[2]} ${DAYS}). Сначала уменьшите окно по умолчанию или выберите значение побольше.`;
      return dot(`Такое значение не подходит${rangeText(item) ? `: допустимо ${rangeText(item)}` : ''}`);
    case 'SETTING_LEVEL_NOT_ALLOWED':
      return 'На этом уровне эта настройка не задаётся – только там, где она указана.';
    case 'SETTING_PERIOD_OVERLAP':
      return 'Уже запланировано изменение этого уровня (см. «Запланировано»). Новое значение можно задать после того, как оно вступит в силу.';
    case 'VERSION_CONFLICT':
      return 'Пока вы редактировали, настройку уже изменили. Значение на экране обновлено – проверьте и повторите.';
    case 'VALIDATION_FAILED':
      return e.details?.field === 'validFrom' ? 'Дата начала не может быть в прошлом: выберите сегодня или позже.' : `Проверьте значение: ${e.message.replace(/\.$/, '')}.`;
    case 'FORBIDDEN':
      return isOwner ? 'Недостаточно прав.' : 'Эту настройку меняет только Владелец.';
    case 'NOT_FOUND':
      return 'Город или филиал не найден или вне вашей зоны.';
    default:
      return `${e.message.replace(/\.$/, '')}.`;
  }
}

/** Поле ввода → значение для API; null – «не задано»; ошибка – строка. */
function parseInput(item: SettingItem, raw: Draft): { value: unknown } | { error: string } {
  const c = item.constraints;
  const m = meta(item.key);
  if (c.nullable && raw.isNull) return { value: null };
  switch (c.kind) {
    case 'integer': {
      const n = Number(raw.text.trim().replace(',', '.').replace(/\s/g, ''));
      if (raw.text.trim() === '' || !Number.isFinite(n)) return { error: 'Введите число.' };
      const v = m.money ? Math.round(n * 100) : n;
      if (!Number.isInteger(v)) return { error: 'Нужно целое число.' };
      if ((c.min !== null && v < c.min) || (c.max !== null && v > c.max)) return { error: dot(`Допустимо ${rangeText(item)}`) };
      return { value: v };
    }
    case 'boolean':
      return { value: raw.text === 'true' };
    case 'enum':
      return { value: raw.text };
    case 'multi':
      if (raw.picked.length < c.minItems) return { error: 'Выберите хотя бы один вариант.' };
      return { value: c.options.filter((o) => raw.picked.includes(o)) };
    case 'list':
      return { value: raw.text.split(',').map((s) => s.trim()).filter(Boolean) };
    case 'time':
      return /^\d\d:\d\d$/.test(raw.text) ? { value: raw.text } : { error: 'Укажите время ЧЧ:ММ.' };
    case 'text': {
      const t = raw.text.trim();
      return t.length <= c.maxLength ? { value: t } : { error: `Не длиннее ${c.maxLength} знаков.` };
    }
    case 'datetime':
      return raw.text ? { value: new Date(raw.text).toISOString() } : { error: 'Укажите дату и время.' };
    case 'hours':
      if (!raw.open || !raw.close) return { error: 'Укажите открытие и закрытие.' };
      if (raw.close <= raw.open) return { error: 'Закрытие – позже открытия, без перехода через полночь.' };
      return { value: { open: raw.open, close: raw.close } };
  }
}

interface Draft { text: string; picked: string[]; open: string; close: string; isNull: boolean; validFrom: string; reason: string }

function draftOf(item: SettingItem, today: string): Draft {
  const v = item.value;
  const m = meta(item.key);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  let text = '';
  if (typeof v === 'number') text = m.money ? String(v / 100) : String(v);
  else if (typeof v === 'boolean') text = String(v);
  else if (Array.isArray(v)) text = v.join(', ');
  else if (typeof v === 'string') text = item.constraints.kind === 'datetime' ? local(v) : v;
  else if (v === null && item.constraints.kind === 'enum') text = (item.constraints as { options: string[] }).options[0] ?? '';
  const h = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as { open?: string; close?: string };
  return { text, picked: Array.isArray(v) ? v.map(String) : [], open: h.open ?? '10:00', close: h.close ?? '22:00', isNull: v === null, validFrom: today, reason: '' };
}

export interface SettingsProps {
  page: SettingsPage;
  /** Название города уровня (для «унаследовано от города …» на уровне города и филиала). */
  cityLabel: string | null;
  isOwner: boolean;
}

export default function SettingsScreen({ page, cityLabel, isOwner }: SettingsProps) {
  const { scope } = page;
  const query = `scope=${scope.level}${scope.id ? `&id=${encodeURIComponent(scope.id)}` : ''}`;
  const [items, setItems] = useState(page.items);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<{ key: string; rows: HistoryRow[] | null; error: string } | null>(null);
  const [resetKey, setResetKey] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const tz = scope.timezone ?? undefined;
  const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short', ...(tz ? { timeZone: tz } : {}) });
  const editableCount = items.filter((i) => i.editable).length;

  const replace = (next: SettingItem) => setItems((list) => list.map((i) => (i.key === next.key ? next : i)));
  const fail = (item: SettingItem, e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT' && e.details?.current) replace(e.details.current as SettingItem);
    setMsg({ key: item.key, ok: false, text: human(e, item, isOwner) });
  };

  const startEdit = (item: SettingItem) => {
    setEditing(item.key);
    setDraft(draftOf(item, scope.today));
    setMsg(null);
  };

  const save = async (e: Event, item: SettingItem) => {
    e.preventDefault();
    if (!draft) return;
    const parsed = parseInput(item, draft);
    if ('error' in parsed) {
      setMsg({ key: item.key, ok: false, text: parsed.error });
      return;
    }
    if (!draft.validFrom || draft.validFrom < scope.today) {
      setMsg({ key: item.key, ok: false, text: 'Дата начала не может быть в прошлом: выберите сегодня или позже.' });
      return;
    }
    setBusy(true);
    try {
      const next = await browserCall<SettingItem>(`/settings/${encodeURIComponent(item.key)}?${query}`, {
        method: 'PUT',
        body: { value: parsed.value, validFrom: draft.validFrom, rowVersion: item.rowVersion, ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}) },
      });
      replace(next);
      setEditing(null);
      const when = draft.validFrom === scope.today ? 'с этой минуты' : `с ${new Date(`${draft.validFrom}T12:00:00Z`).toLocaleDateString('ru-RU')}`;
      setMsg({ key: item.key, ok: true, text: `Сохранено: ${show(item, parsed.value)} ${when}.` });
      if (history?.key === item.key) void openHistory(item.key, true);
    } catch (err) {
      fail(item, err);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const item = items.find((i) => i.key === resetKey);
    dialog.current?.close();
    if (!item) return;
    setBusy(true);
    try {
      const next = await browserCall<SettingItem>(`/settings/${encodeURIComponent(item.key)}/reset?${query}`, { method: 'POST', body: { rowVersion: item.rowVersion } });
      replace(next);
      setEditing(null);
      setMsg({ key: item.key, ok: true, text: `Возвращено к наследованию: ${show(next, next.value)} (${sourceText(next, cityLabel).toLowerCase()}).` });
      if (history?.key === item.key) void openHistory(item.key, true);
    } catch (err) {
      fail(item, err);
    } finally {
      setBusy(false);
    }
  };

  async function openHistory(key: string, keep = false) {
    if (!keep && history?.key === key) {
      setHistory(null);
      return;
    }
    setHistory({ key, rows: null, error: '' });
    try {
      const r = await browserCall<{ items: HistoryRow[] }>(`/settings/${encodeURIComponent(key)}/history?${query}`);
      setHistory({ key, rows: r.items, error: '' });
    } catch (e) {
      setHistory({ key, rows: null, error: e instanceof ApiError ? e.message.replace(/\.$/, '') : 'неизвестная ошибка' });
    }
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const input = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  const editor = (item: SettingItem) => {
    const c = item.constraints;
    const m = meta(item.key);
    const d = draft!;
    const id = `set-${item.key.replace(/\./g, '-')}`;
    const disabled = c.nullable && d.isNull;
    return (
      <form class="yc-form" data-guard onSubmit={(e) => void save(e, item)} aria-label={`Изменить: ${m.label}`} style={{ marginTop: 'var(--yc-sp-xs)' }}>
        {c.nullable && (
          <label class="yc-check"><input type="checkbox" checked={d.isNull} onChange={(e) => set({ isNull: (e.currentTarget as HTMLInputElement).checked })} />{m.nullLabel ?? 'Не задано'}</label>
        )}
        {c.kind === 'integer' && (
          <div class="yc-field">
            <label class="yc-field__label" for={id}>Новое значение{m.unit ? `, ${m.unit}` : ''}</label>
            <input id={id} class="yc-input" inputMode="numeric" value={d.text} disabled={disabled} onInput={(e) => set({ text: input(e) })} />
            {rangeText(item) && <p class="yc-field__hint">{dot(`Допустимо ${rangeText(item)}`)}</p>}
          </div>
        )}
        {c.kind === 'boolean' && (
          <div class="yc-field">
            <label class="yc-field__label" for={id}>Новое значение</label>
            <select id={id} class="yc-input" value={d.text} onChange={(e) => set({ text: input(e) })}>
              <option value="true">Да</option>
              <option value="false">Нет</option>
            </select>
          </div>
        )}
        {c.kind === 'enum' && (
          <div class="yc-field">
            <label class="yc-field__label" for={id}>Новое значение</label>
            <select id={id} class="yc-input" value={d.text} disabled={disabled} onChange={(e) => set({ text: input(e) })}>
              {c.options.map((o) => <option key={o} value={o}>{m.options?.[o] ?? o}</option>)}
            </select>
          </div>
        )}
        {c.kind === 'multi' && (
          <fieldset class="yc-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend class="yc-field__label">Новое значение</legend>
            {c.options.map((o) => (
              <label class="yc-check" key={o}>
                <input type="checkbox" checked={d.picked.includes(o)} disabled={disabled}
                  onChange={(e) => set({ picked: (e.currentTarget as HTMLInputElement).checked ? [...d.picked, o] : d.picked.filter((x) => x !== o) })} />
                {m.options?.[o] ?? o}
              </label>
            ))}
          </fieldset>
        )}
        {(c.kind === 'list' || c.kind === 'text' || c.kind === 'time' || c.kind === 'datetime') && (
          <div class="yc-field">
            <label class="yc-field__label" for={id}>Новое значение</label>
            {c.kind === 'list' || c.kind === 'text' ? (
              <input id={id} class="yc-input" type="text" maxLength={c.kind === 'text' ? c.maxLength : undefined} value={d.text} disabled={disabled} onInput={(e) => set({ text: input(e) })} />
            ) : (
              <input id={id} class="yc-input" type={c.kind === 'time' ? 'time' : 'datetime-local'} value={d.text} disabled={disabled} onInput={(e) => set({ text: input(e) })} />
            )}
            {c.kind === 'datetime' && <p class="yc-field__hint">Время – по часам этого компьютера.</p>}
          </div>
        )}
        {c.kind === 'hours' && (
          <div class="yc-field">
            <span class="yc-field__label">Новые часы работы</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--yc-sp-2xs)', alignItems: 'center' }}>
              <label class="yc-field__hint" for={`${id}-open`}>с</label>
              <input id={`${id}-open`} class="yc-input" type="time" style={{ width: 'auto' }} value={d.open} onInput={(e) => set({ open: input(e) })} />
              <label class="yc-field__hint" for={`${id}-close`}>до</label>
              <input id={`${id}-close`} class="yc-input" type="time" style={{ width: 'auto' }} value={d.close} onInput={(e) => set({ close: input(e) })} />
            </div>
          </div>
        )}
        <div class="yc-field">
          <label class="yc-field__label" for={`${id}-from`}>Действует с</label>
          <input id={`${id}-from`} class="yc-input" type="date" min={scope.today} value={d.validFrom} onInput={(e) => set({ validFrom: input(e) })} />
          <p class="yc-field__hint">Сегодня – сразу после сохранения; уже созданные записи и платежи не меняются. Прошлое не переписывается.</p>
        </div>
        <div class="yc-field">
          <label class="yc-field__label" for={`${id}-reason`}>Причина (видна в истории)</label>
          <input id={`${id}-reason`} class="yc-input" maxLength={500} value={d.reason} onInput={(e) => set({ reason: input(e) })} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--yc-sp-2xs)' }}>
          <button type="submit" class="yc-btn" disabled={busy}>Сохранить</button>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setEditing(null); setMsg(null); }}>Отмена</button>
        </div>
      </form>
    );
  };

  const row = (item: SettingItem) => {
    const m = meta(item.key);
    const own = item.source.own;
    const resettable = item.editable && own;
    return (
      <li class="yc-history__item" key={item.key} data-testid={`setting-${item.key}`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--yc-sp-2xs)', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong>{m.label}</strong>
          <span>
            <span data-testid="value">{show(item, item.value)}</span>{' '}
            <span class={`yc-badge ${own ? 'yc-badge--active' : 'yc-badge--archived'}`} data-testid="source">{sourceText(item, cityLabel)}</span>
          </span>
        </div>
        <p class="yc-field__hint">
          {m.hint}
          {rangeText(item) && ` ${dot(`Допустимо ${rangeText(item)}`)}`}
          {!item.levelAllowed && ` Задаётся на уровне: ${item.levels.map((l) => LEVEL_LABEL[l]).join(', ')}.`}
          {item.levelAllowed && !item.editable && ` Меняет ${item.editAction === 'settings.network.manage' ? 'только Владелец' : 'Владелец или Директор'}.`}
        </p>
        {item.upcoming.length > 0 && (
          <ul class="yc-history__changes" data-testid="upcoming">
            {item.upcoming.map((u) => (
              <li key={u.valueId}>Запланировано с {fmtDate(u.validFrom)}: {show(item, u.value)} ({LEVEL_LABEL[u.level]})</li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--yc-sp-2xs)' }}>
          {item.editable && editing !== item.key && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => startEdit(item)}>Изменить</button>}
          {resettable && (
            <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={() => { setResetKey(item.key); dialog.current?.showModal(); }}>
              Вернуть к наследованию…
            </button>
          )}
          <button type="button" class="yc-btn yc-btn--ghost" aria-expanded={history?.key === item.key} onClick={() => void openHistory(item.key)}>История</button>
        </div>
        {editing === item.key && draft && editor(item)}
        <p class={`yc-alert ${msg?.key === item.key ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">
          {msg?.key === item.key ? msg.text : ''}
        </p>
        {history?.key === item.key && (
          <div data-testid="history">
            {history.error ? (
              <p class="yc-alert yc-alert--error" role="alert">История не загрузилась: {history.error}.</p>
            ) : !history.rows ? (
              <p class="yc-empty" role="status">Загрузка…</p>
            ) : history.rows.length === 0 ? (
              <p class="yc-empty">Значение ни разу не меняли: действует {item.source.level === 'system' ? 'системное' : 'унаследованное'}.</p>
            ) : (
              <ul class="yc-history__changes">
                {history.rows.map((h) => (
                  <li key={h.valueId}>
                    {STATUS_LABEL[h.status]} · {show(item, h.value)} · {LEVEL_LABEL[h.level]}{h.own ? ' (этот уровень)' : ''} · с {fmtDate(h.validFrom)}
                    {h.validTo ? ` по ${fmtDate(h.validTo)}` : ''}
                    {h.reason ? ` · ${h.reason}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  };

  const resetItem = items.find((i) => i.key === resetKey);
  return (
    <>
      {editableCount === 0 && (
        <p class="yc-alert yc-alert--ok" role="note" data-testid="read-only">
          {isOwner ? 'На этом уровне настройки не задаются – выберите другой уровень.' : 'Здесь только просмотр: эти настройки меняет Владелец.'}
        </p>
      )}
      {GROUPS.map((g) => {
        const list = items.filter((i) => g.prefix.includes(i.key.split('.')[0]!));
        if (list.length === 0) return null;
        const gid = `sg-${g.prefix[0]}`;
        return (
          <section class="yc-panel" aria-labelledby={gid} key={gid}>
            <h2 id={gid}>{g.title}</h2>
            <ul class="yc-history">{list.map(row)}</ul>
          </section>
        );
      })}

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="settings-reset-title">
        <div class="yc-dialog__body">
          <h2 id="settings-reset-title">Вернуть к наследованию?</h2>
          {resetItem && (
            <p>
              «{meta(resetItem.key).label}» сейчас: {show(resetItem, resetItem.value)} на этом уровне. После возврата с этой минуты действует значение
              уровня выше (город, сеть или системное). Старое значение останется в истории.
            </p>
          )}
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn yc-btn--danger" disabled={busy} onClick={() => void reset()}>Вернуть</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

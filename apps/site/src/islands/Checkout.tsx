// Оформление записи (S1-20) внутри /schedule/: удержание уже есть (S1-19). Удержание клиента – сразу сводка; удержание
// посетителя – попытка attach (K5 №11): нет входа (AUTH_REQUIRED) – вход по коду прямо здесь, после входа attach переносит
// удержание на клиента (хук входа API делает то же; повтор безопасен). CLIENT_OVERLAP – фраза, выбор не сбрасывается.
// Сводка – цены из ответа API (снимок priceKop удержания), «Подтвердить» – POST confirm с одним Idempotency-Key на попытку:
// повторное нажатие отдаёт ту же бронь. Успех – только после ответа сервера (D-07) → /booking/success/.
import { useEffect, useRef, useState } from 'preact/hooks';
import { SUCCESS_STORE_KEY, bookingApi, describeError, holdStoreKey, rub, timeIn, dayLabel, type HoldDto, type UiState } from '../lib/booking.ts';
import { ClientApiError, clientAuth, errorText } from '../lib/client.ts';

interface Props {
  hold: HoldDto;
  timezone: string;
  onHold: (h: HoldDto) => void;
  onNotice: (n: { state: UiState; text: string } | null) => void;
  onBack: () => void;
}

/** Десять цифр после +7: «8 913…», «+7 913…», «913…» – одинаково (как на /login/). */
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

export default function Checkout({ hold, timezone, onHold, onNotice, onBack }: Props) {
  const [mode, setMode] = useState<'checking' | 'phone' | 'code' | 'summary'>(hold.owner === 'client' ? 'summary' : 'checking');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmKey = useRef(crypto.randomUUID());
  const inFlight = useRef(false);

  async function attach(): Promise<void> {
    try {
      onHold(await bookingApi.attach(hold.id));
      onNotice(null);
      setMode('summary');
    } catch (e) {
      if (e instanceof ClientApiError && e.code === 'AUTH_REQUIRED') {
        setMode('phone');
        return;
      }
      onNotice(describeError(e));
      setMode('summary');
    }
  }

  useEffect(() => {
    if (mode === 'checking') void attach();
  }, []);

  async function requestCode(ev: Event) {
    ev.preventDefault();
    setAuthError('');
    const d = digitsOf(phone);
    if (d.length !== 10) {
      setAuthError('Введите номер полностью: 10 цифр после +7.');
      return;
    }
    setBusy(true);
    try {
      const r = await clientAuth.requestCode(`+7${d}`, crypto.randomUUID());
      setChallengeId(r.challengeId);
      setMode('code');
    } catch (e) {
      setAuthError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(ev: Event) {
    ev.preventDefault();
    setAuthError('');
    if (!consent) return;
    if (!/^\d{6}$/.test(code)) {
      setAuthError('Код – это 6 цифр из SMS.');
      return;
    }
    setBusy(true);
    try {
      await clientAuth.verify(challengeId, code);
      await attach();
    } catch (e) {
      setAuthError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (inFlight.current) return; // второе нажатие во время запроса – тот же запрос; ключ всё равно один
    inFlight.current = true;
    setBusy(true);
    onNotice(null);
    try {
      const result = await bookingApi.confirm(hold.id, confirmKey.current);
      sessionStorage.setItem(SUCCESS_STORE_KEY, JSON.stringify(result));
      sessionStorage.removeItem(holdStoreKey(hold.branchId));
      location.assign('/booking/success/');
    } catch (e) {
      const d = describeError(e);
      if (e instanceof ClientApiError && e.code === 'AUTH_REQUIRED') setMode('phone');
      onNotice(d);
      if (d.state === 'expired') onBack();
      inFlight.current = false;
      setBusy(false);
    }
  }

  const day = (iso: string) => dayLabel(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso))).day;

  return (
    <div class="yu-checkout__body" data-testid="checkout">
      {mode === 'checking' && <p class="yu-body">Проверяем выбор…</p>}

      {mode === 'phone' && (
        <form class="yu-form" onSubmit={requestCode} noValidate>
          <p class="yu-body">Чтобы закрепить запись за вами, войдите по номеру телефона. Выбранное время останется за вами.</p>
          <label class="yu-field">
            <span class="yu-field__label">Телефон</span>
            <input
              class="yu-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 (___) ___-__-__" value={phone}
              onFocus={() => !phone && setPhone('+7 (')}
              onInput={(e) => setPhone(formatPhone(digitsOf((e.target as HTMLInputElement).value)) || '+7 (')}
            />
          </label>
          <button class="yu-btn" type="submit" disabled={busy}>Получить код</button>
        </form>
      )}

      {mode === 'code' && (
        <form class="yu-form" onSubmit={verify} noValidate>
          <p class="yu-body">Код отправлен на {formatPhone(digitsOf(phone))}.</p>
          <label class="yu-field">
            <span class="yu-field__label">Код из SMS</span>
            <input
              class="yu-input" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <label class="yu-check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent((e.target as HTMLInputElement).checked)} />
            <span>Даю <a href="/personal-data-consent/" target="_blank" rel="noopener">согласие на обработку персональных данных</a></span>
          </label>
          <button class="yu-btn" type="submit" disabled={busy || !consent}>Войти и продолжить</button>
          <button class="yu-link-btn" type="button" onClick={() => { setMode('phone'); setCode(''); }}>Изменить номер</button>
        </form>
      )}

      {authError && <p class="yu-alert" role="alert">{authError}</p>}

      {mode === 'summary' && (
        <>
          <ul class="yu-hold__items" data-testid="checkout-items">
            {hold.items.map((i) => (
              <li key={i.id} class="yu-hold__item">
                <span>{i.resourceName}, {day(i.start)}, {timeIn(i.start, timezone)}–{timeIn(i.end, timezone)}</span>
                <span class="yu-hold__price">{rub(i.priceKop)}</span>
              </li>
            ))}
          </ul>
          <p class="yu-hold__total">Итого: <strong data-testid="checkout-total">{rub(hold.totalKop)}</strong></p>
          <p class="yu-body">Оплата – в клубе, при визите.</p>
          <div class="yu-hold__actions">
            <button class="yu-btn" type="button" onClick={confirm} disabled={busy || hold.owner !== 'client'} data-testid="confirm">
              {busy ? 'Подтверждаем…' : 'Подтвердить запись'}
            </button>
            <button class="yu-btn yu-btn--ghost" type="button" onClick={onBack} disabled={busy}>Изменить выбор</button>
          </div>
        </>
      )}
    </div>
  );
}

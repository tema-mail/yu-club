// Оформление записи (S1-20) внутри /schedule/: удержание уже есть (S1-19). Удержание клиента – сразу сводка; удержание
// посетителя – попытка attach (K5 №11): нет входа (AUTH_REQUIRED) – вход по коду прямо здесь, после входа attach переносит
// удержание на клиента (хук входа API делает то же; повтор безопасен). CLIENT_OVERLAP – фраза, выбор не сбрасывается.
// Сводка – цены из ответа API (снимок priceKop удержания), «Подтвердить» – POST confirm с одним Idempotency-Key на попытку:
// повторное нажатие отдаёт ту же бронь. Успех – только после ответа сервера (D-07) → /booking/success/.
// Э2 (S2-72, 07 §6, §12.3): «оплатить баллами» – резерв на удержание (POST points-reserve), 1 балл = 1 минута, только
// всё время целиком: баллов мало – выбор недоступен, доплаты нет. Резерв живёт столько же, сколько удержание (таймер
// выше – его срок); сменился состав – резерв снят (Schedule говорит фразой RESERVE_DROPPED). Спишутся при оплате в клубе.
// Э3 (S3-92, K20 §10): удержание по подарку имениннику – то же оформление K5 с ценой 0, без выбора оплаты и баллов. После успеха
// режим подарка в расписании (GIFT_STORE_KEY) снимается.
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  SUCCESS_STORE_KEY, bookingApi, dayLabel, describeError, holdStoreKey, loyaltyApi, points, pointsWord, rub, timeIn,
  type HoldDto, type LoyaltyBalanceDto, type UiState,
} from '../lib/booking.ts';
import { ClientApiError, clientAuth, errorText } from '../lib/client.ts';
import { GIFT_STORE_KEY } from './MyGift.tsx';

/** Резерв баллов на удержание: подпись состава (id позиций) на момент резерва и сумма. */
export interface PointsReserve { signature: string; amountCenti: number }
export const holdSignature = (h: HoldDto) => h.items.map((i) => i.id).sort().join(',');
export const RESERVE_DROPPED = 'Резерв баллов снят: состав записи изменился. Выберите оплату баллами заново.';

interface Props {
  hold: HoldDto;
  timezone: string;
  onHold: (h: HoldDto) => void;
  onNotice: (n: { state: UiState; text: string } | null) => void;
  onBack: () => void;
  reserve: PointsReserve | null;
  onReserve: (r: PointsReserve | null) => void;
  /** Удержание по подарку имениннику: цена 0, оплаты нет. */
  gift?: boolean;
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

export default function Checkout({ hold, timezone, onHold, onNotice, onBack, reserve, onReserve, gift = false }: Props) {
  const [mode, setMode] = useState<'checking' | 'phone' | 'code' | 'summary'>(hold.owner === 'client' ? 'summary' : 'checking');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmKey = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const [loyalty, setLoyalty] = useState<LoyaltyBalanceDto | null>(null);
  const [paying, setPaying] = useState<null | boolean>(null); // выбор, ждущий ответа сервера (true – баллами)
  const requiredCenti = hold.items.reduce((s, i) => s + (Date.parse(i.end) - Date.parse(i.start)) / 60_000, 0) * 100;

  // Баланс – когда удержание уже клиента (сводка). Без входа баллов нет – блок не показываем.
  useEffect(() => {
    if (mode !== 'summary' || hold.owner !== 'client' || gift) return;
    loyaltyApi.balance().then(setLoyalty).catch(() => setLoyalty(null));
  }, [mode, hold.owner, reserve]);

  async function choosePoints(usePoints: boolean) {
    if (paying !== null || usePoints === (reserve !== null)) return;
    setPaying(usePoints);
    onNotice(null);
    try {
      if (usePoints) {
        const r = await loyaltyApi.reserve(hold.id, crypto.randomUUID());
        onReserve({ signature: holdSignature(hold), amountCenti: r.amountCenti });
      } else {
        await loyaltyApi.release(hold.id);
        onReserve(null);
      }
    } catch (e) {
      onNotice(describeError(e));
      if (usePoints) onReserve(null);
    } finally {
      setPaying(null);
    }
  }
  const usingPoints = paying ?? reserve !== null;

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
      if (gift) sessionStorage.removeItem(GIFT_STORE_KEY);
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
          {gift ? <p class="yu-body" data-testid="gift-free">Подарок имениннику – оплата не нужна.</p> : loyalty ? (() => {
            const enough = loyalty.availableCenti + (reserve?.amountCenti ?? 0) >= requiredCenti;
            const canPoints = !loyalty.preBookingBlocked && (enough || reserve !== null);
            return (
              <fieldset class="yu-pay" data-testid="payment">
                <legend class="yu-field__label">Оплата</legend>
                <label class="yu-check">
                  <input type="radio" name="pay" checked={!usingPoints} disabled={paying !== null} onChange={() => choosePoints(false)} />
                  <span>В клубе, при визите – {rub(hold.totalKop)}</span>
                </label>
                <label class="yu-check">
                  <input type="radio" name="pay" checked={usingPoints} disabled={paying !== null || !canPoints} onChange={() => choosePoints(true)} data-testid="pay-points" />
                  <span>Баллами – {points(requiredCenti)} {pointsWord(requiredCenti)} (доступно {points(loyalty.availableCenti + (reserve?.amountCenti ?? 0))})</span>
                </label>
                {!enough && reserve === null && (
                  <p class="yu-body" data-testid="points-short">
                    Баллов не хватает: доступно {points(loyalty.availableCenti)}, нужно {points(requiredCenti)}. Баллами оплачивается только всё время целиком – доплатить разницу деньгами нельзя.
                  </p>
                )}
                {reserve && (
                  <p class="yu-body" data-testid="points-reserved">
                    Зарезервировано {points(reserve.amountCenti)} {pointsWord(reserve.amountCenti)} – резерв держится, пока идёт таймер, и спишется при оплате сеанса в клубе.
                  </p>
                )}
              </fieldset>
            );
          })() : <p class="yu-body">Оплата – в клубе, при визите.</p>}
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

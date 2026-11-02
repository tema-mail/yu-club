// Оплата в карточке брони (S2-63, K10 №19–21, K16 №36). Способы, сумму и флаг «сертификат + доплата» присылает
// сервер (allowedMethods, amountDueKop, topupEnabled) – экран их не считает. Один сеанс – один способ; вторая строка
// (деньги к сертификату) появляется только при topupEnabled и только если остатка сертификата не хватает. Сертификат –
// номер и 4 цифры кода, сначала проверка (№36: неверный код считается сервером, 5-й – блок). Баллы – только когда
// сервер их разрешил; иначе видно, сколько нужно и сколько есть. Оплата – только после прихода. Одна форма – один
// Idempotency-Key: двойной клик и повтор после обрыва связи дают один платёж; ALREADY_PAID показывает проведённый.
// Возврат (Владелец, Директор) – окно с причиной: целиком или часть денежной строки. Суммы – целые копейки.
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError, browserCall, type Me } from '../lib/api.ts';
import { STATUS_LABEL, inZone, type BookingStatus } from '../lib/booking.ts';
import { fmtPoints } from '../lib/loyalty.ts';
import { METHOD_LABEL, rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';

type Method = 'cash' | 'card' | 'transfer' | 'points' | 'certificate' | 'none';
type Money = 'cash' | 'card' | 'transfer';
type SessionStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded';
interface Line { lineNo: 1 | 2; method: Exclude<Method, 'none'>; amountKop: number; pointsCenti?: number }
interface Payment { id: string; attempt: number; status: 'active' | 'partially_refunded' | 'refunded'; lines: Line[]; totalKop: number; recordedAt: string; comment: string | null }
interface Refund { id: string; lineNo: 1 | 2; amountKop: number; pointsCenti: number | null; reason: string; outcome: 'returned' | 'not_restored'; createdAt: string }
export interface PaymentInfo {
  session: { status: SessionStatus; rowVersion: number; activePaymentId: string | null } | null;
  payment: Payment | null;
  refunds: Refund[];
  allowedMethods: Method[];
  amountDueKop: number;
  topupEnabled: boolean;
  pointsAvailableCenti: number | null;
  pointsRequiredCenti: number | null;
}
interface CertCheck { number: string; pin: string; status: string; balanceKop: number; expiresOn: string }

export interface PaymentPanelProps { bookingId: string; branchId: string; timezone: string; status: BookingStatus }

const MONEY: Money[] = ['cash', 'card', 'transfer'];
const LABEL: Record<Method, string> = { ...METHOD_LABEL, points: 'Баллы', certificate: 'Сертификат', none: 'Без оплаты (0 ₽)' };
const PAY_STATUS: Record<SessionStatus, { text: string; cls: string }> = {
  unpaid: { text: 'Не оплачено', cls: 'yc-badge--temporarily_closed' },
  paid: { text: 'Оплачено', cls: 'yc-badge--active' },
  partially_refunded: { text: 'Оплачено, часть возвращена', cls: 'yc-badge--active' },
  refunded: { text: 'Возвращено полностью', cls: 'yc-badge--temporarily_closed' },
};
const FRIENDLY: Record<string, string> = {
  BOOKING_NOT_PAYABLE: 'Оплата – только после прихода клиента.',
  PAYMENT_METHODS_COMBINED: 'Сеанс оплачивается одним способом.',
  AMOUNT_MISMATCH: 'Сумма не совпала с суммой к оплате: данные обновлены, проверьте и повторите.',
  NOTHING_TO_PAY: 'Сумма к оплате изменилась: данные обновлены.',
  POINTS_INSUFFICIENT: 'Баллов недостаточно для оплаты этого сеанса. Доплата к баллам не предусмотрена – выберите другой способ.',
  POINTS_NOT_ALLOWED: 'Этот вид посещения баллами не оплачивается.',
  CERTIFICATE_NOT_FOUND: 'Сертификат не найден или код неверен. Проверьте номер и 4 цифры кода.',
  CERTIFICATE_EXPIRED: 'Срок действия сертификата истёк.',
  CERTIFICATE_NOT_ACTIVE: 'Сертификат недействителен: отменён, на проверке или полностью использован.',
  CERTIFICATE_INSUFFICIENT: 'Остатка сертификата не хватает на сеанс.',
  REFUND_EXCEEDS_PAID: 'Сумма возврата больше, чем осталось вернуть по этой строке.',
  REFUND_PARTIAL_NOT_ALLOWED: 'Баллы и сертификат возвращаются только целиком.',
  COMMENT_REQUIRED: 'Укажите причину возврата.',
  CASH_INSUFFICIENT: 'В кассе недостаточно наличных для возврата.',
  CASH_SHIFT_REQUIRED: 'Откройте кассовую смену – без неё наличные не принимаются.',
  PERIOD_CLOSED: 'Месяц закрыт – операция невозможна.',
  VERSION_CONFLICT: 'Оплату уже изменил другой сотрудник. Данные обновлены – проверьте и повторите.',
  NETWORK: 'Сервер недоступен. Проверьте связь и повторите – повтор не создаст второй платёж.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Запись не найдена или вне вашей зоны доступа.',
};
const errText = (e: unknown) => {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка. Повторите.';
  if (e.code === 'CERTIFICATE_PIN_LOCKED') return `Слишком много неверных кодов: проверка этого сертификата заблокирована на ${Math.ceil(Number(e.details?.retryAfterSec ?? 900) / 60)} мин.`;
  return FRIENDLY[e.code] ?? e.message;
};

/** Изменяющий вызов с заданным Idempotency-Key (browserCall ставит новый на каждый вызов). */
async function keyed<T>(path: string, body: unknown, key: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'INTERNAL', data.error?.message ?? 'Ошибка сервера', data.error?.details);
  return data as T;
}

const enc = encodeURIComponent;
const lineText = (l: { method: Line['method']; amountKop: number; pointsCenti?: number | null }) =>
  `${LABEL[l.method]} – ${l.method === 'points' && l.pointsCenti ? `${fmtPoints(l.pointsCenti)} (${rub(l.amountKop)})` : rub(l.amountKop)}`;

export default function PaymentPanel({ bookingId, branchId, timezone: tz, status }: PaymentPanelProps) {
  const [info, setInfo] = useState<PaymentInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [canRefund, setCanRefund] = useState(false);
  const [method, setMethod] = useState<Method | ''>('');
  const [certNumber, setCertNumber] = useState('');
  const [certPin, setCertPin] = useState('');
  const [cert, setCert] = useState<CertCheck | null>(null);
  const [certMsg, setCertMsg] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0);
  const [topup, setTopup] = useState<Money>('cash');
  const [receipt, setReceipt] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const payKey = useRef<string | null>(null);
  // возврат
  const dialog = useRef<HTMLDialogElement>(null);
  const refundKey = useRef('');
  const [mode, setMode] = useState<'full' | 'part'>('full');
  const [partLine, setPartLine] = useState<1 | 2>(1);
  const [partRub, setPartRub] = useState('');
  const [reason, setReason] = useState('');
  const [dlgError, setDlgError] = useState('');

  const load = async () => {
    try {
      setInfo(await browserCall<PaymentInfo>(`/bookings/${enc(bookingId)}/payment`));
      setLoadError('');
    } catch (e) {
      setLoadError(errText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [bookingId, status]);
  useEffect(() => {
    browserCall<Me>('/me').then((m) => setCanRefund(m.actions.includes('finance.refund')), () => setCanRefund(false));
  }, []);

  /** Любая правка формы – это новая форма: новый ключ при следующем нажатии. */
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    payKey.current = null;
    set(v);
  };

  if (!info) {
    return (
      <section class="yc-panel" aria-labelledby="pay-title" data-testid="payment">
        <h2 id="pay-title">Оплата</h2>
        {loadError ? <p class="yc-alert yc-alert--error" role="alert">Оплата не загрузилась: {loadError} <button type="button" class="yc-link" onClick={() => void load()}>Повторить</button></p> : <p class="yc-empty">Загружаем…</p>}
      </section>
    );
  }

  const due = info.amountDueKop;
  const live = info.payment && info.payment.status !== 'refunded' ? info.payment : null;
  const shown = info.payment;
  const payStatus: SessionStatus = info.session?.status ?? 'unpaid';
  const allowed = info.allowedMethods;
  const pointsShort = !allowed.includes('points') && allowed.length > 0 && info.pointsRequiredCenti !== null;
  const certReady = cert !== null && cert.number === certNumber.trim().toUpperCase() && cert.pin === certPin;
  const certShort = certReady && cert.balanceKop < due;
  const locked = lockedUntil > Date.now();

  /** Строки оплаты по выбору; null – собрать нельзя (подсказка рядом). */
  const lines = (): Array<Record<string, unknown>> | null => {
    if (method === '') return null;
    if (method === 'none') return [{ method: 'none', amountKop: 0 }];
    if (method !== 'certificate') return [{ method, amountKop: due }];
    if (!certReady) return null;
    const c = { number: cert.number, pin: cert.pin };
    if (cert.balanceKop >= due) return [{ method: 'certificate', amountKop: due, certificate: c }];
    if (!info.topupEnabled) return null;
    return [{ method: 'certificate', amountKop: cert.balanceKop, certificate: c }, { method: topup, amountKop: due - cert.balanceKop }];
  };
  const ready = lines();
  const hasMoney = ready?.some((l) => MONEY.includes(l.method as Money)) ?? false;

  const checkCert = async () => {
    const number = certNumber.trim().toUpperCase();
    if (!number) return setCertMsg('Введите номер сертификата.');
    if (!/^\d{4}$/.test(certPin)) return setCertMsg('Код – 4 цифры из сертификата.');
    if (busy || locked) return;
    setBusy(true);
    setCertMsg('');
    setCert(null);
    try {
      const r = await browserCall<Omit<CertCheck, 'pin'>>('/certificates/check', { method: 'POST', body: { branchId, number, pin: certPin } });
      setCert({ ...r, number: r.number, pin: certPin });
      payKey.current = null;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CERTIFICATE_PIN_LOCKED') setLockedUntil(Date.now() + Number(e.details?.retryAfterSec ?? 900) * 1000);
      setCertMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pay = async (e: Event) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setNotice(null);
    payKey.current ??= crypto.randomUUID();
    const body: Record<string, unknown> = { lines: ready };
    if (comment.trim()) body.comment = comment.trim();
    if (hasMoney) body.receiptIssued = receipt;
    try {
      await keyed(`/bookings/${enc(bookingId)}/payment`, body, payKey.current);
      payKey.current = null;
      setMethod('');
      setCert(null);
      setCertPin('');
      setComment('');
      setNotice({ ok: true, text: `Оплата проведена: ${rub(due)}.` });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NETWORK') {
        setNotice({ ok: false, text: errText(err) }); // ключ тот же: повтор не создаст второй платёж
      } else if (err instanceof ApiError && err.code === 'ALREADY_PAID') {
        payKey.current = null;
        setMethod('');
        setNotice({ ok: true, text: 'Сеанс уже оплачен – ниже проведённый платёж.' });
        await load();
      } else {
        payKey.current = null;
        setNotice({ ok: false, text: errText(err) });
        if (err instanceof ApiError && ['AMOUNT_MISMATCH', 'NOTHING_TO_PAY', 'BOOKING_NOT_PAYABLE', 'POINTS_INSUFFICIENT'].includes(err.code)) await load();
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- возврат
  const refunded = (lineNo: number) => info.refunds.filter((r) => r.lineNo === lineNo).reduce((s, r) => s + r.amountKop, 0);
  const leftOf = (l: Line) => l.amountKop - refunded(l.lineNo);
  const moneyLines = live ? live.lines.filter((l) => MONEY.includes(l.method as Money) && leftOf(l) > 0) : [];
  const openRefund = () => {
    refundKey.current = crypto.randomUUID();
    setMode('full');
    setPartLine(moneyLines[0]?.lineNo ?? 1);
    setPartRub('');
    setReason('');
    setDlgError('');
    dialog.current?.showModal();
  };
  const fullLeft = live ? live.lines.reduce((s, l) => s + Math.max(0, leftOf(l)), 0) : 0;
  const partKop = parseRub(partRub);
  const partMax = live?.lines.find((l) => l.lineNo === partLine) ? leftOf(live.lines.find((l) => l.lineNo === partLine)!) : 0;
  const refundSum = mode === 'full' ? fullLeft : (partKop ?? 0);
  const refund = async (e: Event) => {
    e.preventDefault();
    if (busy || !live || !info.session) return;
    if (mode === 'part' && (partKop === null || partKop > partMax)) return setDlgError(`Введите сумму от 0,01 до ${rub(partMax)}.`);
    if (!reason.trim()) return setDlgError('Укажите причину возврата – без неё возврат не провести.');
    setBusy(true);
    setDlgError('');
    const reqLines = mode === 'full' ? live.lines.filter((l) => leftOf(l) > 0).map((l) => ({ lineNo: l.lineNo })) : [{ lineNo: partLine, amountKop: partKop! }];
    try {
      await keyed(`/payments/${enc(live.id)}/refund`, { rowVersion: info.session.rowVersion, lines: reqLines, reason: reason.trim() }, refundKey.current);
      dialog.current?.close();
      setNotice({ ok: true, text: `Возврат проведён: ${rub(refundSum)}.` });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        dialog.current?.close();
        setNotice({ ok: false, text: errText(err) });
        await load();
      } else {
        if (!(err instanceof ApiError && err.code === 'NETWORK')) refundKey.current = crypto.randomUUID();
        setDlgError(errText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const at = (iso: string) => {
    const z = inZone(iso, tz);
    return `${z.date.slice(8, 10)}.${z.date.slice(5, 7)}, ${z.hm}`;
  };
  const waitText = status === 'confirmed'
    ? 'Оплата – после прихода клиента. Отметьте приход, и здесь появятся способы оплаты.'
    : status === 'arrived' || status === 'completed'
      ? 'Проводить оплату может Владелец, Директор или Администратор филиала.'
      : `Запись не оплачивается: ${STATUS_LABEL[status].toLowerCase()}.`;

  return (
    <section class="yc-panel" aria-labelledby="pay-title" data-testid="payment">
      <h2 id="pay-title">
        Оплата <span class={`yc-badge ${PAY_STATUS[payStatus].cls}`} data-testid="pay-status">{PAY_STATUS[payStatus].text}</span>
      </h2>
      <p class={`yc-alert ${notice ? (notice.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="pay-notice">{notice?.text ?? ''}</p>

      {shown && (
        <div data-testid="pay-done">
          <dl class="yc-props">
            <dt>Проведено{shown.attempt > 1 ? ` (оплата №${shown.attempt})` : ''}</dt>
            <dd>{at(shown.recordedAt)} · {rub(shown.totalKop)}{shown.comment ? ` · «${shown.comment}»` : ''}</dd>
            {shown.lines.map((l) => (
              <>
                <dt>Строка {l.lineNo}</dt>
                <dd data-testid="pay-line">{lineText(l)}</dd>
              </>
            ))}
          </dl>
          {info.refunds.length > 0 && (
            <ol class="yc-history" data-testid="pay-refunds">
              {info.refunds.map((r) => (
                <li class="yc-history__item" key={r.id}>
                  <span class="yc-history__head"><strong>Возврат {rub(r.amountKop)}</strong> · {LABEL[shown.lines.find((l) => l.lineNo === r.lineNo)?.method ?? 'cash']} · {at(r.createdAt)}</span>
                  <span class="yc-field__hint">Причина: {r.reason}{r.outcome === 'not_restored' ? ' · остаток не восстановлен: срок сертификата истёк' : ''}</span>
                </li>
              ))}
            </ol>
          )}
          {live && canRefund && fullLeft > 0 && (
            <p><button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={openRefund}>Вернуть оплату…</button></p>
          )}
        </div>
      )}

      {!live && (allowed.length === 0 ? (
        <p class="yc-empty" data-testid="pay-wait">{waitText}</p>
      ) : (
        <form class="yc-form yc-form--wide" novalidate onSubmit={pay} data-testid="pay-form">
          <p><strong>К оплате: <span data-testid="pay-due">{rub(due)}</span></strong> <span class="yc-field__hint">· цена текущей версии записи</span></p>
          <fieldset class="yc-week">
            <legend class="yc-field__label">Способ – один на сеанс</legend>
            {allowed.map((m) => (
              <label class="yc-check" key={m}>
                <input type="radio" name="pay-method" checked={method === m} onChange={() => edit(setMethod)(m)} />{LABEL[m]}
                {m === 'points' && info.pointsRequiredCenti !== null && <span class="yc-field__hint">({fmtPoints(info.pointsRequiredCenti)})</span>}
              </label>
            ))}
            {pointsShort && (
              <span>
                <label class="yc-check"><input type="radio" name="pay-method" disabled />Баллы</label>{' '}
                <span class="yc-field__hint" data-testid="points-short">
                  Недостаточно: нужно {fmtPoints(info.pointsRequiredCenti!)}, доступно {fmtPoints(info.pointsAvailableCenti ?? 0)}. Доплата к баллам не предусмотрена.
                </span>
              </span>
            )}
          </fieldset>

          {method === 'certificate' && (
            <div class="yc-form" data-testid="pay-cert">
              <div class="yc-field">
                <label class="yc-field__label" for="pay-cert-number">Номер сертификата</label>
                <input id="pay-cert-number" class="yc-input" autocomplete="off" maxLength={40} placeholder="YC-XXXX-XXXX" value={certNumber}
                  onInput={(e) => edit(setCertNumber)((e.currentTarget as HTMLInputElement).value)} />
              </div>
              <div class="yc-field">
                <label class="yc-field__label" for="pay-cert-pin">Код (4 цифры)</label>
                <input id="pay-cert-pin" class="yc-input" inputMode="numeric" autocomplete="off" maxLength={4} value={certPin}
                  onInput={(e) => edit(setCertPin)((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ''))} />
              </div>
              <div><button type="button" class="yc-btn yc-btn--ghost" disabled={busy || locked} onClick={() => void checkCert()}>Проверить сертификат</button></div>
              <p class="yc-alert yc-alert--error" role="alert" data-testid="cert-error">{certMsg}</p>
              {certReady && (
                <p data-testid="cert-ok">
                  Сертификат {cert.number}: остаток {rub(cert.balanceKop)}, действует до {cert.expiresOn.split('-').reverse().join('.')}.
                  {!certShort && ' Остатка хватает – спишется сумма сеанса.'}
                </p>
              )}
              {certShort && (info.topupEnabled ? (
                <div class="yc-field" data-testid="cert-topup">
                  <span class="yc-field__label">Спишется весь остаток {rub(cert.balanceKop)}, доплата {rub(due - cert.balanceKop)}:</span>
                  <select class="yc-input" aria-label="Способ доплаты" value={topup} onChange={(e) => edit(setTopup)((e.currentTarget as HTMLSelectElement).value as Money)}>
                    {MONEY.filter((m) => allowed.includes(m)).map((m) => <option value={m} key={m}>{LABEL[m]}</option>)}
                  </select>
                </div>
              ) : (
                <p class="yc-alert yc-alert--error" role="alert" data-testid="cert-short">
                  Остатка {rub(cert.balanceKop)} не хватает на {rub(due)}. Доплата к сертификату выключена – выберите другой способ.
                </p>
              ))}
            </div>
          )}

          {hasMoney && <label class="yc-check"><input type="checkbox" checked={receipt} onChange={(e) => edit(setReceipt)((e.currentTarget as HTMLInputElement).checked)} />Чек пробит</label>}
          <div class="yc-field">
            <label class="yc-field__label" for="pay-comment">Комментарий (необязательно)</label>
            <input id="pay-comment" class="yc-input" maxLength={2000} value={comment} onInput={(e) => edit(setComment)((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div><button type="submit" class="yc-btn" disabled={busy || !ready}>Провести оплату · {rub(due)}</button></div>
        </form>
      ))}

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="refund-title">
        {live && (
          <form class="yc-dialog__body" novalidate onSubmit={refund}>
            <h2 id="refund-title">Вернуть оплату?</h2>
            <fieldset class="yc-week">
              <legend class="yc-field__label">Сколько вернуть</legend>
              <label class="yc-check"><input type="radio" name="refund-mode" checked={mode === 'full'} onChange={() => setMode('full')} />Всё, что осталось: {rub(fullLeft)}</label>
              {moneyLines.length > 0 && <label class="yc-check"><input type="radio" name="refund-mode" checked={mode === 'part'} onChange={() => setMode('part')} />Часть денег</label>}
            </fieldset>
            {mode === 'part' && (
              <>
                {moneyLines.length > 1 && (
                  <select class="yc-input" aria-label="Строка оплаты" value={partLine} onChange={(e) => setPartLine(Number((e.currentTarget as HTMLSelectElement).value) as 1 | 2)}>
                    {moneyLines.map((l) => <option value={l.lineNo} key={l.lineNo}>{LABEL[l.method]}: можно вернуть {rub(leftOf(l))}</option>)}
                  </select>
                )}
                <div class="yc-field">
                  <label class="yc-field__label" for="refund-sum">Сумма возврата, ₽</label>
                  <input id="refund-sum" class="yc-input" inputMode="decimal" value={partRub} onInput={(e) => setPartRub((e.currentTarget as HTMLInputElement).value)} />
                  <span class="yc-field__hint">Не больше {rub(partMax)}. Баллы и сертификат возвращаются только целиком.</span>
                </div>
              </>
            )}
            <dl class="yc-props yc-bk__diff" data-testid="refund-diff">
              <dt>Было</dt><dd>{PAY_STATUS[payStatus].text} · {rub(live.totalKop)}</dd>
              <dt>Станет</dt><dd><strong>вернётся {rub(refundSum)}, {mode === 'full' || refundSum >= fullLeft ? 'оплата снимется – сеанс снова к оплате' : `останется оплачено ${rub(fullLeft - refundSum)}`}</strong></dd>
            </dl>
            <div class="yc-field">
              <label class="yc-field__label" for="refund-reason">Причина *</label>
              <textarea id="refund-reason" class="yc-input" rows={3} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
            </div>
            <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Не возвращать</button>
              <button type="submit" class="yc-btn yc-btn--danger" disabled={busy}>Вернуть {rub(refundSum)}</button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}

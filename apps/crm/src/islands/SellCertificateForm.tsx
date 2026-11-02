// Продажа сертификата (S2-68, K16 №31, 08 §11.3): номинал в рублях → целые копейки разбором строки, способ оплаты
// из настройки certificate.sale_methods. Ключ идемпотентности – один на открытое окно: двойной клик и повтор после
// обрыва дают один сертификат. Номер и код показываются ОДИН раз – в окне результата (скопировать, печать);
// повторный ответ API отдаёт pin: null, и окно честно говорит, что код больше не покажем. После закрытия код
// стирается из памяти и не попадает ни в адрес, ни в хранилище браузера. Предупреждение R-03 – пока выключен
// payment.certificate_topup_enabled: сеанс сертификатом оплачивается только целиком.
import { useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError } from '../lib/api.ts';
import { rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';
import { day, type CertDto } from './CertificateCard.tsx';

type Method = 'cash' | 'card' | 'transfer';
export interface SellCertificateFormProps {
  branches: Array<{ id: string; name: string }>;
  defaultBranchId: string;
  methods: Method[];
  minKop: number | null;
  maxKop: number | null;
  topupEnabled: boolean;
}
const METHOD: Record<Method, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };

async function sell(branchId: string, body: unknown, key: string): Promise<{ certificate: CertDto; pin: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/branches/${encodeURIComponent(branchId)}/certificates`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Нажмите «Оформить» ещё раз – второй сертификат не появится.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> }; certificate?: CertDto; pin?: string | null };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'INTERNAL', data.error?.message ?? 'Ошибка сервера', data.error?.details);
  return { certificate: data.certificate!, pin: data.pin ?? null };
}

export default function SellCertificateForm(p: SellCertificateFormProps) {
  const [branchId, setBranchId] = useState(p.defaultBranchId);
  const [nominal, setNominal] = useState('');
  const [method, setMethod] = useState<Method>(p.methods[0] ?? 'cash');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ certificate: CertDto; pin: string | null } | null>(null);
  const [copied, setCopied] = useState('');
  const key = useRef('');
  const inflight = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const limits = p.minKop !== null || p.maxKop !== null
    ? `Номинал${p.minKop !== null ? ` от ${rub(p.minKop)}` : ''}${p.maxKop !== null ? ` до ${rub(p.maxKop)}` : ''}.`
    : '';

  const start = () => {
    setNominal('');
    setMethod(p.methods[0] ?? 'cash');
    setComment('');
    setError('');
    setResult(null);
    setCopied('');
    key.current = crypto.randomUUID();
    dialog.current?.showModal();
  };
  /** Закрытие – код стирается; к сертификату ведёт карточка, где кода нет. */
  const finish = () => {
    const id = result?.certificate.id;
    setResult(null);
    dialog.current?.close();
    if (id) location.assign(`/certificates/${id}`);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (inflight.current) return;
    const kop = parseRub(nominal);
    if (kop === null) return setError('Введите номинал в рублях, например 3 000 или 2 500,50.');
    if ((p.minKop !== null && kop < p.minKop) || (p.maxKop !== null && kop > p.maxKop)) return setError(`Номинал вне пределов. ${limits}`);
    inflight.current = true;
    setBusy(true);
    setError('');
    try {
      setResult(await sell(branchId, { nominalKop: kop, method, comment: comment.trim() || null }, key.current));
    } catch (err) {
      setError(err instanceof ApiError
        ? err.code === 'FORBIDDEN' ? 'Продавать сертификаты могут Директор и Владелец.'
          : err.code === 'NOMINAL_OUT_OF_RANGE' ? `Номинал вне допустимых пределов. ${limits}`.trim()
          : err.message
        : 'Не удалось оформить. Повторите.');
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const ticket = (c: CertDto, pin: string) => `Подарочный сертификат Ю Клуб\nНомер: ${c.number}\nКод: ${pin}\nНоминал: ${rub(c.nominalKop)}\nДействует до: ${day(c.expiresOn)}`;
  const copy = async (c: CertDto, pin: string) => {
    try {
      await navigator.clipboard.writeText(ticket(c, pin));
      setCopied('Номер и код скопированы.');
    } catch {
      setCopied('Браузер не дал скопировать – перепишите номер и код вручную.');
    }
  };
  const print = () => {
    document.documentElement.classList.add('yc-printing');
    window.print();
    document.documentElement.classList.remove('yc-printing');
  };

  return (
    <>
      <button class="yc-btn" type="button" onClick={start}>Продать сертификат</button>
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="sell-title" onClose={() => setResult(null)}>
        {result ? (
          <div class="yc-dialog__body" data-testid="sell-result">
            <h2 id="sell-title">Сертификат оформлен</h2>
            {result.pin ? (
              <>
                <div class="yc-sell__ticket">
                  <p class="yc-sell__label">Номер</p>
                  <p class="yc-sell__big" data-testid="sell-number">{result.certificate.number}</p>
                  <p class="yc-sell__label">Код</p>
                  <p class="yc-sell__big" data-testid="sell-pin">{result.pin}</p>
                  <p>Номинал {rub(result.certificate.nominalKop)} · действует до {day(result.certificate.expiresOn)}</p>
                </div>
                <p class="yc-alert yc-alert--error" role="alert" data-testid="sell-once">
                  Код больше не покажем: ни после закрытия окна, ни в карточке. Передайте его клиенту сейчас – скопируйте или распечатайте.
                </p>
                <div class="yc-tabs">
                  <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void copy(result.certificate, result.pin!)}>Скопировать номер и код</button>
                  <button class="yc-btn yc-btn--ghost" type="button" onClick={print}>Печать</button>
                </div>
                {copied && <p class="yc-field__hint" role="status">{copied}</p>}
              </>
            ) : (
              <p class="yc-alert yc-alert--error" role="alert" data-testid="sell-replayed">
                Сертификат {result.certificate.number} уже оформлен этим нажатием. Код показывается только один раз и больше не доступен;
                если клиент его не получил – отмените продажу в карточке и оформите новый.
              </p>
            )}
            <div class="yc-dialog__actions">
              <button class="yc-btn" type="button" onClick={finish}>{result.pin ? 'Код передан клиенту – закрыть' : 'К карточке'}</button>
            </div>
          </div>
        ) : (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="sell-title">Продажа сертификата</h2>
            {!p.topupEnabled && (
              <p class="yc-alert yc-alert--warn" data-testid="sell-r03">
                Сертификатом сеанс оплачивается только целиком: если остаток меньше цены сеанса, доплатить другим способом нельзя.
                Неиспользованный остаток сгорает через 6 месяцев. Предупредите покупателя.
              </p>
            )}
            {p.branches.length > 1 && (
              <label class="yc-field">
                <span class="yc-field__label">Филиал продажи</span>
                <select class="yc-input" value={branchId} onChange={(e) => setBranchId(e.currentTarget.value)}>
                  {p.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}
            <label class="yc-field">
              <span class="yc-field__label">Номинал, ₽</span>
              <input class="yc-input" type="text" inputMode="decimal" autoComplete="off" value={nominal} onInput={(e) => setNominal(e.currentTarget.value)} />
              {limits && <span class="yc-field__hint">{limits}</span>}
            </label>
            <div class="yc-field" role="group" aria-labelledby="sell-method">
              <span class="yc-field__label" id="sell-method">Оплата</span>
              <div class="yc-seg">
                {p.methods.map((m) => (
                  <button key={m} type="button" class="yc-seg__btn" aria-pressed={method === m} onClick={() => setMethod(m)}>{METHOD[m]}</button>
                ))}
              </div>
              <span class="yc-field__hint">Деньги поступят в кассу филиала как продажа сертификата. Покупателя можно не указывать.</span>
            </div>
            <label class="yc-field">
              <span class="yc-field__label">Комментарий (необязательно)</span>
              <textarea class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment(e.currentTarget.value)} />
            </label>
            {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
            <div class="yc-dialog__actions">
              <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dialog.current?.close()}>Отмена</button>
              <button class="yc-btn" type="submit" disabled={busy}>{busy ? 'Оформляем…' : 'Оформить и получить код'}</button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

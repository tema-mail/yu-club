// ЛК «Мои сертификаты» (S2-71, 08 §10, K16 §8): номер, номинал, остаток, дата покупки, срок, статус; у истёкшего –
// номинал, использовано, сгоревший остаток и дата истечения. История погашений с филиалом и датой – по кнопке
// (GET /me/certificates/{number}/history). Кода сертификата и внутренних комментариев в API нет и здесь нет.
import { useEffect, useState } from 'preact/hooks';
import { loyaltyApi, rub, type CertificateHistoryItem, type CertificateStatus, type MyCertificateDto } from '../lib/booking.ts';
import { errorText } from '../lib/client.ts';

const STATUS: Record<CertificateStatus, string> = {
  active: 'Действует', partially_used: 'Частично использован', used_up: 'Использован', expired: 'Истёк', cancelled: 'Аннулирован', needs_review: 'На проверке в клубе',
};
const TYPE: Record<CertificateHistoryItem['type'], string> = {
  sale: 'Покупка', redeem: 'Оплата сертификатом', return: 'Возврат на сертификат', expire: 'Остаток сгорел', correction: 'Корректировка клубом',
};
const fmtDate = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const fmtDay = (d: string) => fmtDate(`${d}T12:00:00Z`);
const signed = (kop: number) => (kop > 0 ? `+${rub(kop)}` : `−${rub(-kop)}`);

export default function MyCertificates() {
  const [items, setItems] = useState<MyCertificateDto[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, CertificateHistoryItem[] | 'loading' | string>>({});

  async function load() {
    setError('');
    try {
      setItems((await loyaltyApi.certificates()).items);
    } catch (e) {
      setError(`Не удалось загрузить сертификаты. ${errorText(e)}`);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(number: string) {
    if (open[number] && open[number] !== 'loading') {
      setOpen((o) => {
        const rest = { ...o };
        delete rest[number];
        return rest;
      });
      return;
    }
    setOpen((o) => ({ ...o, [number]: 'loading' }));
    try {
      const h = await loyaltyApi.certificateHistory(number);
      setOpen((o) => ({ ...o, [number]: h.items }));
    } catch (e) {
      setOpen((o) => ({ ...o, [number]: `Не удалось загрузить историю. ${errorText(e)}` }));
    }
  }

  return (
    <section class="yu-account__block" aria-labelledby="certs-title" data-testid="certificates">
      <h2 id="certs-title">Мои сертификаты</h2>
      {error && <p class="yu-alert" role="alert">{error} <button type="button" class="yu-link-btn" onClick={load}>Повторить</button></p>}
      {!items && !error && <p class="yu-body">Загружаем…</p>}
      {items && items.length === 0 && (
        <p class="yu-body" data-testid="certs-empty">Сертификатов пока нет. Сертификат, купленный в клубе на ваш номер, появится здесь после привязки к кабинету.</p>
      )}
      {items && items.length > 0 && (
        <ul class="yu-mybookings__list">
          {items.map((c) => {
            const h = open[c.number];
            const expired = c.status === 'expired';
            return (
              <li key={c.number} class="yu-mybookings__item" data-testid="certificate">
                <div class="yu-mybookings__row">
                  <p class="yu-mybookings__title">Сертификат № {c.number}</p>
                  <span class="yu-mybookings__status" data-status={expired || c.status === 'cancelled' ? 'no_show' : c.status === 'used_up' ? 'completed' : 'confirmed'}>{STATUS[c.status]}</span>
                </div>
                {expired ? (
                  <>
                    <p class="yu-mybookings__meta">Номинал {rub(c.nominalKop)} · использовано {rub(c.nominalKop - (c.burnedKop ?? 0))} · сгорело {rub(c.burnedKop ?? 0)}</p>
                    <p class="yu-mybookings__meta">Истёк {fmtDay(c.expiresOn)}</p>
                  </>
                ) : (
                  <>
                    <p class="yu-mybookings__meta" data-testid="certificate-balance">Остаток {rub(c.balanceKop)} из {rub(c.nominalKop)}</p>
                    <p class="yu-mybookings__meta">Действует до {fmtDay(c.expiresOn)} включительно</p>
                  </>
                )}
                <p class="yu-mybookings__meta">Куплен {fmtDate(c.soldAt)}</p>
                <button type="button" class="yu-btn yu-btn--ghost" aria-expanded={Array.isArray(h)} onClick={() => toggle(c.number)}>
                  {Array.isArray(h) ? 'Скрыть историю' : 'История использования'}
                </button>
                {h === 'loading' && <p class="yu-body">Загружаем…</p>}
                {typeof h === 'string' && h !== 'loading' && <p class="yu-alert" role="alert">{h}</p>}
                {Array.isArray(h) && (
                  <ul class="yu-mybookings__list" data-testid="certificate-history">
                    {h.map((e, i) => (
                      <li key={`${e.at}-${i}`} class="yu-mybookings__row">
                        <span>{fmtDate(e.at)} · {TYPE[e.type]}{e.branchName ? ` · ${e.branchName}` : ''}</span>
                        <span class="yu-hold__price">{signed(e.amountKop)} → {rub(e.balanceAfterKop)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

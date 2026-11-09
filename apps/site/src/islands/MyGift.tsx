// ЛК «Мой подарок» (S3-91, K20 §10, П1 GET /me/gifts): подарок имениннику – свой блок, не среди сертификатов (приёмка 19), номер GF-,
// без номинала. Условия – словами 11 §9.1 из снимка подарка (giftTermLines, та же формулировка, что на /birthday/), срок, статус.
// «Записаться» – только у действующего (issued): расписание в режиме подарка /schedule/?gift={id} (S3-92). Истёкший – без кнопки.
import { useEffect, useState } from 'preact/hooks';
import { browserCall, errorText } from '../lib/client.ts';
import { giftTermLines, type GiftTermsView } from './PartyRequest.tsx';

export type GiftStatus = 'issued' | 'reserved' | 'used' | 'expired';
/** Элемент П1 (routes.gifts.ts, /me/gifts). */
export interface MyGiftDto { id: string; number: string; issuedOn: string; validUntil: string; status: GiftStatus; terms: GiftTermsView; bookingId: string | null }

/** Режим подарка в расписании живёт в sessionStorage вкладки: если клуб ещё не выбран, /schedule/ сначала покажет список клубов,
 *  а их ссылки ?gift= не несут – расписание выбранного клуба берёт id отсюда. */
export const GIFT_STORE_KEY = 'yu_gift';

export const giftApi = {
  list: () => browserCall<{ items: MyGiftDto[] }>('/me/gifts'),
};

const STATUS: Record<GiftStatus, string> = { issued: 'Действует', reserved: 'Есть запись', used: 'Использован', expired: 'Истёк' };
const LOOK: Record<GiftStatus, string> = { issued: 'confirmed', reserved: 'confirmed', used: 'completed', expired: 'no_show' };
export const fmtDay = (d: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export default function MyGift() {
  const [items, setItems] = useState<MyGiftDto[] | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setItems((await giftApi.list()).items);
    } catch (e) {
      setError(`Не удалось загрузить подарок. ${errorText(e)}`);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <section class="yu-account__block" aria-labelledby="gift-title" data-testid="my-gift">
      <h2 id="gift-title">Мой подарок</h2>
      {error && <p class="yu-alert" role="alert">{error} <button type="button" class="yu-link-btn" onClick={load}>Повторить</button></p>}
      {!items && !error && <p class="yu-body">Загружаем…</p>}
      {items && items.length === 0 && (
        <p class="yu-body" data-testid="gift-empty">Подарка пока нет. Имениннику, отметившему день рождения в клубе, дарим повторный визит в VR – он появится здесь.</p>
      )}
      {items && items.length > 0 && (
        <ul class="yu-mybookings__list">
          {items.map((g) => (
            <li key={g.id} class="yu-mybookings__item" data-testid="gift">
              <div class="yu-mybookings__row">
                <p class="yu-mybookings__title">Подарок имениннику <span style={{ whiteSpace: 'nowrap' }}>№ {g.number}</span></p>
                <span class="yu-mybookings__status" data-status={LOOK[g.status]} data-testid="gift-status">{STATUS[g.status]}</span>
              </div>
              <p class="yu-mybookings__meta" data-testid="gift-term">
                {g.status === 'expired' ? `Срок истёк ${fmtDay(g.validUntil)}` : `Действует до ${fmtDay(g.validUntil)} включительно`} · выдан {fmtDay(g.issuedOn)}
              </p>
              <ul class="yu-body" data-testid="gift-terms">
                {giftTermLines(g.terms, daysBetween(g.issuedOn, g.validUntil)).map((l) => <li key={l}>{l}</li>)}
              </ul>
              {g.status === 'issued' && <a class="yu-btn" href={`/schedule/?gift=${encodeURIComponent(g.id)}`} onClick={() => sessionStorage.setItem(GIFT_STORE_KEY, g.id)} data-testid="gift-book">Записаться</a>}
              {g.status === 'reserved' && <p class="yu-mybookings__meta">По подарку есть запись – она в разделе «Мои записи».</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

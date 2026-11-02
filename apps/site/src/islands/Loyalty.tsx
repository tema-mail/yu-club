// ЛК «Баллы» (S2-70, 07 §12.1–12.2, K15 §11): баланс (минус не скрываем), доступно, в резерве, ближайшее истечение,
// история операций без внутренних комментариев («не возвращено» – своей строкой), каталог товаров клуба (07 §12.4:
// только просмотр, выдача в клубе). При −50 – текст 07 §9.2; кабинет, баланс, история и каталог остаются доступны (§9.3).
import { useEffect, useState } from 'preact/hooks';
import { LIMIT_TEXT, loyaltyApi, points, pointsWord, rub, type GoodsItem, type LoyaltyBalanceDto, type LoyaltyHistoryItem } from '../lib/booking.ts';
import { errorText } from '../lib/client.ts';

interface Props {
  /** Клуб для каталога: выбор посетителя или первый клуб сети. */
  branch: { id: string; name: string } | null;
}

const fmtDateTime = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const fmtDate = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const signed = (centi: number) => (centi > 0 ? `+${points(centi)}` : points(centi));

export default function Loyalty({ branch }: Props) {
  const [balance, setBalance] = useState<LoyaltyBalanceDto | null>(null);
  const [history, setHistory] = useState<LoyaltyHistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [goods, setGoods] = useState<GoodsItem[] | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const [b, h] = await Promise.all([loyaltyApi.balance(), loyaltyApi.history()]);
      setBalance(b);
      setHistory(h.items);
      setNext(h.nextCursor);
      if (branch) setGoods((await loyaltyApi.goods(branch.id)).items);
    } catch (e) {
      setError(`Не удалось загрузить баллы. ${errorText(e)}`);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function more() {
    if (!next) return;
    try {
      const h = await loyaltyApi.history(next);
      setHistory((x) => [...(x ?? []), ...h.items]);
      setNext(h.nextCursor);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section class="yu-account__block" aria-labelledby="loyalty-title" data-testid="loyalty">
      <h2 id="loyalty-title">Баллы</h2>
      {error && <p class="yu-alert" role="alert">{error} <button type="button" class="yu-link-btn" onClick={load}>Повторить</button></p>}
      {!balance && !error && <p class="yu-body">Загружаем…</p>}
      {balance && (
        <>
          {balance.preBookingBlocked && <p class="yu-notice" role="status" data-testid="loyalty-limit">{LIMIT_TEXT}</p>}
          <dl class="yu-facts">
            <div><dt>Баланс</dt><dd data-testid="loyalty-balance">{points(balance.balanceCenti)} {pointsWord(balance.balanceCenti)}</dd></div>
            <div><dt>Доступно</dt><dd data-testid="loyalty-available">{points(balance.availableCenti)}</dd></div>
            <div><dt>В резерве</dt><dd data-testid="loyalty-reserved">{points(balance.reservedCenti)}</dd></div>
            <div>
              <dt>Ближайшее истечение</dt>
              <dd data-testid="loyalty-expiry">
                {balance.nextExpiry ? `${points(balance.nextExpiry.centi)} ${pointsWord(balance.nextExpiry.centi)} – ${fmtDate(balance.nextExpiry.at)}` : 'Нет'}
              </dd>
            </div>
          </dl>
          <p class="yu-body">1 балл = 1 минута игры. Баллы начисляются по запланированному времени сеанса. Оплатить ими можно только всё время целиком.</p>
        </>
      )}

      {history && (
        <div>
          <h3>История</h3>
          {history.length === 0 ? (
            <p class="yu-body" data-testid="loyalty-history-empty">Операций пока нет. Баллы начисляются после посещения клуба.</p>
          ) : (
            <ul class="yu-mybookings__list" data-testid="loyalty-history">
              {history.map((h, i) => (
                <li key={`${h.at}-${i}`} class="yu-mybookings__item">
                  <div class="yu-mybookings__row">
                    <p class="yu-mybookings__title">{h.note}</p>
                    <span class="yu-mybookings__status" data-status={h.deltaCenti < 0 ? 'no_show' : 'confirmed'}>{h.type === 'not_returned' ? '0' : signed(h.deltaCenti)}</span>
                  </div>
                  <p class="yu-mybookings__meta">
                    {fmtDateTime(h.at)}
                    {h.branchName ? ` · ${h.branchName}` : ''}
                    {h.bookingNumber !== null ? ` · запись № ${h.bookingNumber}` : ''}
                  </p>
                  <p class="yu-mybookings__meta">Остаток после: {points(h.balanceAfterCenti)}</p>
                </li>
              ))}
            </ul>
          )}
          {next && <button type="button" class="yu-btn yu-btn--ghost" onClick={more}>Показать ещё</button>}
        </div>
      )}

      {branch && goods && goods.length > 0 && (
        <div>
          <h3>Товары за баллы – {branch.name}</h3>
          <ul class="yu-mybookings__list" data-testid="loyalty-goods">
            {goods.map((g) => (
              <li key={g.id} class="yu-mybookings__item">
                <p class="yu-mybookings__title">{g.name}</p>
                <p class="yu-mybookings__meta">{g.description}</p>
                <p class="yu-mybookings__meta">{rub(g.priceRubKop)} или {points(g.pricePointsCenti)} {pointsWord(g.pricePointsCenti)}</p>
                {!g.available && <p class="yu-mybookings__meta">Сейчас нет в клубе</p>}
              </li>
            ))}
          </ul>
          <p class="yu-body">Товар выдаёт администратор клуба – назовите номер телефона на стойке.</p>
        </div>
      )}
    </section>
  );
}

// Карточка сертификата (S2-67, K16 №30, 32, 33; 08 §11.2): вверху крупно номер, статус, остаток и дата окончания;
// восемь разделов – основные данные, покупатель и получатель, номинал и остаток, срок, погашения, смены привязки,
// отмена и корректировки, аудит (движение остатка по журналу K3). Отмена продажи (certificate.cancel) и
// корректировка остатка (certificate.correct, Владелец) – окнами внутри записи с обязательной причиной;
// Администратору кнопок нет. Код сертификата карточка не показывает никогда – API его не отдаёт.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { rub } from './CashJournal.tsx';
import { parseRub } from './OperationForm.tsx';

export type CertStatus = 'active' | 'partially_used' | 'used_up' | 'expired' | 'cancelled' | 'needs_review';
export interface CertDto {
  id: string; number: string; nominalKop: number; balanceKop: number; soldAt: string; saleBranchId: string; saleMethod: 'cash' | 'card' | 'transfer';
  soldBy: string; expiresOn: string; expiresAt: string; status: CertStatus; buyerClientId: string | null; recipientClientId: string | null;
  comment: string | null; rowVersion: number;
}
export interface CertCardDto extends CertDto {
  cancelReason: string | null; reviewReason: string | null;
  redemptions: Array<{ id: string; bookingId: string; branchName: string; amountKop: number; status: string; at: string }>;
  history: Array<{ oldClientId: string | null; newClientId: string | null; changedBy: string; at: string }>;
  timeline: Array<{ type: string; amountKop: number; balanceAfterKop: number; at: string; basis: string | null }>;
}
export interface CertificateCardProps {
  initial: CertCardDto;
  timezone: string;
  branchNames: Record<string, string>;
  staffNames: Record<string, string>;
  clientNames: Record<string, string>;
  meId: string;
  canCancel: boolean;
  canCorrect: boolean;
}

export const CERT_STATUS: Record<CertStatus, string> = {
  active: 'Активен', partially_used: 'Частично использован', used_up: 'Использован', expired: 'Истёк', cancelled: 'Продажа отменена', needs_review: 'Требует проверки',
};
export const CERT_BADGE: Record<CertStatus, string> = {
  active: 'active', partially_used: 'preparing', used_up: 'archived', expired: 'archived', cancelled: 'temporarily_closed', needs_review: 'temporarily_closed',
};
const METHOD = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' } as const;
const TIMELINE: Record<string, string> = { sale: 'Продажа', redeem: 'Погашение', expire: 'Сгорание по сроку', correction: 'Корректировка', cancel: 'Отмена продажи', return: 'Возврат погашения' };
const REDEMPTION: Record<string, string> = { active: 'Проведено', returned: 'Возвращено', not_restored: 'Возврат без восстановления' };
export const day = (d: string) => d.split('-').reverse().join('.');

export default function CertificateCard(p: CertificateCardProps) {
  const [c, setC] = useState<CertCardDto>(p.initial);
  const [dlg, setDlg] = useState<'cancel' | 'correct' | null>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(true);
  const [sign, setSign] = useState<1 | -1>(-1);
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const at = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: p.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  const who = (id: string) => (id === p.meId ? 'Вы' : (p.staffNames[id] ?? 'Сотрудник'));
  const client = (id: string | null) => (id ? <a href={`/clients/${id}`}>{p.clientNames[id] ?? 'Карточка клиента'}</a> : 'не указан');
  const daysLeft = Math.ceil((Date.parse(c.expiresAt) - Date.now()) / 86_400_000);

  const used = c.redemptions.length > 0 || c.balanceKop !== c.nominalKop;
  const cancelBlock = c.status === 'cancelled' ? 'Продажа уже отменена.' : c.status === 'expired' ? 'Срок истёк – отмена продажи невозможна.'
    : used ? 'Сертификат использовался: простая отмена невозможна, только корректировка остатка Владельцем.' : null;

  const open = (k: 'cancel' | 'correct') => {
    setDlg(k);
    setReason('');
    setRefund(true);
    setSign(-1);
    setAmount('');
    setRef('');
    setError('');
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
    setDlg(null);
  };
  const reload = async () => setC(await browserCall<CertCardDto>(`/certificates/${c.id}`));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || !dlg) return;
    if (!reason.trim()) return setError('Укажите причину – без неё не сохранить.');
    const kop = parseRub(amount);
    if (dlg === 'correct' && kop === null) return setError('Введите сумму корректировки в рублях, например 500 или 500,50.');
    setBusy(true);
    setError('');
    try {
      if (dlg === 'cancel') {
        await browserCall(`/certificates/${c.id}/cancel`, { method: 'POST', body: { rowVersion: c.rowVersion, reason: reason.trim(), refundMoney: refund } });
        setNotice(refund ? `Продажа отменена, ${rub(c.nominalKop)} возвращены из кассы (${METHOD[c.saleMethod].toLowerCase()}).` : 'Продажа отменена без возврата денег.');
      } else {
        await browserCall(`/certificates/${c.id}/correct`, { method: 'POST', body: { rowVersion: c.rowVersion, deltaKop: sign * kop!, reason: reason.trim(), ref: ref.trim() || null } });
        setNotice(`Остаток скорректирован на ${rub(sign * kop!, true)}.`);
      }
      close();
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        await reload().catch(() => undefined);
        setError('Карточку уже изменили – данные обновлены, проверьте и повторите.');
      } else setError(err instanceof ApiError ? (err.code === 'FORBIDDEN' ? 'Недостаточно прав.' : err.message) : 'Не удалось сохранить. Повторите.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section class="yc-panel yc-cert__top" aria-label="Главное">
        <p class="yc-cert__number" data-testid="cert-number">{c.number}</p>
        <dl class="yc-cert__big">
          <div><dt>Статус</dt><dd><span class={`yc-badge yc-badge--${CERT_BADGE[c.status]}`} data-testid="cert-status">{CERT_STATUS[c.status]}</span></dd></div>
          <div><dt>Остаток</dt><dd data-testid="cert-balance">{rub(c.balanceKop)}</dd></div>
          <div><dt>Действует до</dt><dd data-testid="cert-expires">{day(c.expiresOn)}</dd></div>
        </dl>
      </section>
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}

      <section class="yc-panel" aria-labelledby="cs-1">
        <h2 id="cs-1">1. Основные данные</h2>
        <dl class="yc-props">
          <dt>Номер</dt><dd>{c.number}</dd>
          <dt>Продан</dt><dd>{at(c.soldAt)}</dd>
          <dt>Филиал продажи</dt><dd data-testid="cert-branch">{p.branchNames[c.saleBranchId] ?? 'Филиал'}</dd>
          <dt>Оплата</dt><dd>{METHOD[c.saleMethod]}</dd>
          <dt>Продал</dt><dd>{who(c.soldBy)}</dd>
          <dt>Комментарий</dt><dd>{c.comment ?? '–'}</dd>
          {c.reviewReason && <><dt>Требует проверки</dt><dd>{c.reviewReason}</dd></>}
        </dl>
      </section>
      <section class="yc-panel" aria-labelledby="cs-2">
        <h2 id="cs-2">2. Покупатель и получатель</h2>
        <dl class="yc-props">
          <dt>Покупатель</dt><dd>{client(c.buyerClientId)}</dd>
          <dt>Получатель</dt><dd>{client(c.recipientClientId)}</dd>
        </dl>
        <p class="yc-field__hint">Сертификат на предъявителя: погасить его может любой, кто знает номер и код.</p>
      </section>
      <section class="yc-panel" aria-labelledby="cs-3">
        <h2 id="cs-3">3. Номинал и остаток</h2>
        <dl class="yc-props">
          <dt>Номинал</dt><dd data-testid="cert-nominal">{rub(c.nominalKop)}</dd>
          <dt>Использовано</dt><dd>{rub(Math.max(0, c.redemptions.filter((r) => r.status === 'active').reduce((s, r) => s + r.amountKop, 0)))}</dd>
          <dt>Остаток</dt><dd>{rub(c.balanceKop)}</dd>
        </dl>
      </section>
      <section class="yc-panel" aria-labelledby="cs-4">
        <h2 id="cs-4">4. Срок действия</h2>
        <p data-testid="cert-term">
          Действует до конца {day(c.expiresOn)} (по времени филиала продажи).{' '}
          {c.status === 'cancelled' ? '' : daysLeft > 0 ? `Осталось дней: ${daysLeft}.` : 'Срок истёк, неиспользованный остаток сгорел.'}
        </p>
      </section>
      <section class="yc-panel" aria-labelledby="cs-5">
        <h2 id="cs-5">5. История погашений</h2>
        {c.redemptions.length === 0 ? <p class="yc-empty">Погашений не было.</p> : (
          <table class="yc-table" data-testid="cert-redemptions">
            <thead><tr><th>Когда</th><th>Филиал</th><th>Сумма</th><th>Состояние</th><th>Бронь</th></tr></thead>
            <tbody>
              {c.redemptions.map((r) => (
                <tr key={r.id}>
                  <td data-label="Когда">{at(r.at)}</td>
                  <td data-label="Филиал">{r.branchName}</td>
                  <td data-label="Сумма">{rub(r.amountKop)}</td>
                  <td data-label="Состояние">{REDEMPTION[r.status] ?? r.status}</td>
                  <td data-label="Бронь"><a href={`/bookings/${r.bookingId}`}>Открыть</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section class="yc-panel" aria-labelledby="cs-6">
        <h2 id="cs-6">6. История передач и привязки</h2>
        {c.history.length === 0 ? <p class="yc-empty">Привязку к клиенту не меняли.</p> : (
          <ul class="yc-history">
            {c.history.map((h, i) => (
              <li class="yc-history__item" key={i}>
                <span class="yc-history__head">{at(h.at)} · {who(h.changedBy)}</span>
                <span>{h.oldClientId ? (p.clientNames[h.oldClientId] ?? 'клиент') : 'без получателя'} → {h.newClientId ? (p.clientNames[h.newClientId] ?? 'клиент') : 'без получателя'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="yc-panel" aria-labelledby="cs-7">
        <h2 id="cs-7">7. Отмена и корректировки</h2>
        {c.cancelReason && <p data-testid="cert-cancel-reason">Причина отмены: {c.cancelReason}</p>}
        {p.canCancel && cancelBlock && c.status !== 'cancelled' && <p class="yc-field__hint">{cancelBlock}</p>}
        {!p.canCancel && !p.canCorrect && <p class="yc-field__hint">Отмену продажи и корректировку остатка делают Директор и Владелец.</p>}
        <div class="yc-tabs">
          {p.canCancel && !cancelBlock && <button class="yc-btn yc-btn--danger" type="button" onClick={() => open('cancel')}>Отменить продажу…</button>}
          {p.canCorrect && c.status !== 'cancelled' && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => open('correct')}>Корректировать остаток…</button>}
        </div>
      </section>
      <section class="yc-panel" aria-labelledby="cs-8">
        <h2 id="cs-8">8. Аудит: движение остатка</h2>
        <table class="yc-table" data-testid="cert-timeline">
          <thead><tr><th>Когда</th><th>Событие</th><th>Сумма</th><th>Остаток после</th><th>Основание</th></tr></thead>
          <tbody>
            {c.timeline.map((t, i) => (
              <tr key={i}>
                <td data-label="Когда">{at(t.at)}</td>
                <td data-label="Событие">{TIMELINE[t.type] ?? t.type}</td>
                <td data-label="Сумма">{rub(t.amountKop, true)}</td>
                <td data-label="Остаток после">{rub(t.balanceAfterKop)}</td>
                <td data-label="Основание">{t.basis ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="cert-dlg" onClose={() => setDlg(null)}>
        {dlg && (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="cert-dlg">{dlg === 'cancel' ? `Отменить продажу ${c.number}?` : `Корректировка остатка ${c.number}`}</h2>
            {dlg === 'cancel' ? (
              <>
                <p>Сертификат станет недействительным; запись о продаже останется в истории.</p>
                <label class="yc-check">
                  <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.currentTarget.checked)} />
                  Вернуть {rub(c.nominalKop)} покупателю из кассы ({METHOD[c.saleMethod].toLowerCase()})
                </label>
              </>
            ) : (
              <>
                <p>Сейчас: {rub(c.balanceKop)} из {rub(c.nominalKop)}. Остаток после – от нуля до номинала.</p>
                <div class="yc-seg" role="group" aria-label="Направление">
                  <button type="button" class="yc-seg__btn" aria-pressed={sign === -1} onClick={() => setSign(-1)}>Уменьшить</button>
                  <button type="button" class="yc-seg__btn" aria-pressed={sign === 1} onClick={() => setSign(1)}>Увеличить</button>
                </div>
                <label class="yc-field">
                  <span class="yc-field__label">Сумма, ₽</span>
                  <input class="yc-input" type="text" inputMode="decimal" autoComplete="off" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
                </label>
                <label class="yc-field">
                  <span class="yc-field__label">Документ-основание (необязательно)</span>
                  <input class="yc-input" type="text" maxLength={200} value={ref} onInput={(e) => setRef(e.currentTarget.value)} />
                </label>
              </>
            )}
            <label class="yc-field">
              <span class="yc-field__label">{dlg === 'cancel' ? 'Причина отмены' : 'Причина корректировки'}</span>
              <textarea class="yc-input" rows={3} maxLength={2000} value={reason} onInput={(e) => setReason(e.currentTarget.value)} aria-invalid={error ? 'true' : undefined} />
            </label>
            {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
            <div class="yc-dialog__actions">
              <button class="yc-btn yc-btn--ghost" type="button" onClick={close}>Назад</button>
              <button class={`yc-btn${dlg === 'cancel' ? ' yc-btn--danger' : ''}`} type="submit" disabled={busy}>{dlg === 'cancel' ? 'Отменить продажу' : 'Сохранить'}</button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

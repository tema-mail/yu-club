// Обезличивание клиента (K9, 152-ФЗ; K11 №249 POST /clients/{id}/anonymize; решения D4-60…D4-65). Кнопку страница показывает
// только при праве client.anonymize (Владелец) и не обезличенной карточке. Окно говорит, что действие необратимо и что стирается,
// основание – только код (D4-61). 200 (и повтор alreadyAnonymized) – карточка перезагружается с отметкой «Клиент обезличен»;
// 409 CLIENT_HAS_ACTIVE_RECORDS – живые брони или мероприятия клиента: сначала отменить или завершить.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { errorText } from '../lib/equipment.ts';

const REASONS = [
  { code: 'client_request', label: 'По просьбе клиента' },
  { code: 'retention_expired', label: 'Истёк срок хранения данных' },
] as const;

export interface AnonymizeClientProps {
  clientId: string;
  name: string;
}

function blockersText(e: ApiError): string {
  const b = (e.details?.blockers ?? {}) as Record<string, number>;
  const parts = [b.booking ? `броней: ${b.booking}` : '', b.events ? `мероприятий: ${b.events}` : ''].filter(Boolean);
  return `Нельзя обезличить: у клиента есть будущие брони или мероприятия в работе${parts.length ? ` (${parts.join(', ')})` : ''}. ` +
    'Сначала отмените или завершите их, потом повторите.';
}

export default function AnonymizeClient(p: AnonymizeClientProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const open = () => {
    setReason('');
    setError('');
    setKey(crypto.randomUUID());
    dialog.current?.showModal();
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    if (!reason) return setError('Выберите основание.');
    setBusy(true);
    setError('');
    try {
      await browserCall(`/clients/${encodeURIComponent(p.clientId)}/anonymize`, { method: 'POST', body: { reason }, key });
      location.assign(`${location.pathname}?anonymized=1`);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'CLIENT_HAS_ACTIVE_RECORDS' ? blockersText(e) : errorText(e));
      setBusy(false);
    }
  };

  return (
    <section class="yc-panel" aria-labelledby="client-anon" data-testid="client-anonymize">
      <h2 id="client-anon">Обезличивание</h2>
      <p>По закону о персональных данных клиент может попросить удалить свои данные. Карточка останется, но без имени и контактов.</p>
      <p><button type="button" class="yc-btn yc-btn--danger" onClick={open}>Обезличить</button></p>
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="client-anon-title">
        <form class="yc-dialog__body" novalidate onSubmit={submit}>
          <h2 id="client-anon-title">Обезличить клиента {p.name}?</h2>
          <p><strong>Действие необратимо: вернуть данные будет нельзя.</strong></p>
          <p>Будут стёрты:</p>
          <ul>
            <li>фамилия, имя, телефон, email, дата рождения, причина статуса;</li>
            <li>входы в личный кабинет и браузерные уведомления – закрыты;</li>
            <li>рассылки и напоминания – выключены, согласия – отозваны;</li>
            <li>имя и телефон клиента в его прошедших мероприятиях.</li>
          </ul>
          <p>Останутся без имени: деньги, брони, баллы, сертификаты и журнал действий.</p>
          <fieldset class="yc-field">
            <legend class="yc-field__label">Основание *</legend>
            {REASONS.map((r) => (
              <label key={r.code} class="yc-check">
                <input type="radio" name="anon-reason" value={r.code} checked={reason === r.code}
                  onChange={() => { setReason(r.code); setError(''); }} />
                {r.label}
              </label>
            ))}
          </fieldset>
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Не обезличивать</button>
            <button type="submit" class="yc-btn yc-btn--danger" disabled={busy}>Обезличить навсегда</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

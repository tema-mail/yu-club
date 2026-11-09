// Предпросмотр аудитории и второе подтверждение (S4-81; 09 §7.4–§7.5, K21 §5–§6, K11 №205–206). Пять чисел 09 §7.4 и два
// дополнительных исключения; принудительной отправки отказавшимся нет ни здесь, ни в API. «Отправить» открывает итоговый просмотр
// (категория, текст, аудитория, число адресатов) – подтверждается именно это число (expectedTotal). Аудитория изменилась –
// 409 AUDIENCE_CHANGED: окно показывает новое число и ждёт нового подтверждения. Один ключ идемпотентности на попытку.
import { useRef, useState } from 'preact/hooks';
import { ApiError } from '../lib/api.ts';
import { CATEGORY_LABEL, notificationError, type AudiencePreviewDto, type CampaignCategory } from '../lib/notifications.ts';

export interface AudiencePreviewProps {
  preview: AudiencePreviewDto;
  category: CampaignCategory;
  title: string;
  body: string;
  audience: string;
  /** Отправка с подтверждённым числом; ошибку бросает наружу. */
  send: (expectedTotal: number, key: string) => Promise<void>;
  /** Аудитория изменилась: пересчитать предпросмотр. */
  refresh: () => Promise<AudiencePreviewDto>;
  disabled: boolean;
}

const people = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} адресат`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} адресата`;
  return `${n} адресатов`;
};

export default function AudiencePreview({ preview, category, title, body, audience, send, refresh, disabled }: AudiencePreviewProps) {
  const [total, setTotal] = useState(preview.total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const attempt = useRef('');

  const open = () => {
    setTotal(preview.total);
    setError('');
    setChanged('');
    attempt.current = crypto.randomUUID();
    dlg.current?.showModal();
  };
  const lock = useRef(false);
  const confirm = async () => {
    if (lock.current) return; // двойной клик «Отправить» – один запрос
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await send(total, attempt.current);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AUDIENCE_CHANGED') {
        const fresh = await refresh().catch(() => null);
        const next = fresh?.total ?? Number(e.details?.total ?? total);
        setChanged(`Аудитория изменилась: было ${people(total)}, теперь ${people(next)}. Проверьте число и подтвердите ещё раз.`);
        setTotal(next);
        attempt.current = crypto.randomUUID();
      } else {
        setError(notificationError(e));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const facts: Array<[string, number, string]> = [
    ['Всего получателей', preview.total, 'total'],
    ['Есть доступный канал (push)', preview.willReceivePush, 'push'],
    ['Исключены: отказ от рекламы', preview.excludedMarketingOff, 'marketing-off'],
    ['Нет действующего push – только в центре уведомлений', preview.inboxOnly, 'inbox'],
    ['Получат критичное сервисное', preview.criticalService, 'critical'],
  ];
  return (
    <section class="yc-panel" aria-labelledby="ap-title" data-testid="audience-preview">
      <h2 id="ap-title">Аудитория</h2>
      <dl class="yc-props">
        {facts.map(([label, n, id]) => (<><dt>{label}</dt><dd data-testid={`ap-${id}`}>{n}</dd></>))}
        {preview.excludedFrequency > 0 && <><dt>Исключены: реклама за последние 7 дней</dt><dd data-testid="ap-frequency">{preview.excludedFrequency}</dd></>}
        {preview.excludedInactive > 0 && <><dt>Исключены: заблокирован, удаление или обезличен</dt><dd data-testid="ap-inactive">{preview.excludedInactive}</dd></>}
      </dl>
      {category === 'marketing' && preview.excludedMarketingOff > 0 && (
        <p class="yc-field__hint">Отказавшимся от рекламы сообщение не уйдёт – так требует закон и настройки клиента, обойти это нельзя.</p>
      )}
      {preview.sample.length > 0 && <p class="yc-field__hint">Например: {preview.sample.map((s) => s.displayName).join(', ')}</p>}
      <p class="yc-field__hint">Посчитано на {new Date(preview.computedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. Перед отправкой число проверяется ещё раз.</p>
      <div class="yc-eq__actions">
        <button class="yc-btn" type="button" disabled={disabled || preview.total === 0} onClick={open}>Отправить</button>
      </div>
      <dialog ref={dlg} class="yc-dialog" aria-labelledby="ap-confirm-title">
        <div class="yc-dialog__body">
          <h2 id="ap-confirm-title">Отправить {people(total)}?</h2>
          <dl class="yc-props">
            <dt>Категория</dt><dd>{CATEGORY_LABEL[category]}</dd>
            <dt>Заголовок</dt><dd>{title}</dd>
            <dt>Текст</dt><dd>{body}</dd>
            <dt>Аудитория</dt><dd>{audience}</dd>
            <dt>Адресатов</dt><dd data-testid="ap-confirm-total">{total}</dd>
          </dl>
          <p class="yc-field__hint">После подтверждения текст и аудиторию изменить нельзя, ушедшие сообщения не отзываются.</p>
          {changed && <p class="yc-alert yc-alert--error" role="alert" data-testid="ap-changed">{changed}</p>}
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dlg.current?.close()}>Вернуться к сообщению</button>
            <button class="yc-btn" type="button" disabled={busy} onClick={() => void confirm()}>Отправить {people(total)}</button>
          </div>
        </div>
      </dialog>
    </section>
  );
}

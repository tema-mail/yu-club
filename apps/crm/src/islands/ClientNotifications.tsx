// Блок «Уведомления» в карточке клиента (S4-83; 09 §12.3, K21 §9, K11 №212, №209). Реклама и напоминания – вкл/выкл с датой
// последнего изменения; push – «N браузеров» без endpoint и ключей (API их и не отдаёт); последние 20 отправок в пределах зоны.
// Повтор критичного сервисного – только при notifications.retry, с причиной, один ключ на попытку; исходная строка остаётся.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { CATEGORY_LABEL, ROW_BADGE, ROW_STATUS, canRetryRow, fmtAt, notificationError, type ClientNotificationSummary, type NotificationView } from '../lib/notifications.ts';

export interface ClientNotificationsProps {
  clientId: string;
  timezone: string;
  branches: Array<{ id: string; timezone: string }>;
  canRetry: boolean;
  canSend: boolean;
}

const SOURCE: Record<string, string> = { site: 'на сайте', account: 'в личном кабинете', crm: 'в CRM', import: 'при переносе данных' };
const devices = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'браузер' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'браузера' : 'браузеров';
  return `есть ${n} ${word}`;
};

export default function ClientNotifications({ clientId, timezone, branches, canRetry, canSend }: ClientNotificationsProps) {
  const [data, setData] = useState<ClientNotificationSummary | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<NotificationView | null>(null);
  const [reason, setReason] = useState('');
  const [dlgError, setDlgError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  const attempt = useRef('');
  const lock = useRef(false);
  const tzOf = (branchId: string | null) => branches.find((b) => b.id === branchId)?.timezone ?? timezone;

  const load = async () => {
    try {
      setData(await browserCall<ClientNotificationSummary>(`/clients/${encodeURIComponent(clientId)}/notification-summary`));
      setError('');
    } catch (e) {
      setError(notificationError(e));
    }
  };
  useEffect(() => {
    void load();
  }, [clientId]);

  const retry = async (e: Event) => {
    e.preventDefault();
    if (!target || lock.current) return;
    if (!reason.trim()) return setDlgError('Укажите, почему повторяете отправку.');
    lock.current = true;
    setBusy(true);
    try {
      await browserCall(`/notifications/${encodeURIComponent(target.id)}/retry`, { method: 'POST', body: { reason: reason.trim() }, key: attempt.current });
      dlg.current?.close();
      setNotice('Повтор поставлен в очередь.');
      await load();
    } catch (err) {
      setDlgError(notificationError(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const changed = (at: string | null) => (at ? `изменено ${fmtAt(at, timezone)}` : 'не менялось');

  return (
    <section class="yc-panel" aria-labelledby="cn-title" data-testid="client-notifications">
      <h2 id="cn-title">Уведомления</h2>
      {error && (
        <div class="yc-list__error" role="alert">
          <p class="yc-alert yc-alert--error">{error}</p>
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void load()}>Повторить</button>
        </div>
      )}
      {!data && !error && <p class="yc-empty" role="status">Загружаем…</p>}
      {data && (
        <>
          <dl class="yc-props">
            <dt>Реклама</dt>
            <dd data-testid="cn-marketing">{data.marketing.enabled ? 'Включена' : 'Выключена'}, {changed(data.marketing.changedAt)}{data.marketing.source && data.marketing.changedAt ? ` ${SOURCE[data.marketing.source] ?? ''}` : ''}</dd>
            <dt>Напоминания</dt>
            <dd data-testid="cn-reminders">{data.reminders.enabled ? 'Включены' : 'Выключены'}, {changed(data.reminders.changedAt)}</dd>
            <dt>Push</dt>
            <dd data-testid="cn-push">{data.push.activeDevices > 0 ? devices(data.push.activeDevices) : 'нет подписки – сообщения только в центре уведомлений'}</dd>
          </dl>
          {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
          <h3 class="yc-field__label">Последние отправки</h3>
          {data.recent.length === 0 ? (
            <p class="yc-empty">Клиенту ещё ничего не отправляли.</p>
          ) : (
            <ul class="yc-eq__rows" data-testid="cn-recent">
              {data.recent.map((n) => (
                <li class="yc-eq__row" data-testid={`cn-${n.id}`}>
                  <strong>{n.title}</strong>
                  <span>{fmtAt(n.sentAt ?? n.plannedAt, tzOf(n.branchId))} · {CATEGORY_LABEL[n.category]}{n.retryOf ? ' · повтор' : ''}</span>
                  <span><span class={`yc-badge yc-badge--${ROW_BADGE[n.status] ?? 'archived'}`}>{ROW_STATUS[n.status] ?? n.status}</span></span>
                  {canRetry && canRetryRow(n) && (
                    <div class="yc-eq__actions">
                      <button class="yc-btn yc-btn--ghost" type="button" onClick={() => { setTarget(n); setReason(''); setDlgError(''); attempt.current = crypto.randomUUID(); dlg.current?.showModal(); }}>Повторить</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div class="yc-eq__actions">
            <a class="yc-btn yc-btn--ghost" href={`/notifications?tab=rows&clientId=${encodeURIComponent(clientId)}`}>Все отправки клиента</a>
            {canSend && <a class="yc-btn yc-btn--ghost" href={`/notifications/new?clientId=${encodeURIComponent(clientId)}`}>Написать клиенту</a>}
          </div>
        </>
      )}
      <dialog ref={dlg} class="yc-dialog" aria-labelledby="cn-retry-title">
        <form class="yc-dialog__body" onSubmit={retry}>
          <h2 id="cn-retry-title">Повторить отправку?</h2>
          <p>{target?.title}</p>
          <label class="yc-field"><span class="yc-field__label">Причина</span>
            <input class="yc-input" value={reason} maxlength={500} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </label>
          {dlgError && <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dlg.current?.close()}>Не повторять</button>
            <button class="yc-btn" type="submit" disabled={busy}>Повторить отправку</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

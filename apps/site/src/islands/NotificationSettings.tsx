// Блок «Уведомления» в ЛК (09 §5, K9 /me/notification-settings, Web Push S1-15).
// Два переключателя: «Напоминания» и «Реклама»; сервисные сообщения приходят всегда. Каждое изменение – PUT
// с новым Idempotency-Key; ошибка возвращает переключатель и пишет причину. Разрешение браузера – только
// по нажатию кнопки (enablePush), состояние браузера показываем фразой, а не цветом.
import { useEffect, useState } from 'preact/hooks';
import { disablePush, enablePush, pushState, saveNotificationSettings, type PushState } from '../lib/push.ts';

interface Props {
  remindersEnabled: boolean;
  marketingEnabled: boolean;
}

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'Этот браузер не умеет показывать уведомления. Записи и их изменения всегда видны здесь, в личном кабинете.',
  not_configured: 'Уведомления в браузере пока недоступны. Записи и их изменения всегда видны здесь, в личном кабинете.',
  denied: 'Уведомления для сайта запрещены в настройках браузера. Разрешите их для этого сайта и обновите страницу.',
  off: 'Уведомления в этом браузере выключены.',
  on: 'Уведомления в этом браузере включены.',
};

export default function NotificationSettings(props: Props) {
  const [prefs, setPrefs] = useState({ remindersEnabled: props.remindersEnabled, marketingEnabled: props.marketingEnabled });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');

  useEffect(() => {
    pushState()
      .then(setPush)
      .catch(() => setPush('not_configured'));
  }, []);

  async function change(key: 'remindersEnabled' | 'marketingEnabled', value: boolean) {
    const before = prefs;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    setSaving(true);
    setError('');
    try {
      const saved = await saveNotificationSettings(next);
      setPrefs({ remindersEnabled: saved.remindersEnabled, marketingEnabled: saved.marketingEnabled });
    } catch {
      setPrefs(before);
      setError('Не удалось сохранить настройку. Проверьте связь и попробуйте ещё раз.');
    } finally {
      setSaving(false);
    }
  }

  async function togglePush(on: boolean) {
    setPushBusy(true);
    setPushError('');
    try {
      setPush(on ? await enablePush() : await disablePush());
    } catch {
      setPushError(on ? 'Не удалось включить уведомления. Попробуйте ещё раз.' : 'Не удалось выключить уведомления. Попробуйте ещё раз.');
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <section class="yu-account__block" aria-labelledby="notif-title" data-testid="notifications">
      <h2 id="notif-title">Уведомления</h2>
      <p class="yu-body">Подтверждение, перенос и отмена записи клубом приходят всегда – их отключить нельзя.</p>
      <label class="yu-check">
        <input
          type="checkbox"
          checked={prefs.remindersEnabled}
          disabled={saving}
          onChange={(e) => void change('remindersEnabled', (e.target as HTMLInputElement).checked)}
        />
        <span>Напоминания о сеансе – накануне в 21:00 и за 15 минут до начала</span>
      </label>
      <label class="yu-check">
        <input
          type="checkbox"
          checked={prefs.marketingEnabled}
          disabled={saving}
          onChange={(e) => void change('marketingEnabled', (e.target as HTMLInputElement).checked)}
        />
        <span>Реклама и акции – согласен получать рекламные сообщения</span>
      </label>
      <p class="yu-alert" role="alert">{error}</p>

      <div class="yu-account__push">
        <p role="status" data-testid="push-state">{push === null ? 'Проверяем браузер…' : PUSH_TEXT[push]}</p>
        {push === 'off' && (
          <button class="yu-btn" type="button" disabled={pushBusy} onClick={() => void togglePush(true)}>
            Включить уведомления в браузере
          </button>
        )}
        {push === 'on' && (
          <button class="yu-btn yu-btn--ghost" type="button" disabled={pushBusy} onClick={() => void togglePush(false)}>
            Выключить в этом браузере
          </button>
        )}
        <p class="yu-alert" role="alert">{pushError}</p>
      </div>
    </section>
  );
}

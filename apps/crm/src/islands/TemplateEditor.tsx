// Шаблоны сообщений (S4-82; K21 §8, K11 №210–211). Видят все с notifications.view, правит только Владелец
// (notifications.templates.manage, цель – сеть): у остальных нет ни кнопок, ни полей. Подстановки – белый список K21 §8,
// неизвестная – 422 TEMPLATE_PLACEHOLDER_UNKNOWN, ошибка у того поля, где она стоит. Архив вместо удаления; правка –
// по rowVersion (VERSION_CONFLICT – обновить), один ключ идемпотентности на попытку. Созданные рассылки правка не меняет.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { CATEGORY_LABEL, PLACEHOLDERS, notificationError, type CampaignCategory, type TemplateDto } from '../lib/notifications.ts';

export interface TemplateEditorProps {
  initial: TemplateDto[];
  canManage: boolean;
}
interface Form { id: string | null; name: string; category: CampaignCategory; title: string; body: string; rowVersion: number }
const EMPTY: Form = { id: null, name: '', category: 'service', title: '', body: '', rowVersion: 0 };
const RE = /\{([^{}]*)\}/g;
const unknownIn = (t: string) => [...t.matchAll(RE)].some((m) => !(PLACEHOLDERS as readonly string[]).includes(m[1]!)) || /[{}]/.test(t.replace(RE, ''));

export default function TemplateEditor({ initial, canManage }: TemplateEditorProps) {
  const [items, setItems] = useState(initial);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef('');
  const lock = useRef(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (form) first.current?.focus();
  }, [form?.id, form === null]);

  const reload = async () => setItems((await browserCall<{ items: TemplateDto[] }>('/notifications/templates')).items);
  const edit = (t: TemplateDto | null) => {
    setForm(t ? { id: t.id, name: t.name, category: t.category, title: t.title, body: t.body, rowVersion: t.rowVersion } : { ...EMPTY });
    setErrors({});
    setError('');
    setNotice('');
    key.current = crypto.randomUUID();
  };
  const field = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setErrors((e) => ({ ...e, [k]: '' }));
  };
  const call = async (fn: () => Promise<unknown>, ok: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(ok);
      setForm(null);
      await reload();
    } catch (e) {
      const msg = notificationError(e);
      if (e instanceof ApiError && e.code === 'TEMPLATE_PLACEHOLDER_UNKNOWN' && form) {
        setErrors(unknownIn(form.title) ? { title: msg } : { body: msg });
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        const issues = (e.details?.issues as Array<{ path: string }> | undefined) ?? [];
        setErrors(Object.fromEntries(issues.map((i) => [i.path, 'Заполните поле (до 120 символов, текст – до 500).'])));
      }
      setError(msg);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const save = (e: Event) => {
    e.preventDefault();
    if (!form) return;
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = 'Заполните название.';
    if (!form.title.trim()) local.title = 'Заполните заголовок.';
    if (!form.body.trim()) local.body = 'Заполните текст.';
    if (Object.keys(local).length) return setErrors(local);
    const body = { name: form.name.trim(), title: form.title.trim(), body: form.body.trim() };
    void call(
      () => (form.id
        ? browserCall(`/notifications/templates/${encodeURIComponent(form.id)}`, { method: 'PATCH', body: { ...body, rowVersion: form.rowVersion }, key: key.current })
        : browserCall('/notifications/templates', { method: 'POST', body: { ...body, category: form.category }, key: key.current })),
      form.id ? 'Шаблон сохранён. Уже созданные сообщения не изменились.' : 'Шаблон создан.',
    );
  };
  const toggle = (t: TemplateDto) => {
    key.current = crypto.randomUUID();
    void call(
      () => browserCall(`/notifications/templates/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { rowVersion: t.rowVersion, status: t.status === 'active' ? 'archived' : 'active' }, key: key.current }),
      t.status === 'active' ? 'Шаблон в архиве: в новых сообщениях его не выбрать.' : 'Шаблон снова доступен.',
    );
  };

  const inv = (k: string) => (errors[k] ? { 'aria-invalid': 'true' as const, 'aria-describedby': `tpl-${k}-err` } : {});
  const err = (k: string) => (errors[k] ? <span class="yc-field__error" id={`tpl-${k}-err`}>{errors[k]}</span> : null);
  return (
    <div class="yc-list" data-testid="templates">
      {!canManage && <p class="yc-field__hint" data-testid="tpl-readonly">Шаблоны настраивает Владелец. Выбрать шаблон можно в форме нового сообщения.</p>}
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
      {canManage && !form && <div class="yc-eq__actions"><button class="yc-btn" type="button" onClick={() => edit(null)}>Новый шаблон</button></div>}
      {form && (
        <section class="yc-panel" aria-labelledby="tpl-form-title">
          <h2 id="tpl-form-title">{form.id ? 'Изменить шаблон' : 'Новый шаблон'}</h2>
          <form class="yc-form yc-form--wide" onSubmit={save} noValidate>
            <label class="yc-field"><span class="yc-field__label">Название</span>
              <input ref={first} class="yc-input" name="name" value={form.name} maxlength={120} {...inv('name')} onInput={(e) => field('name', (e.target as HTMLInputElement).value)} />{err('name')}
            </label>
            <label class="yc-field"><span class="yc-field__label">Категория</span>
              <select class="yc-input" name="category" value={form.category} disabled={form.id !== null} onChange={(e) => field('category', (e.target as HTMLSelectElement).value as CampaignCategory)}>
                <option value="service">{CATEGORY_LABEL.service}</option><option value="marketing">{CATEGORY_LABEL.marketing}</option>
              </select>
              {form.id && <span class="yc-field__hint">Категорию шаблона не меняют: заведите новый.</span>}
            </label>
            <label class="yc-field"><span class="yc-field__label">Заголовок</span>
              <input class="yc-input" name="title" value={form.title} maxlength={120} {...inv('title')} onInput={(e) => field('title', (e.target as HTMLInputElement).value)} />{err('title')}
            </label>
            <label class="yc-field"><span class="yc-field__label">Текст</span>
              <textarea class="yc-input" name="body" rows={4} value={form.body} maxlength={500} {...inv('body')} onInput={(e) => field('body', (e.target as HTMLTextAreaElement).value)} />
              <span class="yc-field__hint">Подстановки: {PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}. Другие в фигурных скобках не сохранятся.</span>{err('body')}
            </label>
            {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
            <div class="yc-eq__actions">
              <button class="yc-btn" type="submit" disabled={busy}>Сохранить шаблон</button>
              <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setForm(null)}>Не сохранять</button>
            </div>
          </form>
        </section>
      )}
      {!form && error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      <section class="yc-panel" aria-label="Шаблоны">
        {items.length === 0 ? (
          <p class="yc-empty">Шаблонов пока нет.{canManage ? ' Создайте первый – им смогут пользоваться все, у кого есть право отправки.' : ''}</p>
        ) : (
          <ul class="yc-eq__rows">
            {items.map((t) => (
              <li class="yc-eq__row" data-testid={`tpl-${t.id}`}>
                <strong>{t.name}</strong>
                <span>{CATEGORY_LABEL[t.category]}{t.status === 'archived' ? ' · в архиве' : ''}</span>
                <span>{t.title}</span>
                <span class="yc-field__hint">{t.body}</span>
                {canManage && (
                  <div class="yc-eq__actions">
                    <button class="yc-btn yc-btn--ghost" type="button" onClick={() => edit(t)}>Изменить</button>
                    <button class="yc-btn yc-btn--ghost" type="button" disabled={busy} onClick={() => toggle(t)}>{t.status === 'active' ? 'В архив' : 'Вернуть из архива'}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

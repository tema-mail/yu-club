// Переключатель контекста сеть / город / филиал (S0-14).
// Перед сменой проверяет несохранённые формы: любая <form data-guard> после ввода получает data-dirty="true".
// Есть такие – окно подтверждения; уход со страницы другими путями ловит beforeunload.
import { useEffect, useRef, useState } from 'preact/hooks';

export interface ContextGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

interface Props {
  groups: ContextGroup[];
  current: string;
}

const CTX_COOKIE = 'yu_ctx';

function isDirty(): boolean {
  return document.querySelector('form[data-guard][data-dirty="true"]') !== null;
}

function markAllClean(): void {
  for (const f of document.querySelectorAll('form[data-guard]')) f.removeAttribute('data-dirty');
}

function go(value: string): void {
  document.cookie = `${CTX_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Strict; Max-Age=31536000`;
  markAllClean();
  location.assign(value.startsWith('branch:') ? `/branches/${encodeURIComponent(value.slice(7))}` : '/');
}

export default function ContextSwitcher({ groups, current }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onInput = (e: Event) => {
      const form = (e.target as Element | null)?.closest?.('form[data-guard]');
      if (form) form.setAttribute('data-dirty', 'true');
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) e.preventDefault();
    };
    document.addEventListener('input', onInput);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('input', onInput);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const onChange = (e: Event) => {
    const select = e.currentTarget as HTMLSelectElement;
    const value = select.value;
    if (value === current) return;
    if (!isDirty()) {
      go(value);
      return;
    }
    select.value = current; // до подтверждения контекст не меняется
    setPending(value);
    dialog.current?.showModal();
  };

  const stay = () => {
    dialog.current?.close();
    setPending(null);
  };

  const confirm = () => {
    if (pending) go(pending);
  };

  const pendingLabel = groups.flatMap((g) => g.options).find((o) => o.value === pending)?.label;

  return (
    <div class="yc-ctx">
      <label class="yc-ctx__label" for="ctx-select">Контекст</label>
      <select id="ctx-select" class="yc-input" value={current} onChange={onChange}>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="ctx-dirty-title" onClose={() => setPending(null)}>
        <div class="yc-dialog__body">
          <h2 id="ctx-dirty-title">Несохранённые изменения</h2>
          <p>
            На этой странице есть несохранённые изменения. Если перейти в «{pendingLabel ?? 'другой контекст'}», они
            пропадут.
          </p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={stay} autofocus>
              Остаться
            </button>
            <button type="button" class="yc-btn yc-btn--danger" onClick={confirm}>
              Сменить без сохранения
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

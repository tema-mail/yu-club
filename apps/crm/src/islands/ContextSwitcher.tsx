// Переключатель контекста сеть / город / филиал (S0-14).
// Перед сменой проверяет несохранённые формы: <form data-guard>, у которой значение поля отличается от исходного.
// Сравнение значений, а не слежка за вводом: не зависит от того, успел ли остров ожить до первого ввода.
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
let leaving = false; // своё подтверждённое переключение – beforeunload не спрашивает второй раз

function formDirty(form: HTMLFormElement): boolean {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio' ? el.checked !== el.defaultChecked : el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      if (Array.from(el.options).some((o) => o.selected !== o.defaultSelected)) return true;
    }
  }
  return false;
}

function isDirty(): boolean {
  return Array.from(document.querySelectorAll<HTMLFormElement>('form[data-guard]')).some(formDirty);
}

function go(value: string): void {
  document.cookie = `${CTX_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Strict; Max-Age=31536000`;
  leaving = true;
  location.assign(value.startsWith('branch:') ? `/branches/${encodeURIComponent(value.slice(7))}` : '/');
}

export default function ContextSwitcher({ groups, current }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null); // клик может прийти раньше перерисовки, а событие close – позже нового showModal
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!leaving && isDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
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
    pendingRef.current = value;
    setPending(value);
    dialog.current?.showModal();
  };

  const stay = () => {
    pendingRef.current = null;
    setPending(null);
    dialog.current?.close();
  };

  const confirm = () => {
    if (pendingRef.current) go(pendingRef.current);
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
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="ctx-dirty-title">
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

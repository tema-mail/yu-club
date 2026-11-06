// Общие детали экранов мероприятия: окно внутри записи и окно с обязательной причиной (правило владельца: удаление и отмена – только
// окном внутри записи). Вкладкам нужна одна форма повторного чтения карточки – EventTabProps.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { eventError, type EventCardDto } from '../lib/events.ts';

export interface EventTabProps {
  card: EventCardDto;
  actions: string[];
  staff: Array<{ id: string; name: string }>;
  /** Перечитать карточку после команды; notice – что показать сверху. */
  onChanged: (notice?: string) => Promise<void>;
}

export function Modal(p: { open: boolean; onClose: () => void; title: string; wide?: boolean; testId?: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (p.open && !d.open) d.showModal();
    if (!p.open && d.open) d.close();
  }, [p.open]);
  return (
    <dialog ref={ref} class={`yc-dialog${p.wide ? ' yc-dialog--wide' : ''}`} aria-label={p.title} data-testid={p.testId} onClose={p.onClose}>
      {p.open && <div class="yc-dialog__body"><h2>{p.title}</h2>{p.children}</div>}
    </dialog>
  );
}

/** Окно действия с причиной: пустая причина не уходит на сервер; ошибка – внутри окна; один ключ на попытку. */
export function ReasonDialog(p: {
  open: boolean; title: string; text?: ComponentChildren; label: string; confirm: string; danger?: boolean; testId?: string;
  onClose: () => void; onConfirm: (reason: string, key: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (p.open) {
      setReason('');
      setError('');
      key.current = crypto.randomUUID();
    }
  }, [p.open]);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!reason.trim()) return setError('Укажите причину – без неё не сохранить.');
    setBusy(true);
    setError('');
    try {
      await p.onConfirm(reason.trim(), key.current);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={p.open} onClose={p.onClose} title={p.title} testId={p.testId}>
      <form class="yc-ev__stack" novalidate onSubmit={submit}>
        {p.text && <div class="yc-ev__stack">{p.text}</div>}
        <label class="yc-field"><span class="yc-field__label">{p.label}</span>
          <textarea class="yc-input" rows={3} maxLength={2000} value={reason} onInput={(e) => setReason(e.currentTarget.value)} /></label>
        {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
        <div class="yc-dialog__actions">
          <button class="yc-btn yc-btn--ghost" type="button" onClick={p.onClose}>Назад</button>
          <button class={`yc-btn${p.danger ? ' yc-btn--danger' : ''}`} type="submit" disabled={busy}>{p.confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

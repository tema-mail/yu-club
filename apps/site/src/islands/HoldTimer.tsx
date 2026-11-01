// Таймер удержания (S1-19, 01 §7.4): считает до deadline в шкале performance.now() – её задаёт holdDeadline() из
// expiresAt и serverNow ответа API, поэтому перевод часов браузера таймер не меняет. Новый deadline (добавили слот –
// сервер перезапустил таймер) начинает отсчёт заново. Закрытие вкладки ничего не продлевает: срок живёт на сервере.
import { useEffect, useState } from 'preact/hooks';
import { EXPIRING_MS, mmss, msLeft } from '../lib/booking.ts';

interface Props {
  deadline: number;
  onPhase: (phase: 'held' | 'expiring') => void;
  onExpire: () => void;
}

export default function HoldTimer({ deadline, onPhase, onExpire }: Props) {
  const [left, setLeft] = useState(() => msLeft(deadline));

  useEffect(() => {
    let phase: 'held' | 'expiring' | 'done' | null = null;
    const tick = () => {
      const ms = msLeft(deadline);
      setLeft(ms);
      const next = ms <= 0 ? 'done' : ms <= EXPIRING_MS ? 'expiring' : 'held';
      if (next === phase) return;
      phase = next;
      if (next === 'done') onExpire();
      else onPhase(next);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline]); // перезапуск – только по новому сроку; обработчики острова читают состояние через ref, старое замыкание им не мешает

  return (
    <p class={`yu-timer${left <= EXPIRING_MS ? ' yu-timer--soon' : ''}`}>
      Время закреплено ещё <span role="timer" aria-live="off" data-testid="hold-timer">{mmss(left)}</span>
    </p>
  );
}

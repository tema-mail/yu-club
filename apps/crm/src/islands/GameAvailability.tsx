// S4-86: доступность игры по филиалам (K11 №220; 12 §6.1): оперативный факт филиала, не версионируется – сохраняется сразу.
// Без строки игра в филиале недоступна. Директор меняет только филиалы своей зоны (content.catalog.availability), Администратор видит.
import { useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { errorText, type BranchRef } from '../lib/content.tsx';

interface Row { available: boolean; note: string; saved: boolean; msg: { ok: boolean; text: string } | null }

export default function GameAvailability(props: { gameId: string; branches: BranchRef[]; initial: Array<{ branchId: string; available: boolean; note: string | null }>; canEdit: boolean }) {
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(props.branches.map((b) => {
      const r = props.initial.find((x) => x.branchId === b.id);
      return [b.id, { available: r?.available ?? false, note: r?.note ?? '', saved: true, msg: null }];
    })),
  );
  const [busy, setBusy] = useState('');
  const patch = (id: string, p: Partial<Row>) => setRows((all) => ({ ...all, [id]: { ...all[id]!, ...p } }));

  const save = async (b: BranchRef) => {
    const r = rows[b.id]!;
    if (r.note.trim().length > 120) return patch(b.id, { msg: { ok: false, text: 'Примечание – не длиннее 120 знаков.' } });
    setBusy(b.id);
    try {
      await browserCall(`/content/games/${props.gameId}/branches/${encodeURIComponent(b.id)}`, { method: 'PUT', body: { available: r.available, note: r.note.trim() || null } });
      patch(b.id, { saved: true, msg: { ok: true, text: r.available ? 'Сохранено: игра доступна, сайт покажет её в этом филиале.' : 'Сохранено: игра недоступна в этом филиале.' } });
    } catch (e) {
      patch(b.id, { msg: { ok: false, text: `Не сохранено: ${errorText(e)}` } });
    } finally {
      setBusy('');
    }
  };

  return (
    <section class="yc-ct__box" aria-labelledby="game-avail">
      <h2 id="game-avail">Где доступна</h2>
      <p class="yc-ct__muted">Отметка сохраняется сразу и не требует публикации. Филиал без отметки – игры там нет.</p>
      <ul class="yc-ct__avail" data-testid="game-avail">
        {props.branches.map((b) => {
          const r = rows[b.id]!;
          const multiCity = new Set(props.branches.map((x) => x.cityId)).size > 1;
          return (
            <li data-testid={`avail-${b.id}`}>
              <strong>{multiCity ? `${b.cityName} – ${b.name}` : b.name}</strong>
              <label class="yc-check"><input type="checkbox" checked={r.available} disabled={!props.canEdit} onChange={(e) => patch(b.id, { available: e.currentTarget.checked, saved: false, msg: null })} /> Доступна</label>
              <input class="yc-input" aria-label={`Примечание: ${b.name}`} placeholder="Примечание, например «только по выходным»" maxLength={120} value={r.note} disabled={!props.canEdit} onInput={(e) => patch(b.id, { note: e.currentTarget.value, saved: false, msg: null })} />
              {props.canEdit && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy === b.id || r.saved} onClick={() => void save(b)}>Сохранить</button>}
              {r.msg && <p class={`yc-alert ${r.msg.ok ? 'yc-alert--ok' : 'yc-alert--error'}`} role="status">{r.msg.text}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

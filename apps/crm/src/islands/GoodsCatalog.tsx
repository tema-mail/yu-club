// Товары за баллы (S2-66, K15 №26): каталог филиала с архивом, создание и правка карточки, архив вместо удаления.
// Цены в ₽ и в баллах – отдельные поля без пересчёта (07 §7.1). Менять – loyalty.goods.manage (Владелец, Директор);
// смотреть – loyalty.view. Выдача клиенту – в его карточке (бонусный счёт → «Выдать товар»): там видно, хватает ли баллов.
// Правка и архив – окном внутри записи; устаревшая карточка (VERSION_CONFLICT) – сообщение и перечитывание каталога.
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { ApiError } from '../lib/api.ts';
import { fmtPoints, fmtRub, loyaltyApi, loyaltyError, parsePoints, parseRub, type BranchGoods } from '../lib/loyalty.ts';

export interface GoodsCatalogProps {
  branch: { id: string; name: string };
  initial: BranchGoods[];
  canManage: boolean;
}

type Dialog = { kind: 'create' } | { kind: 'edit'; g: BranchGoods } | { kind: 'archive'; g: BranchGoods } | { kind: 'restore'; g: BranchGoods };
const pts = (centi: number) => String(centi / 100).replace('.', ',');
const rub = (kop: number | null) => (kop === null ? '' : String(kop / 100).replace('.', ','));

export default function GoodsCatalog({ branch, initial, canManage }: GoodsCatalogProps) {
  const [items, setItems] = useState<BranchGoods[]>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ name: '', description: '', rub: '', points: '', stock: '' });
  const ref = useRef<HTMLDialogElement>(null);

  const reload = async () => {
    try {
      setItems((await loyaltyApi.goods(branch.id)).items);
    } catch (e) {
      setNotice({ ok: false, text: `Не удалось обновить каталог: ${loyaltyError(e)}` });
    }
  };
  const close = () => {
    ref.current?.close();
    setDlg(null);
  };
  const open = (d: Dialog) => {
    setDlg(d);
    setErr('');
    const g = d.kind === 'create' ? null : d.g;
    setF({ name: g?.name ?? '', description: g?.description ?? '', rub: rub(g?.priceRubKop ?? null), points: g ? pts(g.pricePointsCenti) : '', stock: g?.stock === null || !g ? '' : String(g.stock) });
    ref.current?.showModal();
  };
  const run = async (op: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setNotice(null);
    try {
      await op();
      close();
      await reload();
      setNotice({ ok: true, text: ok });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        close();
        await reload();
        setNotice({ ok: false, text: loyaltyError(e) });
      } else setErr(loyaltyError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (!dlg) return;
    if (dlg.kind === 'archive') return void run(() => loyaltyApi.updateGoods(dlg.g.id, { rowVersion: dlg.g.rowVersion, status: 'archived' }), `«${dlg.g.name}» в архиве.`);
    if (dlg.kind === 'restore') return void run(() => loyaltyApi.updateGoods(dlg.g.id, { rowVersion: dlg.g.rowVersion, status: 'active' }), `«${dlg.g.name}» снова в каталоге.`);
    const name = f.name.trim();
    const points = parsePoints(f.points);
    const priceRubKop = f.rub.trim() === '' ? null : parseRub(f.rub);
    const stock = f.stock.trim() === '' ? null : /^\d+$/.test(f.stock.trim()) ? Number(f.stock.trim()) : NaN;
    if (!name) return setErr('Укажите название.');
    if (points === null || points <= 0) return setErr('Цена в баллах – число больше нуля, до двух знаков после запятой.');
    if (priceRubKop === null && f.rub.trim() !== '') return setErr('Цена в рублях – число, до двух знаков после запятой, или пусто.');
    if (Number.isNaN(stock)) return setErr('Остаток – целое число от 0 или пусто, если не ведётся.');
    const body = { name, description: f.description.trim() || null, priceRubKop, pricePointsCenti: points, branches: [{ branchId: branch.id, stock, active: true }] };
    if (dlg.kind === 'create') void run(() => loyaltyApi.createGoods(body), `Товар «${name}» добавлен.`);
    else void run(() => loyaltyApi.updateGoods(dlg.g.id, { ...body, rowVersion: dlg.g.rowVersion }), `Товар «${name}» сохранён.`);
  };
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value });
  const state = (g: BranchGoods) => (g.status === 'archived' ? 'В архиве' : g.available ? 'Выдаётся' : g.stock === 0 ? 'Закончился' : 'Не выдаётся');

  return (
    <section class="yc-panel" aria-labelledby="goods-title" data-testid="goods">
      <h2 id="goods-title">Каталог – {branch.name}</h2>
      <p class="yc-field__hint">Выдача – в карточке клиента: «Бонусный счёт» → «Выдать товар». Цены в рублях и в баллах не пересчитываются друг в друга.</p>
      <p class={`yc-alert ${notice ? (notice.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="goods-notice">{notice?.text ?? ''}</p>
      {canManage && <div class="yc-bk__actions"><button type="button" class="yc-btn" disabled={busy} onClick={() => open({ kind: 'create' })}>Новый товар…</button></div>}
      {items.length === 0 ? <p class="yc-empty">В этом филиале пока нет товаров за баллы.</p> : (
        <table class="yc-table" data-testid="goods-table">
          <thead><tr><th>Товар</th><th>Цена в баллах</th><th>Цена в кассе</th><th>Остаток</th><th>Состояние</th>{canManage && <th>Действия</th>}</tr></thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id}>
                <td class="yc-table__main" data-label="Товар">{g.name}{g.description ? <span class="yc-field__hint"> · {g.description}</span> : null}</td>
                <td data-label="Цена в баллах">{fmtPoints(g.pricePointsCenti)}</td>
                <td data-label="Цена в кассе">{fmtRub(g.priceRubKop)}</td>
                <td data-label="Остаток">{g.stock === null ? 'не ведётся' : `${g.stock} шт.`}</td>
                <td data-label="Состояние"><span class={`yc-badge${g.status === 'archived' ? ' yc-badge--archived' : g.available ? ' yc-badge--active' : ''}`}>{state(g)}</span></td>
                {canManage && (
                  <td data-label="Действия">
                    {g.status === 'active' ? (
                      <>
                        <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => open({ kind: 'edit', g })}>Изменить…</button>{' '}
                        <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={() => open({ kind: 'archive', g })}>В архив…</button>
                      </>
                    ) : <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => open({ kind: 'restore', g })}>Вернуть из архива…</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dialog ref={ref} class="yc-dialog" aria-labelledby="goods-dlg-title" onClose={() => setDlg(null)}>
        {dlg && (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="goods-dlg-title">{dlg.kind === 'create' ? 'Новый товар за баллы' : dlg.kind === 'edit' ? 'Изменить товар' : dlg.kind === 'archive' ? 'Убрать в архив?' : 'Вернуть из архива?'}</h2>
            {dlg.kind === 'archive' || dlg.kind === 'restore' ? (
              <dl class="yc-props yc-bk__diff" data-testid="before-after">
                <dt>Было</dt><dd>{dlg.g.name} · {dlg.kind === 'archive' ? 'в каталоге' : 'в архиве'}</dd>
                <dt>Станет</dt><dd><strong>{dlg.kind === 'archive' ? 'в архиве – не выдаётся, история выдач сохраняется' : 'снова в каталоге'}</strong></dd>
              </dl>
            ) : (
              <>
                <Field id="g-name" label="Название *"><input id="g-name" class="yc-input" maxLength={200} value={f.name} onInput={set('name')} /></Field>
                <Field id="g-desc" label="Описание (необязательно)"><input id="g-desc" class="yc-input" maxLength={2000} value={f.description} onInput={set('description')} /></Field>
                <Field id="g-points" label="Цена в баллах *"><input id="g-points" class="yc-input" inputMode="decimal" value={f.points} onInput={set('points')} /></Field>
                <Field id="g-rub" label="Цена в кассе, ₽ (необязательно)"><input id="g-rub" class="yc-input" inputMode="decimal" value={f.rub} onInput={set('rub')} /></Field>
                <Field id="g-stock" label={`Остаток в филиале «${branch.name}», шт. (пусто – не ведётся)`}><input id="g-stock" class="yc-input" inputMode="numeric" value={f.stock} onInput={set('stock')} /></Field>
              </>
            )}
            <p class="yc-alert yc-alert--error" role="alert">{err}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={close}>Не менять</button>
              <button type="submit" class={`yc-btn${dlg.kind === 'archive' ? ' yc-btn--danger' : ''}`} disabled={busy}>
                {dlg.kind === 'archive' ? 'В архив' : dlg.kind === 'restore' ? 'Вернуть' : 'Сохранить'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ComponentChildren }) {
  return (
    <div class="yc-field">
      <label class="yc-field__label" for={id}>{label}</label>
      {children}
    </div>
  );
}

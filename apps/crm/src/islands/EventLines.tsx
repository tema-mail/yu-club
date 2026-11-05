// Состав и пакет мероприятия (S3-82, K20 §3, №364, №370): строки с ценой для клиента, скидка с причиной, плановая себестоимость – только при
// event.money.view (сервер её просто не отдаёт). Удаление – окном внутри записи с причиной: строка остаётся видна со своей причиной. Пакет – шаблон:
// применение копирует строки, правка заказа шаблон не меняет. Цену и скидку меняет event.price.manage; без него – цена шаблона или 0 ₽.
// Суммы – целые копейки: «1 234,50» ↔ 123450 без дробной арифметики, количество – в сотых.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import {
  LINE_KIND, eventError, fullMoney, hundredthsOf, isClosed, kopOf, kopText, lineTotal, lineTotalKop, qtyText,
  type EventLine, type EventPackage, type LineKind,
} from '../lib/events.ts';
import { rub } from './CashJournal.tsx';
import { Modal, ReasonDialog, type EventTabProps } from './EventParts.tsx';

const EMPTY = { kind: 'service' as LineKind, name: '', qty: '1', unit: 'шт', price: '0', discount: '0', discountReason: '', plan: '', supplier: '', comment: '' };

export default function EventLines(p: EventTabProps) {
  const c = p.card;
  const [packs, setPacks] = useState<EventPackage[]>([]);
  const [packId, setPackId] = useState('');
  const [editing, setEditing] = useState<EventLine | 'new' | null>(null);
  const [removing, setRemoving] = useState<EventLine | null>(null);
  const [applying, setApplying] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const canEdit = p.actions.includes('event.manage') && !isClosed(c.status);
  const canPrice = p.actions.includes('event.price.manage');
  const seesPlan = fullMoney(c.money);
  const active = c.lines.filter((l) => l.status === 'active');
  const removed = c.lines.filter((l) => l.status === 'removed');
  const agreed = active.reduce((a, l) => a + lineTotal(l), 0);
  const pack = packs.find((x) => x.id === packId);

  useEffect(() => {
    browserCall<{ items: EventPackage[] }>(`/event-packages?typeId=${c.typeId}`).then((r) => {
      setPacks(r.items);
      setPackId(r.items[0]?.id ?? '');
    }, () => setPacks([]));
  }, [c.typeId]);

  const open = (l: EventLine | 'new') => {
    setEditing(l);
    setError('');
    key.current = crypto.randomUUID();
    setF(l === 'new' ? EMPTY : {
      kind: l.kind, name: l.name, qty: qtyText(l.quantity), unit: l.unit, price: kopText(l.priceKop), discount: kopText(l.discountKop), discountReason: l.discountReason ?? '',
      plan: l.planCostKop === null || l.planCostKop === undefined ? '' : kopText(l.planCostKop), supplier: l.supplier ?? '', comment: l.comment ?? '',
    });
  };
  const set = (k: keyof typeof EMPTY) => (e: { currentTarget: { value: string } }) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  const q100 = hundredthsOf(f.qty);
  const priceKop = kopOf(f.price);
  const discountKop = kopOf(f.discount);
  const preview = q100 !== null && priceKop !== null && discountKop !== null ? lineTotalKop(q100, priceKop, discountKop) : null;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || !editing) return;
    if (!f.name.trim()) return setError('Укажите название строки.');
    if (q100 === null) return setError('Количество – больше нуля, до двух знаков после запятой.');
    if (priceKop === null) return setError('Цена – в рублях, например 1500 или 1500,50.');
    if (discountKop === null) return setError('Скидка – в рублях, например 200.');
    if (discountKop > 0 && !f.discountReason.trim()) return setError('Укажите причину скидки.');
    if (preview !== null && preview < 0) return setError('Скидка больше стоимости строки.');
    const plan = f.plan.trim() === '' ? null : kopOf(f.plan);
    if (f.plan.trim() !== '' && plan === null) return setError('Плановая себестоимость – в рублях.');
    const body: Record<string, unknown> = {
      kind: f.kind, name: f.name.trim(), quantity: q100 / 100, unit: f.unit.trim() || 'шт', supplier: f.supplier.trim() || null, comment: f.comment.trim() || null,
      ...(canPrice || editing === 'new' ? { priceKop, discountKop, discountReason: f.discountReason.trim() || null } : {}),
      ...(seesPlan || editing === 'new' ? { planCostKop: seesPlan ? plan : null } : {}),
    };
    setBusy(true);
    setError('');
    try {
      if (editing === 'new') await browserCall(`/events/${c.id}/lines`, { method: 'POST', key: key.current, body });
      else await browserCall(`/event-lines/${editing.id}`, { method: 'PATCH', key: key.current, body: { ...body, rowVersion: editing.rowVersion } });
      setEditing(null);
      await p.onChanged('Состав сохранён.');
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
      await p.onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const applyPackage = async () => {
    if (busy || !pack) return;
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}/apply-package`, { method: 'POST', key: key.current, body: { packageId: pack.id } });
      setApplying(false);
      await p.onChanged(`Пакет «${pack.name}» применён: строки скопированы, шаблон не изменился.`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="yc-ev__headline">
        <p><strong>Согласованная стоимость: <span data-testid="lines-total">{rub(agreed)}</span></strong></p>
        {canEdit && <button class="yc-btn" type="button" onClick={() => open('new')}>Добавить строку</button>}
      </div>
      {!canPrice && canEdit && <p class="yc-field__hint">Цену и скидку задают Директор и Владелец. Вы добавляете строки без цены или применяете пакет – цена придёт из него.</p>}
      {canEdit && packs.length > 0 && (
        <div class="yc-ev__row" data-testid="package-apply">
          <label class="yc-field"><span class="yc-field__label">Пакет услуг</span>
            <select class="yc-input" value={packId} onChange={(e) => setPackId(e.currentTarget.value)}>{packs.map((x) => <option value={x.id}>{x.name}{x.approxPriceKop !== null ? ` – около ${rub(x.approxPriceKop)}` : ''}</option>)}</select></label>
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => { key.current = crypto.randomUUID(); setError(''); setApplying(true); }}>Применить…</button>
        </div>
      )}
      {active.length === 0 ? <p class="yc-empty">Состав пока пуст. Без него мероприятие нельзя подтвердить.</p> : (
        <table class="yc-table" data-testid="event-lines">
          <thead><tr><th>Позиция</th><th>Количество</th><th>Цена</th><th>Скидка</th><th>Сумма</th>{seesPlan && <th>План. себестоимость</th>}<th>Поставщик</th><th /></tr></thead>
          <tbody>
            {active.map((l) => (
              <tr key={l.id} data-testid={`line-${l.name}`}>
                <td data-label={LINE_KIND[l.kind]} class="yc-table__main">{l.name}</td>
                <td data-label="Количество">{qtyText(l.quantity)} {l.unit}</td>
                <td data-label="Цена">{rub(l.priceKop)}</td>
                <td data-label="Скидка">{l.discountKop > 0 ? `${rub(l.discountKop)} (${l.discountReason})` : '–'}</td>
                <td data-label="Сумма">{rub(lineTotal(l))}</td>
                {seesPlan && <td data-label="План. себестоимость" data-testid="line-plan">{l.planCostKop === null || l.planCostKop === undefined ? '–' : rub(l.planCostKop)}</td>}
                <td data-label="Поставщик">{l.supplier ?? '–'}</td>
                <td>{canEdit && <button class="yc-btn yc-btn--ghost" type="button" aria-label={`Открыть строку ${l.name}`} onClick={() => open(l)}>Открыть</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removed.length > 0 && (
        <details class="yc-ev__removed" open data-testid="lines-removed">
          <summary>Удалённые строки: {removed.length}</summary>
          <ul class="yc-history">{removed.map((l) => <li class="yc-history__item" key={l.id}><span class="yc-history__head">{l.name}</span><span>Причина: {l.removedReason}</span></li>)}</ul>
        </details>
      )}

      <Modal open={editing !== null} wide title={editing === 'new' ? 'Новая строка состава' : 'Строка состава'} onClose={() => setEditing(null)} testId="line-dialog">
        <form class="yc-ev__stack" novalidate onSubmit={submit}>
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Вид</span><select class="yc-input" value={f.kind} onChange={set('kind')}>{(Object.keys(LINE_KIND) as LineKind[]).map((k) => <option value={k}>{LINE_KIND[k]}</option>)}</select></label>
            <label class="yc-field"><span class="yc-field__label">Название</span><input class="yc-input" type="text" maxLength={200} value={f.name} onInput={set('name')} /></label>
            <div class="yc-ev__row">
              <label class="yc-field"><span class="yc-field__label">Количество</span><input class="yc-input" type="text" inputMode="decimal" value={f.qty} onInput={set('qty')} /></label>
              <label class="yc-field"><span class="yc-field__label">Единица</span><input class="yc-input" type="text" maxLength={30} value={f.unit} onInput={set('unit')} /></label>
            </div>
            <label class="yc-field"><span class="yc-field__label">Цена за единицу, ₽</span><input class="yc-input" type="text" inputMode="decimal" readOnly={!canPrice} value={f.price} onInput={set('price')} /></label>
            {canPrice && (
              <>
                <label class="yc-field"><span class="yc-field__label">Скидка, ₽</span><input class="yc-input" type="text" inputMode="decimal" value={f.discount} onInput={set('discount')} /></label>
                <label class="yc-field"><span class="yc-field__label">Причина скидки</span><input class="yc-input" type="text" maxLength={2000} value={f.discountReason} onInput={set('discountReason')} /></label>
              </>
            )}
            {seesPlan && <label class="yc-field"><span class="yc-field__label">Плановая себестоимость, ₽</span><input class="yc-input" type="text" inputMode="decimal" value={f.plan} onInput={set('plan')} /></label>}
            <label class="yc-field"><span class="yc-field__label">Поставщик</span><input class="yc-input" type="text" maxLength={200} value={f.supplier} onInput={set('supplier')} /></label>
            <label class="yc-field yc-ev__wide"><span class="yc-field__label">Комментарий</span><input class="yc-input" type="text" maxLength={2000} value={f.comment} onInput={set('comment')} /></label>
          </div>
          <p data-testid="line-preview">Сумма строки: {preview === null ? '–' : rub(preview)}</p>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setEditing(null)}>Назад</button>
            {editing !== 'new' && editing && <button class="yc-btn yc-btn--danger-text" type="button" onClick={() => { setRemoving(editing); setEditing(null); }}>Удалить…</button>}
            <button class="yc-btn" type="submit" disabled={busy}>Сохранить</button>
          </div>
        </form>
      </Modal>

      <Modal open={applying} title={`Применить пакет «${pack?.name ?? ''}»?`} onClose={() => setApplying(false)} testId="package-dialog">
        <p>В состав добавятся строки шаблона. Дальнейшая правка заказа шаблон не меняет.</p>
        <ul class="yc-history">{pack?.lines.map((l, i) => <li class="yc-history__item" key={i}>{l.name}: {qtyText(l.quantity)} {l.unit} × {rub(l.priceKop)}</li>)}</ul>
        {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
        <div class="yc-dialog__actions">
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setApplying(false)}>Назад</button>
          <button class="yc-btn" type="button" disabled={busy} onClick={applyPackage}>Применить</button>
        </div>
      </Modal>

      <ReasonDialog open={removing !== null} title={`Удалить «${removing?.name ?? ''}» из состава?`} label="Причина удаления" confirm="Удалить из состава" danger testId="line-remove"
        text={<p>Строка уйдёт из суммы, но останется в карточке с причиной. Связанные расходы и история не меняются.</p>} onClose={() => setRemoving(null)}
        onConfirm={async (reason, k) => {
          await browserCall(`/event-lines/${removing!.id}/remove`, { method: 'POST', key: k, body: { rowVersion: removing!.rowVersion, reason } });
          setRemoving(null);
          await p.onChanged('Строка удалена из состава.');
        }} />
    </>
  );
}

// Справочники Э3 (S3-86): категории оборудования (K19 №337), типы и пакеты мероприятий (K20 №370), исполнители ремонта (K19 §6). Запись открывается окном; удаления
// нет: внутри записи окно «Убрать» предлагает «В архив», архив – отдельным разделом, оттуда запись возвращается. Системный тип праздника сервер архивировать не даёт.
// Право – из /me: без него только просмотр. Пакет – шаблон: правка не меняет уже оформленные мероприятия (K20 §3). Суммы – копейки ↔ рубли целыми.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { LINE_KIND, eventError, hundredthsOf, kopOf, kopText, qtyText, type EventPackage, type EventType, type LineKind, type PackageLine } from '../lib/events.ts';
import { rub } from './CashJournal.tsx';
import { Modal } from './EventParts.tsx';

export type DictE3Kind = 'equipment-categories' | 'event-types' | 'event-packages' | 'repair-executors';
export interface DictE3Props {
  kind: DictE3Kind;
  canEdit: boolean;
  /** Показывать плановую себестоимость в строках пакета (сервер отдаёт её только при event.money.view). */
  seesPlan: boolean;
}

type Row = { id: string; name: string; status: 'active' | 'archived'; rowVersion?: number; [k: string]: unknown };
const EXECUTOR_KIND: Record<string, string> = { staff: 'Сотрудник', contractor: 'Подрядчик', service_center: 'Сервисный центр', manufacturer: 'Производитель' };
const META: Record<DictE3Kind, { path: string; one: string; list: string; query: string }> = {
  'equipment-categories': { path: '/equipment-categories', one: 'Категория', list: 'Категорий', query: '' },
  'event-types': { path: '/event-types', one: 'Тип', list: 'Типов', query: '' },
  'event-packages': { path: '/event-packages', one: 'Пакет', list: 'Пакетов', query: '?includeArchived=true' },
  'repair-executors': { path: '/repair-executors', one: 'Исполнитель', list: 'Исполнителей', query: '?includeArchived=true' },
};
const SYSTEM_TYPES = new Set(['birthday_party', 'birthday']);
interface LineDraft { kind: LineKind; name: string; qty: string; unit: string; price: string; plan: string }
const newLine = (): LineDraft => ({ kind: 'service', name: '', qty: '1', unit: 'шт', price: '0', plan: '' });

export default function DictE3(p: DictE3Props) {
  const meta = META[p.kind];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [types, setTypes] = useState<EventType[]>([]);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Row | 'new' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  // Запись закрывается событием close асинхронно: при переходе в окно «Убрать» она должна остаться выбранной
  const toConfirm = useRef(false);
  const load = async () => {
    try {
      const r = await browserCall<{ items: Row[] }>(`${meta.path}${meta.query}`);
      setRows(r.items);
    } catch (err) {
      setError(eventError(err));
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    if (p.kind === 'event-packages') browserCall<{ items: EventType[] }>('/event-types').then((r) => setTypes(r.items.filter((t) => t.status === 'active')), () => setTypes([]));
  }, [p.kind]);
  const shown = (rows ?? []).filter((r) => r.status === view && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const set = (k: string) => (e: { currentTarget: { value: string } }) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  const isSystem = (r: Row | 'new' | null) => p.kind === 'event-types' && r && r !== 'new' && SYSTEM_TYPES.has(String(r.code));

  const openRow = (r: Row | 'new') => {
    setOpen(r);
    setError('');
    setConfirm(false);
    key.current = crypto.randomUUID();
    if (r === 'new') {
      setF({ kind: 'contractor', typeId: types[0]?.id ?? '' });
      setLines([newLine()]);
      return;
    }
    const pack = r as unknown as EventPackage;
    setF({
      name: r.name, code: String(r.code ?? ''), sortOrder: String(r.sortOrder ?? ''), kind: String(r.kind ?? ''), contactPerson: String(r.contactPerson ?? ''), phone: String(r.phone ?? ''), email: String(r.email ?? ''),
      comment: String(r.comment ?? ''), approx: pack.approxPriceKop === null || pack.approxPriceKop === undefined ? '' : kopText(pack.approxPriceKop),
    });
    setLines(p.kind === 'event-packages' ? pack.lines.map((l) => ({ kind: l.kind, name: l.name, qty: qtyText(l.quantity), unit: l.unit, price: kopText(l.priceKop), plan: l.planCostKop === null || l.planCostKop === undefined ? '' : kopText(l.planCostKop) })) : []);
  };
  function linesBody(): PackageLine[] | string {
    const out: PackageLine[] = [];
    for (const [i, l] of lines.entries()) {
      const q100 = hundredthsOf(l.qty);
      const price = kopOf(l.price);
      const plan = l.plan.trim() === '' ? null : kopOf(l.plan);
      if (!l.name.trim()) return `Строка ${i + 1}: укажите название.`;
      if (q100 === null) return `Строка ${i + 1}: количество больше нуля, до двух знаков.`;
      if (price === null) return `Строка ${i + 1}: цена в рублях.`;
      if (l.plan.trim() !== '' && plan === null) return `Строка ${i + 1}: себестоимость в рублях.`;
      out.push({ kind: l.kind, name: l.name.trim(), quantity: q100 / 100, unit: l.unit.trim() || 'шт', priceKop: price, ...(p.seesPlan ? { planCostKop: plan } : {}) });
    }
    return out;
  }
  const buildBody = (): Record<string, unknown> | string => {
    const name = (f.name ?? '').trim();
    if (!name) return 'Укажите название.';
    const creating = open === 'new';
    if (p.kind === 'equipment-categories') {
      const sort = (f.sortOrder ?? '').trim();
      if (sort && !/^\d{1,6}$/.test(sort)) return 'Порядок – целое число.';
      return { name, ...(sort ? { sortOrder: Number(sort) } : {}) };
    }
    if (p.kind === 'event-types') {
      if (creating && !/^[a-z][a-z0-9_]*$/.test((f.code ?? '').trim())) return 'Код – латиница в нижнем регистре, цифры и _; первая – буква.';
      return creating ? { code: f.code!.trim(), name } : { name };
    }
    if (p.kind === 'event-packages') {
      const body = linesBody();
      if (typeof body === 'string') return body;
      const approx = (f.approx ?? '').trim() === '' ? null : kopOf(f.approx!);
      if ((f.approx ?? '').trim() !== '' && approx === null) return 'Ориентировочная цена – в рублях.';
      if (creating && !f.typeId) return 'Выберите тип мероприятия.';
      return { ...(creating ? { typeId: f.typeId } : {}), name, lines: body, approxPriceKop: approx };
    }
    return { kind: f.kind, name, contactPerson: f.contactPerson?.trim() || null, phone: f.phone?.trim() || null, email: f.email?.trim() || null, comment: f.comment?.trim() || null };
  };
  const send = async (patch: Record<string, unknown>, text: string) => {
    setBusy(true);
    setError('');
    try {
      if (open === 'new') await browserCall(meta.path, { method: 'POST', key: key.current, body: patch });
      else {
        const r = open as Row;
        await browserCall(`${meta.path}/${r.id}`, { method: 'PATCH', key: key.current, body: { ...patch, ...(r.rowVersion !== undefined ? { rowVersion: r.rowVersion } : {}) } });
      }
      setOpen(null);
      setConfirm(false);
      setNotice(text);
      await load();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
      await load();
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const body = buildBody();
    if (typeof body === 'string') return setError(body);
    await send(body, open === 'new' ? 'Запись добавлена.' : 'Сохранено.');
  };

  const row = open && open !== 'new' ? open : null;
  const readOnly = !p.canEdit || row?.status === 'archived';
  const subtitle = (r: Row) => {
    if (p.kind === 'repair-executors') return [EXECUTOR_KIND[String(r.kind)], r.contactPerson, r.phone].filter(Boolean).join(' · ');
    if (p.kind === 'event-packages') {
      const pack = r as unknown as EventPackage;
      return `Строк: ${pack.lines.length}${pack.approxPriceKop !== null ? ` · около ${rub(pack.approxPriceKop)}` : ''}`;
    }
    if (p.kind === 'event-types') return SYSTEM_TYPES.has(String(r.code)) ? `Код: ${String(r.code)} · системный` : `Код: ${String(r.code)}`;
    return r.sortOrder !== undefined ? `Порядок: ${String(r.sortOrder)}` : '';
  };

  return (
    <section class="yc-panel" aria-label={meta.list} data-testid={`dict-${p.kind}`}>
      {!p.canEdit && <p class="yc-field__hint" data-testid="dict-readonly">Только просмотр.</p>}
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
      {error && !open && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      <div class="yc-ev__headline">
        <div class="yc-seg" role="group" aria-label="Раздел">
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'active'} onClick={() => setView('active')}>Действующие</button>
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'archived'} onClick={() => setView('archived')}>Архив</button>
        </div>
        {p.canEdit && <button class="yc-btn" type="button" onClick={() => openRow('new')}>Добавить</button>}
      </div>
      <label class="yc-field"><span class="yc-field__label">Поиск по названию</span><input class="yc-input" type="search" value={q} maxLength={100} onInput={(e) => setQ(e.currentTarget.value)} /></label>
      {rows === null ? <p class="yc-empty">Загружаем…</p> : shown.length === 0 ? <p class="yc-empty" data-testid="dict-empty">{view === 'archived' ? 'В архиве пусто.' : `${meta.list} пока нет.`}</p> : (
        <ul class="yc-ev__cards" data-testid="dict-list">
          {shown.map((r) => (
            <li class="yc-ev__item" key={r.id} data-testid={`row-${r.name}`}>
              <strong>{r.name}</strong>
              {subtitle(r) && <span class="yc-ev__muted">{subtitle(r)}</span>}
              <button class="yc-btn yc-btn--ghost" type="button" aria-label={`Открыть: ${r.name}`} onClick={() => openRow(r)}>Открыть</button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open !== null && !confirm} wide={p.kind === 'event-packages'} title={open === 'new' ? `${meta.one}: новая запись` : (row?.name ?? '')} onClose={() => { if (!toConfirm.current) setOpen(null); }} testId="dict-dialog">
        <form class="yc-ev__stack" novalidate onSubmit={submit}>
          <fieldset class="yc-ev__fields" disabled={readOnly}>
            {p.kind === 'event-packages' && open === 'new' && (
              <label class="yc-field"><span class="yc-field__label">Тип мероприятия</span><select class="yc-input" value={f.typeId} onChange={set('typeId')}>{types.map((t) => <option value={t.id}>{t.name}</option>)}</select></label>
            )}
            {p.kind === 'repair-executors' && (
              <label class="yc-field"><span class="yc-field__label">Вид исполнителя</span><select class="yc-input" value={f.kind} onChange={set('kind')}>{Object.entries(EXECUTOR_KIND).map(([k, v]) => <option value={k}>{v}</option>)}</select></label>
            )}
            <label class="yc-field"><span class="yc-field__label">Название</span><input class="yc-input" type="text" maxLength={300} value={f.name ?? ''} onInput={set('name')} /></label>
            {p.kind === 'event-types' && <label class="yc-field"><span class="yc-field__label">Код</span><input class="yc-input" type="text" maxLength={50} value={f.code ?? ''} readOnly={open !== 'new'} onInput={set('code')} /><span class="yc-field__hint">Для программы: латиница и _. После создания не меняется.</span></label>}
            {p.kind === 'equipment-categories' && <label class="yc-field"><span class="yc-field__label">Порядок в списках</span><input class="yc-input" type="number" min={0} value={f.sortOrder ?? ''} onInput={set('sortOrder')} /></label>}
            {p.kind === 'repair-executors' && (
              <>
                <label class="yc-field"><span class="yc-field__label">Контактное лицо</span><input class="yc-input" type="text" maxLength={200} value={f.contactPerson ?? ''} onInput={set('contactPerson')} /></label>
                <label class="yc-field"><span class="yc-field__label">Телефон</span><input class="yc-input" type="tel" maxLength={40} value={f.phone ?? ''} onInput={set('phone')} /></label>
                <label class="yc-field"><span class="yc-field__label">Комментарий</span><textarea class="yc-input" rows={2} maxLength={2000} value={f.comment ?? ''} onInput={set('comment')} /></label>
              </>
            )}
            {p.kind === 'event-packages' && (
              <>
                <label class="yc-field"><span class="yc-field__label">Ориентировочная цена, ₽</span><input class="yc-input" type="text" inputMode="decimal" value={f.approx ?? ''} onInput={set('approx')} /></label>
                <p class="yc-field__hint">Правка шаблона не меняет уже оформленные мероприятия.</p>
                {lines.map((l, i) => (
                  <div class="yc-ev__item" key={i} data-testid={`pack-line-${i}`}>
                    <div class="yc-ev__grid">
                      <label class="yc-field"><span class="yc-field__label">Вид</span><select class="yc-input" value={l.kind} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, kind: e.currentTarget.value as LineKind } : x)))}>{(Object.keys(LINE_KIND) as LineKind[]).map((k) => <option value={k}>{LINE_KIND[k]}</option>)}</select></label>
                      <label class="yc-field"><span class="yc-field__label">Строка: название</span><input class="yc-input" type="text" maxLength={200} value={l.name} onInput={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, name: e.currentTarget.value } : x)))} /></label>
                      <div class="yc-ev__row">
                        <label class="yc-field"><span class="yc-field__label">Кол-во</span><input class="yc-input" type="text" inputMode="decimal" value={l.qty} onInput={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: e.currentTarget.value } : x)))} /></label>
                        <label class="yc-field"><span class="yc-field__label">Ед.</span><input class="yc-input" type="text" maxLength={30} value={l.unit} onInput={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, unit: e.currentTarget.value } : x)))} /></label>
                      </div>
                      <label class="yc-field"><span class="yc-field__label">Цена, ₽</span><input class="yc-input" type="text" inputMode="decimal" value={l.price} onInput={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, price: e.currentTarget.value } : x)))} /></label>
                      {p.seesPlan && <label class="yc-field"><span class="yc-field__label">Себестоимость, ₽</span><input class="yc-input" type="text" inputMode="decimal" value={l.plan} onInput={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, plan: e.currentTarget.value } : x)))} /></label>}
                    </div>
                    {!readOnly && lines.length > 1 && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setLines(lines.filter((_, k) => k !== i))}>Убрать строку</button>}
                  </div>
                ))}
                {!readOnly && <div><button class="yc-btn yc-btn--ghost" type="button" onClick={() => setLines([...lines, newLine()])}>Ещё строка</button></div>}
              </>
            )}
          </fieldset>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setOpen(null)}>Назад</button>
            {p.canEdit && row?.status === 'active' && <button class="yc-btn yc-btn--danger-text" type="button" onClick={() => { setError(''); key.current = crypto.randomUUID(); toConfirm.current = true; setConfirm(true); }}>Удалить…</button>}
            {p.canEdit && row?.status === 'archived' && <button class="yc-btn" type="button" disabled={busy} onClick={() => send({ status: 'active' }, 'Запись возвращена из архива.')}>Вернуть из архива</button>}
            {!readOnly && <button class="yc-btn" type="submit" disabled={busy}>Сохранить</button>}
          </div>
        </form>
      </Modal>
      <Modal open={confirm} title={`Убрать «${row?.name ?? ''}»?`} onClose={() => { toConfirm.current = false; setConfirm(false); }} testId="dict-archive">
        {isSystem(open) ? <p data-testid="dict-system">Это системный тип: на нём держатся праздник и подарок. Его нельзя удалить или отправить в архив.</p> : <p>Совсем удалить нельзя: на запись могут ссылаться прошлые данные. В архиве её не будет в новых формулах и списках, а вернуть можно в любой момент.</p>}
        {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
        <div class="yc-dialog__actions">
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setConfirm(false)}>Назад</button>
          {!isSystem(open) && <button class="yc-btn yc-btn--danger" type="button" disabled={busy} onClick={() => send({ status: 'archived' }, 'Запись в архиве.')}>В архив</button>}
        </div>
      </Modal>
    </section>
  );
}

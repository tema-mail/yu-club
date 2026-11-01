// Тарифы филиала (S1-24, pricing/routes.ts + tariff.ts, 15 §20): филиал × тип ресурса × длительность.
// Цена тарифа неизменна: новая цена – новый тариф («Сменить цену» копирует условия), старый завершается или уходит в архив.
// Конфликт приоритета (тот же тип и приоритет, пересечение длительностей и дат) ловим до отправки по загруженному
// списку и ещё раз на сервере (TARIFF_PRIORITY_CONFLICT). Удаления нет – архив через окно.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

interface Tariff {
  id: string; resourceType: string; name: string; unitMinutes: number; pricePerUnitKop: number; durationFromMin: number; durationToMin: number | null;
  validFrom: string; validTo: string | null; priority: number; status: 'draft' | 'active' | 'archived';
}
export interface TariffProps {
  branchId: string;
  timezone: string;
  canManage: boolean;
  types: Array<{ code: string; name: string }>;
}

const STATUS: Record<Tariff['status'], string> = { draft: 'Черновик', active: 'Действует', archived: 'В архиве' };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');
const rub = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const EMPTY = { resourceType: '', name: '', unitMinutes: '60', price: '', durationFromMin: '0', durationToMin: '', validFrom: '', validTo: '', priority: '0', status: 'active' };

/** Тот же конфликт, что проверяет сервер (assertNoPriorityConflict). */
function clash(t: Omit<Tariff, 'id' | 'status'> & { status: string }, list: Tariff[]): Tariff | undefined {
  if (t.status !== 'active') return undefined;
  const end = (v: string | null) => (v ? Date.parse(v) : Infinity);
  return list.find((o) => o.status === 'active' && o.resourceType === t.resourceType && o.priority === t.priority &&
    t.durationFromMin < (o.durationToMin ?? Infinity) && o.durationFromMin < (t.durationToMin ?? Infinity) &&
    Date.parse(t.validFrom) < end(o.validTo) && Date.parse(o.validFrom) < end(t.validTo));
}

export default function TariffForm(props: TariffProps) {
  const { types, canManage } = props;
  const base = `/branches/${encodeURIComponent(props.branchId)}/tariffs`;
  const [items, setItems] = useState<Tariff[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [f, setF] = useState({ ...EMPTY, resourceType: types[0]?.code ?? '', validFrom: local(new Date()) });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowMsg, setRowMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveId, setArchiveId] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: props.timezone });
  const typeName = (c: string) => types.find((t) => t.code === c)?.name ?? c;

  useEffect(() => {
    setLoadError('');
    browserCall<{ items: Tariff[] }>(base).then((r) => setItems(r.items)).catch((e: unknown) => setLoadError(errorText(e)));
  }, [reload]);

  const set = (k: keyof typeof EMPTY) => (e: Event) => setF({ ...f, [k]: (e.currentTarget as HTMLInputElement).value });

  const submit = async (e: Event) => {
    e.preventDefault();
    setMsg(null);
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    const price = num(f.price);
    const body = {
      resourceType: f.resourceType, name: f.name.trim(), unitMinutes: num(f.unitMinutes), pricePerUnitKop: price === null ? null : Math.round(price * 100),
      durationFromMin: num(f.durationFromMin) ?? 0, durationToMin: num(f.durationToMin), validFrom: f.validFrom ? new Date(f.validFrom).toISOString() : '',
      validTo: f.validTo ? new Date(f.validTo).toISOString() : null, priority: num(f.priority) ?? 0, status: f.status,
    };
    if (!body.name || !body.unitMinutes || body.pricePerUnitKop === null || Number.isNaN(body.pricePerUnitKop) || !body.validFrom) {
      setMsg({ ok: false, text: 'Заполните название, единицу, цену и начало действия.' });
      return;
    }
    const other = clash(body as Parameters<typeof clash>[0], items ?? []);
    if (other) {
      setMsg({ ok: false, text: `Конфликт приоритета с тарифом «${other.name}»: тот же тип и приоритет, длительности и даты пересекаются. Поменяйте приоритет, длительности или даты – либо завершите старый тариф.` });
      return;
    }
    setBusy(true);
    try {
      await browserCall<Tariff>(base, { method: 'POST', body });
      setMsg({ ok: true, text: 'Тариф создан.' });
      setF({ ...EMPTY, resourceType: f.resourceType, validFrom: local(new Date()) });
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TARIFF_PRIORITY_CONFLICT') {
        const id = err.details?.tariffId as string | undefined;
        setMsg({ ok: false, text: `Конфликт приоритета${id ? ` с тарифом «${items?.find((t) => t.id === id)?.name ?? id}»` : ''}: тариф не сохранён.` });
      } else setMsg({ ok: false, text: `Не сохранено: ${errorText(err)}.` });
    } finally {
      setBusy(false);
    }
  };

  const command = async (path: string, body: Record<string, unknown>, ok: string) => {
    setRowMsg(null);
    setBusy(true);
    try {
      await browserCall(path, { method: path.endsWith('/archive') ? 'POST' : 'PATCH', body });
      setRowMsg({ ok: true, text: ok });
      dialog.current?.close();
      setReload((n) => n + 1);
    } catch (err) {
      setRowMsg({ ok: false, text: err instanceof ApiError && err.code === 'TARIFF_PRIORITY_CONFLICT' ? 'Конфликт приоритета: такой тариф уже действует на эти длительности и даты.' : `Не получилось: ${errorText(err)}.` });
      dialog.current?.close();
    } finally {
      setBusy(false);
    }
  };

  const changePrice = (t: Tariff) => {
    setF({
      resourceType: t.resourceType, name: `${t.name} (новая цена)`, unitMinutes: String(t.unitMinutes), price: '', durationFromMin: String(t.durationFromMin),
      durationToMin: t.durationToMin === null ? '' : String(t.durationToMin), validFrom: local(new Date(Date.now() + 86_400_000)), validTo: '', priority: String(t.priority + 1), status: 'active',
    });
    setMsg({ ok: true, text: `Условия «${t.name}» скопированы, приоритет на 1 выше. Укажите новую цену и дату начала.` });
    form.current?.scrollIntoView({ block: 'start' });
  };

  if (loadError) {
    return (
      <div class="yc-alert yc-alert--error yc-list__error" role="alert">
        <span>Тарифы не загрузились: {loadError}.</span>
        <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setReload((n) => n + 1)}>Повторить</button>
      </div>
    );
  }
  if (!items) return <p class="yc-empty" role="status">Загрузка…</p>;
  const shown = items.filter((t) => (t.status === 'archived') === showArchived);
  const duration = (t: Tariff) => (t.durationToMin === null ? `от ${t.durationFromMin} мин` : `${t.durationFromMin}–${t.durationToMin} мин`);

  return (
    <>
      <section class="yc-panel" aria-label="Тарифы" data-testid="tariffs">
        <div class="yc-seg" role="group" aria-label="Какие тарифы">
          <button type="button" class="yc-seg__btn" aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>Действующие и черновики</button>
          <button type="button" class="yc-seg__btn" aria-pressed={showArchived} onClick={() => setShowArchived(true)}>Архив</button>
        </div>
        {shown.length === 0 ? (
          <p class="yc-empty">{showArchived ? 'В архиве пока ничего нет.' : 'Тарифов нет – без тарифа запись на этот тип места не продаётся.'}</p>
        ) : (
          <table class="yc-table">
            <thead><tr><th scope="col">Тариф</th><th scope="col">Тип</th><th scope="col">Цена</th><th scope="col">Длительность</th><th scope="col">Действует</th><th scope="col">Приоритет</th><th scope="col">Статус</th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td class="yc-table__main">
                    {t.name}
                    {canManage && t.status !== 'archived' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
                        {t.status === 'draft' && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void command(`/tariffs/${t.id}`, { status: 'active' }, `Тариф «${t.name}» включён.`)}>Включить</button>}
                        <button type="button" class="yc-btn yc-btn--ghost" onClick={() => changePrice(t)}>Сменить цену</button>
                        <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => { setArchiveId(t.id); dialog.current?.showModal(); }}>В архив…</button>
                      </div>
                    )}
                  </td>
                  <td data-label="Тип">{typeName(t.resourceType)}</td>
                  <td data-label="Цена">{rub(t.pricePerUnitKop)} за {t.unitMinutes} мин</td>
                  <td data-label="Длительность">{duration(t)}</td>
                  <td data-label="Действует">с {fmt.format(new Date(t.validFrom))}{t.validTo ? ` по ${fmt.format(new Date(t.validTo))}` : ''}</td>
                  <td data-label="Приоритет">{t.priority}</td>
                  <td data-label="Статус"><span class={`yc-badge yc-badge--${t.status === 'active' ? 'active' : 'archived'}`}>{STATUS[t.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class={`yc-alert ${rowMsg ? (rowMsg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{rowMsg?.text ?? ''}</p>
      </section>

      {canManage && (
        <section class="yc-panel" aria-labelledby="tariff-new-title">
          <h2 id="tariff-new-title">Новый тариф</h2>
          <p class="yc-field__hint">Цену действующего тарифа поменять нельзя: созданные брони хранят снимок цены. Новая цена – новый тариф.</p>
          <form class="yc-form" ref={form} novalidate onSubmit={submit}>
            <div class="yc-field">
              <label class="yc-field__label" for="t-type">Тип места</label>
              <select id="t-type" class="yc-input" value={f.resourceType} onChange={set('resourceType')}>
                {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
              </select>
            </div>
            <div class="yc-field"><label class="yc-field__label" for="t-name">Название *</label><input id="t-name" class="yc-input" value={f.name} onInput={set('name')} /></div>
            <div class="yc-field"><label class="yc-field__label" for="t-unit">Единица, минут *</label><input id="t-unit" class="yc-input" type="number" min={1} value={f.unitMinutes} onInput={set('unitMinutes')} /></div>
            <div class="yc-field"><label class="yc-field__label" for="t-price">Цена за единицу, ₽ *</label><input id="t-price" class="yc-input" inputMode="decimal" value={f.price} onInput={set('price')} /></div>
            <div class="yc-field"><label class="yc-field__label" for="t-from">Длительность от, минут</label><input id="t-from" class="yc-input" type="number" min={0} value={f.durationFromMin} onInput={set('durationFromMin')} /></div>
            <div class="yc-field">
              <label class="yc-field__label" for="t-to">Длительность до, минут</label>
              <input id="t-to" class="yc-input" type="number" min={1} value={f.durationToMin} onInput={set('durationToMin')} />
              <p class="yc-field__hint">Пусто – без верхней границы.</p>
            </div>
            <div class="yc-field"><label class="yc-field__label" for="t-valid-from">Действует с *</label><input id="t-valid-from" class="yc-input" type="datetime-local" value={f.validFrom} onInput={set('validFrom')} /></div>
            <div class="yc-field"><label class="yc-field__label" for="t-valid-to">Действует по</label><input id="t-valid-to" class="yc-input" type="datetime-local" value={f.validTo} onInput={set('validTo')} /></div>
            <div class="yc-field">
              <label class="yc-field__label" for="t-priority">Приоритет</label>
              <input id="t-priority" class="yc-input" type="number" value={f.priority} onInput={set('priority')} />
              <p class="yc-field__hint">Из подходящих тарифов применяется тариф с большим приоритетом.</p>
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="t-status">Статус</label>
              <select id="t-status" class="yc-input" value={f.status} onChange={set('status')}>
                <option value="active">Действует</option>
                <option value="draft">Черновик</option>
              </select>
            </div>
            <div><button type="submit" class="yc-btn" disabled={busy}>Создать тариф</button></div>
            <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
          </form>
        </section>
      )}

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="tariff-archive-title">
        <div class="yc-dialog__body">
          <h2 id="tariff-archive-title">Убрать тариф в архив?</h2>
          <p>Насовсем тариф не удаляется: созданные по нему брони хранят снимок цены. В архиве он перестанет применяться к новым броням.</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn yc-btn--danger" disabled={busy} onClick={() => void command(`/tariffs/${archiveId}/archive`, {}, 'Тариф в архиве.')}>В архив</button>
          </div>
        </div>
      </dialog>
    </>
  );
}

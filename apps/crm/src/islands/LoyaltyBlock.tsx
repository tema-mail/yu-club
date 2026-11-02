// Бонусный счёт в карточке клиента (S2-65, K15 №24–28): баланс, доступно, резерв, причина блокировки предзаписи,
// «требует решения» с закрытием корректировкой, история с основанием, партии, выданные товары с возвратом.
// Кнопки – по правам из /me (решает всё равно сервер): корректировка – loyalty.adjust (Владелец, Директор), режим
// «ниже −50» – loyalty.adjust_below_limit (Владелец), выдача и возврат товара – loyalty.goods.issue. Все команды –
// через окно внутри записи с «было → станет» и обязательной причиной; кнопки заняты до ответа (двойной клик – одна операция).
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import {
  BATCH_STATUS, ENTRY_LABEL, ISSUE_LABEL, ISSUE_REF, MIN_BALANCE, SOURCE_LABEL, fmtPoints, fmtRub, loyaltyApi, loyaltyError, parsePoints,
  type BranchGoods, type GoodsOrder, type LoyaltyCard, type LoyaltyIssue,
} from '../lib/loyalty.ts';

export interface LoyaltyBlockProps {
  clientId: string;
  initial: LoyaltyCard;
  timezone: string;
  /** Филиалы зоны сотрудника: подписи в истории и выбор филиала выдачи. */
  branches: Array<{ id: string; name: string }>;
  defaultBranchId: string | null;
  canAdjust: boolean;
  canBelowLimit: boolean;
  canIssue: boolean;
}

type Dialog = { kind: 'adjust'; issue: LoyaltyIssue | null } | { kind: 'issue' } | { kind: 'return'; order: GoodsOrder };

export default function LoyaltyBlock(p: LoyaltyBlockProps) {
  const [card, setCard] = useState<LoyaltyCard>(p.initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const [dlgError, setDlgError] = useState('');
  const [sign, setSign] = useState<'+' | '-'>('+');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [below, setBelow] = useState(false);
  const [branchId, setBranchId] = useState(p.defaultBranchId ?? p.branches[0]?.id ?? '');
  const [goods, setGoods] = useState<BranchGoods[] | null>(null);
  const [goodsId, setGoodsId] = useState('');
  const ref = useRef<HTMLDialogElement>(null);

  const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: p.timezone });
  const at = (iso: string | null) => (iso ? fmt.format(new Date(iso)) : '–');
  const branchName = (id: string | null) => (id ? (p.branches.find((b) => b.id === id)?.name ?? 'другой филиал') : '–');
  const batchOf = (entryId: number) => card.batches.find((b) => b.entryId === entryId);

  const reload = async () => {
    try {
      setCard(await loyaltyApi.card(p.clientId));
    } catch (e) {
      setNotice({ ok: false, text: `Не удалось обновить бонусный счёт: ${loyaltyError(e)}` });
    }
  };
  const close = () => {
    ref.current?.close();
    setDlg(null);
  };
  /** Команда из окна: занято до ответа; успех – окно закрыто, счёт перечитан; ошибка – текст в окне. */
  const run = async (op: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    setDlgError('');
    setNotice(null);
    try {
      await op();
      close();
      await reload();
      setNotice({ ok: true, text: ok });
    } catch (e) {
      setDlgError(loyaltyError(e));
    } finally {
      setBusy(false);
    }
  };
  const loadGoods = async (id: string) => {
    setGoods(null);
    setGoodsId('');
    if (!id) return setGoods([]);
    try {
      setGoods((await loyaltyApi.goods(id)).items.filter((g) => g.status === 'active'));
    } catch (e) {
      setGoods([]);
      setDlgError(loyaltyError(e));
    }
  };
  const open = (d: Dialog) => {
    setDlg(d);
    setDlgError('');
    setReason('');
    setBelow(false);
    if (d.kind === 'adjust') {
      setSign(d.issue ? '-' : '+');
      setAmount(d.issue ? String(d.issue.amountCenti / 100).replace('.', ',') : '');
    }
    if (d.kind === 'issue') void loadGoods(branchId);
    ref.current?.showModal();
  };

  const delta = (() => {
    const v = parsePoints(amount);
    return v === null || v === 0 ? null : sign === '+' ? v : -v;
  })();
  const after = delta === null ? null : card.balanceCenti + delta;
  const needsBelow = after !== null && delta! < 0 && after < MIN_BALANCE;

  const submit = (e: Event) => {
    e.preventDefault();
    if (!dlg) return;
    if (dlg.kind === 'adjust') {
      if (delta === null) return setDlgError('Укажите количество баллов – число больше нуля, до двух знаков после запятой.');
      if (!reason.trim()) return setDlgError('Укажите причину корректировки.');
      if (needsBelow && !below) return setDlgError(p.canBelowLimit ? 'Баланс уйдёт ниже −50: отметьте «ниже предела».' : 'Ниже −50 баллов может опустить только Владелец.');
      void run(() => loyaltyApi.adjust(p.clientId, { deltaCenti: delta, reason: reason.trim(), ...(below ? { belowLimit: true as const } : {}), ...(dlg.issue ? { issueId: dlg.issue.id } : {}) }),
        dlg.issue ? 'Задача закрыта корректировкой.' : `Корректировка проведена: ${fmtPoints(delta, true)}.`);
    } else if (dlg.kind === 'issue') {
      const g = goods?.find((x) => x.id === goodsId);
      if (!g) return setDlgError('Выберите товар.');
      void run(() => loyaltyApi.issue(p.clientId, { goodsId: g.id, branchId }), `Выдан товар «${g.name}» за ${fmtPoints(g.pricePointsCenti)}.`);
    } else {
      if (!reason.trim()) return setDlgError('Укажите причину возврата.');
      void run(() => loyaltyApi.returnOrder(dlg.order.id, reason.trim()), `Товар «${dlg.order.goodsName}» возвращён, баллы вернулись на счёт.`);
    }
  };

  const issueBlock = (g: BranchGoods) =>
    !g.available ? (g.stock === 0 ? 'закончился' : 'недоступен') : g.pricePointsCenti > card.availableCenti ? `не хватает ${fmtPoints(g.pricePointsCenti - card.availableCenti)}` : null;

  return (
    <section class="yc-panel" aria-labelledby="loy-title" data-testid="loyalty">
      <h2 id="loy-title">Бонусный счёт</h2>
      <dl class="yc-props" data-testid="loy-summary">
        <dt>Баланс</dt><dd data-testid="loy-balance"><strong>{fmtPoints(card.balanceCenti)}</strong></dd>
        <dt>Доступно</dt><dd data-testid="loy-available">{fmtPoints(card.availableCenti)}</dd>
        <dt>В резерве</dt><dd data-testid="loy-reserved">{fmtPoints(card.reservedCenti)}{card.reservedCenti > 0 ? ' – под записи, оплачиваемые баллами' : ''}</dd>
        {card.nextExpiry && <><dt>Ближайшее сгорание</dt><dd>{fmtPoints(card.nextExpiry.centi)} – {at(card.nextExpiry.at)}</dd></>}
      </dl>
      {card.accrualBasis === 'planned' && <p class="yc-field__hint" data-testid="loy-basis">Баллы начисляются по расписанию записи (07 §4.3), а не по фактическим минутам.</p>}
      {card.blockedReason && <p class="yc-alert yc-alert--error" data-testid="loy-blocked"><strong>Предварительная запись заблокирована.</strong> {card.blockedReason}</p>}
      <p class={`yc-alert ${notice ? (notice.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="loy-notice">{notice?.text ?? ''}</p>
      {(p.canAdjust || p.canIssue) && (
        <div class="yc-bk__actions">
          {p.canAdjust && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => open({ kind: 'adjust', issue: null })}>Корректировка…</button>}
          {p.canIssue && <button type="button" class="yc-btn yc-btn--ghost" disabled={busy || p.branches.length === 0} onClick={() => open({ kind: 'issue' })}>Выдать товар…</button>}
        </div>
      )}

      {card.issues.length > 0 && (
        <>
          <h3>Требует решения</h3>
          <ul class="yc-history" data-testid="loy-issues">
            {card.issues.map((i) => (
              <li class="yc-history__item" key={i.id}>
                <span class="yc-history__head"><strong>{ISSUE_LABEL[i.kind] ?? i.kind}</strong> · {fmtPoints(i.amountCenti)} · {at(i.createdAt)}</span>
                <span class="yc-field__hint">Основание: {ISSUE_REF[i.ref.type] ?? i.ref.type}. Закрывается корректировкой с причиной.</span>
                {p.canAdjust && <span><button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => open({ kind: 'adjust', issue: i })}>Закрыть корректировкой…</button></span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>История</h3>
      {card.history.length === 0 ? <p class="yc-empty">Операций по счёту пока нет.</p> : (
        <table class="yc-table" data-testid="loy-history">
          <thead><tr><th>Когда</th><th>Операция</th><th>Сумма</th><th>Остаток после</th><th>Филиал</th><th>Основание</th><th>Партия</th></tr></thead>
          <tbody>
            {card.history.map((h) => {
              const b = batchOf(h.entryId);
              return (
                <tr key={h.entryId}>
                  <td data-label="Когда">{at(h.at)}</td>
                  <td class="yc-table__main" data-label="Операция">{ENTRY_LABEL[h.type] ?? h.type}</td>
                  <td data-label="Сумма">{fmtPoints(h.deltaCenti, true)}</td>
                  <td data-label="Остаток после">{fmtPoints(h.balanceAfterCenti)}</td>
                  <td data-label="Филиал">{branchName(h.branchId)}</td>
                  <td data-label="Основание">{h.comment ?? (h.author.type === 'system' ? 'автоматически' : '–')}</td>
                  <td data-label="Партия">{b ? `осталось ${fmtPoints(b.remainingCenti)}, ${b.expiresAt ? `до ${at(b.expiresAt)}` : 'бессрочно'}` : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>Партии</h3>
      {card.batches.length === 0 ? <p class="yc-empty">Партий нет: баллы ещё не начислялись.</p> : (
        <table class="yc-table" data-testid="loy-batches">
          <thead><tr><th>Начислено</th><th>Источник</th><th>Сумма</th><th>Остаток</th><th>Срок</th><th>Статус</th></tr></thead>
          <tbody>
            {card.batches.map((b) => (
              <tr key={b.id}>
                <td data-label="Начислено">{at(b.accruedAt)}</td>
                <td class="yc-table__main" data-label="Источник">{SOURCE_LABEL[b.source]}{b.branchId ? `, ${branchName(b.branchId)}` : ''}</td>
                <td data-label="Сумма">{fmtPoints(b.amountCenti)}</td>
                <td data-label="Остаток">{fmtPoints(b.remainingCenti)}</td>
                <td data-label="Срок">{b.expiresAt ? at(b.expiresAt) : 'бессрочно'}</td>
                <td data-label="Статус">{BATCH_STATUS[b.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Товары за баллы</h3>
      {card.goodsOrders.length === 0 ? <p class="yc-empty">Товары за баллы клиенту не выдавались.</p> : (
        <ul class="yc-history" data-testid="loy-orders">
          {card.goodsOrders.map((o) => (
            <li class="yc-history__item" key={o.id}>
              <span class="yc-history__head"><strong>{o.goodsName}</strong> · {fmtPoints(o.priceCenti)} · {at(o.issuedAt)} · {branchName(o.branchId)}</span>
              <span class="yc-field__hint">{o.status === 'issued' ? 'Выдан' : `Возвращён: ${o.returnReason ?? ''}`}</span>
              {o.status === 'issued' && p.canIssue && <span><button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => open({ kind: 'return', order: o })}>Вернуть…</button></span>}
            </li>
          ))}
        </ul>
      )}

      <dialog ref={ref} class="yc-dialog" aria-labelledby="loy-dlg-title" onClose={() => setDlg(null)}>
        {dlg && (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="loy-dlg-title">{dlg.kind === 'adjust' ? (dlg.issue ? 'Закрыть «требует решения»' : 'Корректировка баллов') : dlg.kind === 'issue' ? 'Выдать товар за баллы' : 'Вернуть товар?'}</h2>
            {dlg.kind === 'adjust' && (
              <>
                <fieldset class="yc-week">
                  <legend class="yc-field__label">Направление</legend>
                  <label class="yc-check"><input type="radio" name="loy-sign" checked={sign === '+'} onChange={() => setSign('+')} />Начислить</label>
                  <label class="yc-check"><input type="radio" name="loy-sign" checked={sign === '-'} onChange={() => setSign('-')} />Списать</label>
                </fieldset>
                <Field id="loy-amount" label="Баллов *">
                  <input id="loy-amount" class="yc-input" inputMode="decimal" value={amount} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
                </Field>
                <Diff before={fmtPoints(card.balanceCenti)} after={after === null ? '–' : fmtPoints(after)} />
                {needsBelow && p.canBelowLimit && (
                  <label class="yc-check"><input type="checkbox" checked={below} onChange={(e) => setBelow((e.currentTarget as HTMLInputElement).checked)} />Ниже предела −50 (право Владельца)</label>
                )}
              </>
            )}
            {dlg.kind === 'issue' && (
              <>
                <Field id="loy-branch" label="Филиал выдачи">
                  <select id="loy-branch" class="yc-input" value={branchId} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; setBranchId(v); void loadGoods(v); }}>
                    {p.branches.map((b) => <option value={b.id} key={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <p class="yc-field__hint">Доступно клиенту: {fmtPoints(card.availableCenti)}. Товар выдаётся только целиком.</p>
                {goods === null ? <p role="status">Загружаем каталог…</p> : goods.length === 0 ? <p class="yc-empty">В этом филиале нет товаров за баллы.</p> : (
                  <fieldset class="yc-week" data-testid="loy-goods">
                    <legend class="yc-field__label">Товар</legend>
                    {goods.map((g) => {
                      const why = issueBlock(g);
                      return (
                        <label class="yc-check" key={g.id}>
                          <input type="radio" name="loy-goods" disabled={why !== null} checked={goodsId === g.id} onChange={() => setGoodsId(g.id)} />
                          {g.name} – {fmtPoints(g.pricePointsCenti)} (в кассе {fmtRub(g.priceRubKop)}){why ? ` · ${why}` : ''}
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                {goodsId && <Diff before={fmtPoints(card.balanceCenti)} after={fmtPoints(card.balanceCenti - (goods?.find((g) => g.id === goodsId)?.pricePointsCenti ?? 0))} />}
              </>
            )}
            {dlg.kind === 'return' && (
              <Diff before={`Выдан: ${dlg.order.goodsName}`} after={`Возвращён · +${fmtPoints(dlg.order.priceCenti)} в исходные партии`} />
            )}
            {dlg.kind !== 'issue' && (
              <Field id="loy-reason" label={dlg.kind === 'return' ? 'Причина возврата *' : 'Причина *'}>
                <textarea id="loy-reason" class="yc-input" rows={3} maxLength={1000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
              </Field>
            )}
            <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={close}>Не менять</button>
              <button type="submit" class="yc-btn" disabled={busy || (dlg.kind === 'issue' && !goodsId)}>
                {dlg.kind === 'adjust' ? 'Провести' : dlg.kind === 'issue' ? 'Выдать' : 'Вернуть'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <dl class="yc-props yc-bk__diff" data-testid="before-after">
      <dt>Было</dt><dd>{before}</dd>
      <dt>Станет</dt><dd><strong>{after}</strong></dd>
    </dl>
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

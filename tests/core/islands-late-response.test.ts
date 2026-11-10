// Правило «одна ошибка – один раз» (docs/OTCHET-dlya-programmistov.md §10): эффект острова, который перезапускается при смене зависимостей
// (фильтр, период, день, год) и кладёт асинхронный ответ в состояние, должен отбрасывать устаревший ответ – иначе ответ прежнего запроса,
// пришедший позже, подменяет свежий (10.11: зарплата, смены, подарок записывался не на тот день).
// Статический страж ловит ровно этот вид: useEffect с непустыми зависимостями, в теле которого (или в локальной функции, которую он
// вызывает) есть await или .then, а признака отсечки нет – useLatest()/fresh(), флага alive/live, AbortController, счётчика запроса.
// Не ловит: устаревший ответ по нажатию кнопки (поиск, выбор дня) и «подгрузка перетёрла ввод» – это видно только в e2e
// (apps/crm/tests/late-response.spec.ts, repair-card.spec.ts), там и правило проверки: задержка ответа через page.route.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const DIRS = ['apps/crm/src/islands', 'apps/site/src/islands'];
const GUARD = /\buseLatest\b|\bfresh\(\)|\balive\b|\blive\b|AbortController|\.signal\b|\b\w*(?:reqNo|requestNo|Req)\.current\b|\bseq\.current\b/;
const ASYNC = /\bawait\b|\.then\(/;

/**
 * Эффекты, где перезапуск с другими данными невозможен или ответ не зависит от порядка. Каждая строка – с причиной;
 * новая строка сюда – только когда отсечка правда не нужна, иначе – useLatest из apps/crm/src/lib/latest.ts.
 */
const ALLOWED: Record<string, string> = {
  // зависимость – свойство страницы: на странице один владелец, перезапуска с другим значением нет
  'apps/crm/src/islands/Attachments.tsx [p.ownerId]': 'владелец вложений один на странице',
  'apps/crm/src/islands/ClientNotifications.tsx [clientId]': 'клиент один на странице',
  'apps/crm/src/islands/DictE3.tsx [p.kind]': 'вид справочника один на странице',
  'apps/crm/src/islands/SeoPanel.tsx [props.entityId]': 'материал один на странице',
  'apps/crm/src/islands/GiftPanel.tsx [p.clientId]': 'именинник меняется сохранением карточки – после ответа, не параллельно',
  'apps/crm/src/islands/EventResources.tsx [c.branchId]': 'филиал мероприятия меняется только сохранением карточки',
  'apps/crm/src/islands/EventLines.tsx [c.typeId]': 'тип мероприятия меняется только сохранением карточки',
  'apps/crm/src/islands/PenaltyForm.tsx [staffId, periodId, enabled]': 'PayrollTable ставит key={staff-period}: смена – новый остров',
  'apps/crm/src/islands/MediaPicker.tsx [props.value]': 'выбор кладёт файл сразу (current), запрос – только для чужого значения при монтировании',
  // перезапуск – после собственного сохранения: прежний ответ к этому моменту уже пришёл, параметры те же
  'apps/crm/src/islands/CalendarExceptions.tsx [reload]': 'счётчик после сохранения; несохранённые часы недели защищены touched (late-response.spec)',
  'apps/crm/src/islands/EntityCard.tsx [reloadKey]': 'история перечитывается после сохранения карточки',
  'apps/crm/src/islands/HomeBlocksEditor.tsx [reload]': 'счётчик после сохранения, параметры те же',
  'apps/crm/src/islands/TariffForm.tsx [reload]': 'счётчик после сохранения, параметры те же',
  'apps/crm/src/islands/EventMoney.tsx [c.id, p.mode, c.rowVersion]': 'rowVersion растёт после сохранения под замком busy – параллельных перечитываний нет',
  'apps/crm/src/islands/EventResources.tsx [c.branchId, startL?.date, c.bookingIds.length]': 'меняется сохранением карточки или привязкой брони – после ответа',
  'apps/crm/src/islands/PaymentPanel.tsx [bookingId, status]': 'та же бронь; статус меняется действием карточки после ответа',
  'apps/crm/src/islands/BookingCard.tsx [arriveLater, b.arriveFrom]': 'таймер окна прихода перечитывает ту же бронь; ввод комментария защищён serverComment (late-response.spec)',
  'apps/crm/src/islands/UnpaidList.tsx [branchId, date]': 'эффект только вешает перечитывание при возврате на вкладку; филиал и дата – свойства страницы',
  'apps/site/src/islands/Checkout.tsx [mode, hold.owner, reserve]': 'баланс перечитывается после ответа резерва, кнопки баллов закрыты на время запроса',
  'apps/site/src/islands/MyBookings.tsx [tab]': 'ответ кладётся под свою вкладку (lists[t]) – чужую не подменяет',
};

/** Конец выражения в скобках/фигурных, начиная с открывающей на позиции open; строки и шаблоны пропускаются. */
function closeOf(src: string, open: number): number {
  const pair: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return src.length;
      continue;
    }
    if (pair[c]) stack.push(pair[c]);
    else if (c === ')' || c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return src.length;
}

/** Тела локальных функций файла: const name = async (…) => { … } и function name(…) { … }. */
function localFunctions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{|(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    out.set((m[1] ?? m[2])!, src.slice(open, closeOf(src, open) + 1));
  }
  return out;
}

export interface Finding { file: string; line: number; deps: string }

/** Эффекты с непустыми зависимостями, асинхронной записью и без отсечки устаревшего ответа. */
export function unguardedEffects(file: string, src: string): Finding[] {
  const fns = localFunctions(src);
  const found: Finding[] = [];
  for (const m of src.matchAll(/\buseEffect\(/g)) {
    const open = m.index! + m[0].length - 1;
    const call = src.slice(open, closeOf(src, open) + 1);
    const deps = /,\s*(\[[^\]]*\])\s*\)$/.exec(call)?.[1] ?? '';
    if (deps === '' || deps === '[]') continue; // один раз при монтировании – перезапуска нет
    const called = [...call.matchAll(/\b(\w+)\(/g)].map((x) => fns.get(x[1]!)).filter((x): x is string => x !== undefined);
    const body = [call, ...called].join('\n');
    if (!ASYNC.test(body) || GUARD.test(body)) continue;
    found.push({ file, line: src.slice(0, m.index).split('\n').length, deps });
  }
  return found;
}

const files = DIRS.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.tsx')).map((f) => `${d}/${f}`));

describe('острова: устаревший ответ не подменяет свежий', () => {
  it('эффект с зависимостями и асинхронным ответом отсекает устаревший ответ (или записан в ALLOWED с причиной)', () => {
    expect(files.length).toBeGreaterThan(80);
    const bad = files
      .flatMap((f) => unguardedEffects(f, readFileSync(join(root, f), 'utf8')))
      .map((x) => `${x.file}:${x.line} ${x.deps}`)
      .filter((x) => !(x.replace(/:\d+ /, ' ') in ALLOWED));
    expect(bad).toEqual([]);
  });

  it('в ALLOWED нет устаревших строк: каждая находится в исходниках', () => {
    const all = files.flatMap((f) => unguardedEffects(f, readFileSync(join(root, f), 'utf8'))).map((x) => `${x.file} ${x.deps}`);
    expect(Object.keys(ALLOWED).filter((k) => !all.includes(k))).toEqual([]);
  });

  it('страж ловит образец ошибки и пропускает исправленный', () => {
    const bad = `useEffect(() => { void load(); }, [year]);\nconst load = async () => { const r = await browserCall('/x'); setItems(r.items); };`;
    const good = `const latest = useLatest();\nuseEffect(() => { void load(); }, [year]);\nconst load = async () => { const fresh = latest(); const r = await browserCall('/x'); if (!fresh()) return; setItems(r.items); };`;
    const once = `useEffect(() => { void load(); }, []);\nconst load = async () => { const r = await browserCall('/x'); setItems(r.items); };`;
    expect(unguardedEffects('x.tsx', bad)).toHaveLength(1);
    expect(unguardedEffects('x.tsx', good)).toEqual([]);
    expect(unguardedEffects('x.tsx', once)).toEqual([]);
  });
});

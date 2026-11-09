// S4-78. Отчёт «Оборудование и ремонты» (K24 §3.10, 14 §13). Источники – rpt_equipment, rpt_repairs, rpt_repair_money (0311), rpt_unit_blocks (0406).
// Простой – объединение (range_agg) блокировок ремонта по единице: вид repair и блокировки, связанные с ремонтом; пересечения одной единицы
// не суммируются дважды (приёмка 16), будущее не считается. Длительность ремонта – от первого перехода в in_repair до завершения;
// ремонт без начала – unavailable/missing_input, без предположений. Расходы – по живым связям rpt_repair_money (привязанный вручную входит,
// сторнированный – нет), по дате и филиалу операции; это те же операции, что расходы в 3.4, отдельно не складываются. Повторные поломки –
// ≥ 2 инцидентов одной единицы за reports.repeat_breakdown_days до конца периода (порог в подписи).
import type { Tx } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import {
  computeMetrics, DAY_RULE, detailPage, localAt, metricDef, noData, okMetric, pageByKey, prevPeriod, resolveBranches, unavailable, windowsOf,
  type BranchWindow, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';

export const EQUIPMENT_ACTION = 'reports.equipment.view';

const FAULTY = ['diagnostics', 'repair', 'awaiting_parts', 'unavailable'];
const GONE = ['written_off', 'lost'];
const OPEN_REPAIR_DONE = ['closed', 'cancelled'];

export type EquipmentBaseMetric = 'totalEquipment' | 'inService' | 'faulty' | 'openFaults' | 'incidents' | 'warrantyRepairs' | 'repairExpenses';
export type EquipmentMetric = EquipmentBaseMetric | 'avgRepairMinutes' | 'downtimeMinutes' | 'repeatBreakdowns';

export function equipmentDefs(): Record<EquipmentBaseMetric, MetricDef> {
  const items = (sql: string, values: unknown[]): MetricDef => ({ spec: { view: 'app.rpt_equipment', conds: [{ sql, values }] }, agg: 'count', unit: 'count', dateBasis: 'now', idCol: 'equipment_id' });
  const repairs = (conds: Array<{ sql: string; values?: unknown[] }>): MetricDef => ({ spec: { view: 'app.rpt_repairs', date: 'incident_at', conds }, agg: 'count', unit: 'count', dateBasis: 'at', idCol: 'repair_id' });
  return {
    totalEquipment: items('NOT (t.status = ANY(?::text[]))', [GONE]),
    inService: items(`t.status = ?`, ['in_service']),
    faulty: items('t.status = ANY(?::text[])', [FAULTY]),
    openFaults: { spec: { view: 'app.rpt_repairs', conds: [{ sql: 'NOT (t.status = ANY(?::text[]))', values: [OPEN_REPAIR_DONE] }] }, agg: 'count', unit: 'count', dateBasis: 'now', idCol: 'repair_id' },
    incidents: repairs([]),
    warrantyRepairs: repairs([{ sql: 't.warranty' }]),
    repairExpenses: {
      spec: { view: 'app.rpt_repair_money', branchCol: 'payer_branch_id', date: 'occurred_at', conds: [{ sql: 'NOT t.reversed' }] },
      agg: 'sum', col: 'amount_kop', unit: 'kop', dateBasis: 'occurred_at', idCol: 'operation_id',
    },
  };
}

const unnestW = (windows: readonly BranchWindow[]) => [windows.map((w) => w.branchId), windows.map((w) => w.start), windows.map((w) => w.end)];
const W_SQL = 'unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS w(branch_id, s, e)';

interface DowntimeRow { unit_id: string; branch_id: string; minutes: string }

/** Простой по единицам: блокировки ремонта одной единицы объединяются, обрезаются окном периода и «сейчас». */
async function downtimeRows(tx: Tx, windows: readonly BranchWindow[], now: Date): Promise<DowntimeRow[]> {
  if (windows.length === 0) return [];
  const r = await tx.query<DowntimeRow>(
    `WITH blk AS (
       SELECT b.unit_id, b.branch_id, b.period FROM app.rpt_unit_blocks b WHERE b.kind = 'repair'
       UNION
       SELECT b.unit_id, b.branch_id, b.period FROM app.rpt_unit_blocks b JOIN app.rpt_repairs r ON b.block_id = ANY(r.block_ids)
     ), q AS (
       SELECT blk.unit_id, blk.branch_id, range_agg(blk.period * tstzrange(w.s, least(w.e, $4::timestamptz), '[)')) AS m
       FROM blk JOIN ${W_SQL} ON w.branch_id = blk.branch_id AND w.s < $4::timestamptz AND blk.period && tstzrange(w.s, least(w.e, $4::timestamptz), '[)')
       GROUP BY 1, 2
     )
     SELECT q.unit_id, q.branch_id, (SELECT coalesce(sum(extract(epoch FROM upper(x) - lower(x)) / 60), 0) FROM unnest(q.m) x)::bigint AS minutes
     FROM q ORDER BY q.unit_id`,
    [...unnestW(windows), now],
  );
  return r.rows.filter((x) => Number(x.minutes) > 0);
}

interface FinishedRow { repair_id: string; equipment_id: string; branch_id: string; started_at: Date | null; finished_at: Date }

async function finishedRepairs(tx: Tx, windows: readonly BranchWindow[]): Promise<FinishedRow[]> {
  if (windows.length === 0) return [];
  return (
    await tx.query<FinishedRow>(
      `SELECT t.repair_id, t.equipment_id, t.branch_id, t.started_at, t.finished_at FROM app.rpt_repairs t JOIN ${W_SQL} ON w.branch_id = t.branch_id AND t.finished_at >= w.s AND t.finished_at < w.e ORDER BY t.repair_id`,
      unnestW(windows),
    )
  ).rows;
}

const minutesOf = (r: FinishedRow): number | null => (r.started_at ? (r.finished_at.getTime() - r.started_at.getTime()) / 60_000 : null);

function avgMetric(rows: readonly FinishedRow[]): Metric {
  if (rows.length === 0) return noData;
  const mins = rows.map(minutesOf);
  if (mins.some((m) => m === null)) return unavailable('missing_input'); // 14 §13: без начала – не считаем из предположений
  return okMetric((mins as number[]).reduce((s, m) => s + m, 0) / mins.length, 'minutes');
}

interface RepeatRow { equipment_id: string; branch_id: string; incidents: string }

async function repeatRows(tx: Tx, windows: readonly BranchWindow[], days: number, now: Date): Promise<RepeatRow[]> {
  if (windows.length === 0) return [];
  return (
    await tx.query<RepeatRow>(
      `SELECT t.equipment_id, min(t.branch_id::text) AS branch_id, count(*) AS incidents
       FROM app.rpt_repairs t JOIN ${W_SQL} ON w.branch_id = t.branch_id
        AND t.incident_at >= least(w.e, $4::timestamptz) - make_interval(days => $5::int) AND t.incident_at < least(w.e, $4::timestamptz)
       GROUP BY t.equipment_id HAVING count(*) >= 2 ORDER BY t.equipment_id`,
      [...unnestW(windows), now, days],
    )
  ).rows;
}

const repeatDaysOf = async (env: ReportEnv): Promise<number> =>
  (await resolveSettings(env.main, ['reports.repeat_breakdown_days'], { network: true }, env.clock.now()))['reports.repeat_breakdown_days'].value;

/** Расходы по исполнителям ремонта: те же строки, что repairExpenses (Σ групп = показатель). */
async function byContractor(tx: Tx, windows: readonly BranchWindow[]): Promise<Array<{ contractorId: string | null; amountKop: number }>> {
  if (windows.length === 0) return [];
  const r = await tx.query<{ contractor_id: string | null; kop: string }>(
    `SELECT r.contractor_id, sum(t.amount_kop) AS kop FROM app.rpt_repair_money t JOIN ${W_SQL} ON w.branch_id = t.payer_branch_id AND t.occurred_at >= w.s AND t.occurred_at < w.e
     JOIN app.rpt_repairs r ON r.repair_id = t.repair_id WHERE NOT t.reversed GROUP BY r.contractor_id ORDER BY r.contractor_id NULLS LAST`,
    unnestW(windows),
  );
  return r.rows.map((x) => ({ contractorId: x.contractor_id, amountKop: Number(x.kop) }));
}

export interface EquipmentResult {
  metrics: Record<EquipmentMetric, Metric>;
  groups: { expensesByContractor: Array<{ contractorId: string | null; amountKop: number }> };
  labels: Record<string, string>;
  dateBasis: Record<EquipmentMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function equipmentReport(env: ReportEnv, p: ReportParams): Promise<EquipmentResult> {
  const branches = await resolveBranches(env.tx, env.ctx, EQUIPMENT_ACTION, p);
  const prevP = prevPeriod(p.period);
  const cur = windowsOf(branches, p.period);
  const now = env.clock.now();
  const defs = equipmentDefs();
  const base = await computeMetrics(env.tx, defs, cur, windowsOf(branches, prevP));
  const down = await downtimeRows(env.tx, cur, now);
  const downPrev = await downtimeRows(env.tx, windowsOf(branches, prevP), now);
  const days = await repeatDaysOf(env);
  const sum = (rows: DowntimeRow[]) => rows.reduce((s, r) => s + Number(r.minutes), 0);
  const dateBasis = Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.dateBasis])) as Record<EquipmentMetric, string>;
  return {
    metrics: {
      ...base,
      avgRepairMinutes: avgMetric(await finishedRepairs(env.tx, cur)),
      downtimeMinutes: okMetric(sum(down), 'minutes', sum(downPrev)),
      repeatBreakdowns: okMetric((await repeatRows(env.tx, cur, days, now)).length, 'count'),
    },
    groups: { expensesByContractor: await byContractor(env.tx, cur) },
    labels: {
      downtimeMinutes: 'Простой – по блокировкам ремонта, пересечения одной единицы считаются один раз',
      avgRepairMinutes: 'От начала ремонта до завершения; ремонт без даты начала – показатель недоступен',
      repeatBreakdowns: `Две и больше поломки одной единицы за ${days} дней`,
      repairExpenses: 'Те же операции, что расходы в «Финансах», – не складывать',
    },
    dateBasis: { ...dateBasis, avgRepairMinutes: 'finished_at', downtimeMinutes: 'at', repeatBreakdowns: 'at' },
    period: p.period,
    prevPeriod: prevP,
    computedAt: now.toISOString(),
    dayRule: DAY_RULE,
  };
}

export interface EquipmentDetailRow {
  id: string;
  equipmentId: string | null;
  inventoryNo: string | null;
  serialNo: string | null;
  branchId: string;
  unitId: string | null;
  status: string | null;
  incidentLocal: string | null;
  startedLocal: string | null;
  finishedLocal: string | null;
  contractorId: string | null;
  warranty: boolean | null;
  value: number | null;
}

interface ItemRow { equipment_id: string; inventory_no: string; serial_no: string | null; branch_id: string; unit_id: string | null; status: string; [k: string]: unknown }

async function itemsOf(tx: Tx, ids: string[]): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map();
  const r = await tx.query<ItemRow>(`SELECT * FROM app.rpt_equipment WHERE equipment_id = ANY($1::uuid[])`, [ids]);
  return new Map(r.rows.map((x) => [x.equipment_id, x]));
}

export async function equipmentDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: EquipmentDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, EQUIPMENT_ACTION, p);
  const windows = windowsOf(branches, p.period);
  const zones = new Map(branches.map((b) => [b.id, b.timezone]));
  const at = (d: Date | null, branchId: string) => (d ? localAt(env, d, zones.get(branchId)!) : null);
  const blank = { equipmentId: null, inventoryNo: null, serialNo: null, unitId: null, status: null, incidentLocal: null, startedLocal: null, finishedLocal: null, contractorId: null, warranty: null };
  const withItems = async (rows: EquipmentDetailRow[]) => {
    const items = await itemsOf(env.tx, [...new Set(rows.flatMap((r) => (r.equipmentId ? [r.equipmentId] : [])))]);
    return rows.map((r) => {
      const i = r.equipmentId ? items.get(r.equipmentId) : undefined;
      return i ? { ...r, inventoryNo: i.inventory_no, serialNo: i.serial_no, unitId: r.unitId ?? i.unit_id } : r;
    });
  };

  if (metric === 'downtimeMinutes') {
    const all = await downtimeRows(env.tx, windows, env.clock.now());
    const { slice, nextCursor } = pageByKey(all, (r) => r.unit_id, opts);
    const rows = slice.map((r): EquipmentDetailRow => ({ ...blank, id: r.unit_id, branchId: r.branch_id, unitId: r.unit_id, value: Number(r.minutes) }));
    return { rows, total: okMetric(all.reduce((s, r) => s + Number(r.minutes), 0), 'minutes'), nextCursor };
  }
  if (metric === 'avgRepairMinutes') {
    const all = await finishedRepairs(env.tx, windows);
    const { slice, nextCursor } = pageByKey(all, (r) => r.repair_id, opts);
    const rows = slice.map((r): EquipmentDetailRow => ({ ...blank, id: r.repair_id, equipmentId: r.equipment_id, branchId: r.branch_id, startedLocal: at(r.started_at, r.branch_id), finishedLocal: at(r.finished_at, r.branch_id), value: minutesOf(r) }));
    return { rows: await withItems(rows), total: avgMetric(all), nextCursor };
  }
  if (metric === 'repeatBreakdowns') {
    const all = await repeatRows(env.tx, windows, await repeatDaysOf(env), env.clock.now());
    const { slice, nextCursor } = pageByKey(all, (r) => r.equipment_id, opts);
    const rows = slice.map((r): EquipmentDetailRow => ({ ...blank, id: r.equipment_id, equipmentId: r.equipment_id, branchId: r.branch_id, value: 1 }));
    return { rows: await withItems(rows), total: okMetric(all.length, 'count'), nextCursor };
  }
  const def = metricDef(equipmentDefs(), metric);
  const page = await detailPage<Record<string, unknown>>(env.tx, def, windows, opts);
  const rows = page.rows.map((r): EquipmentDetailRow => {
    const value = def.agg === 'sum' ? Number(r[def.col!]) : 1;
    if (def.spec.view === 'app.rpt_equipment') {
      return { ...blank, id: String(r.equipment_id), equipmentId: String(r.equipment_id), branchId: String(r.branch_id), status: r.status as string, value };
    }
    if (def.spec.view === 'app.rpt_repair_money') {
      return { ...blank, id: String(r.operation_id), branchId: String(r.payer_branch_id), finishedLocal: at(r.occurred_at as Date, String(r.payer_branch_id)), value };
    }
    const b = String(r.branch_id);
    return {
      ...blank, id: String(r.repair_id), equipmentId: String(r.equipment_id), branchId: b, status: r.status as string, incidentLocal: at(r.incident_at as Date, b),
      startedLocal: at(r.started_at as Date | null, b), finishedLocal: at(r.finished_at as Date | null, b), contractorId: (r.contractor_id as string | null) ?? null, warranty: Boolean(r.warranty), value,
    };
  });
  return { rows: await withItems(rows), total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor };
}

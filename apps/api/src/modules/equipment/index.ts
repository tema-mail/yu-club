// Публичный вход модуля equipment для других модулей (ADR 0002 п.1–2): исполнителей ремонта (K19 §6) читают только отсюда.
// Отчёты (K24 §3.10) подставляют имя исполнителя к ID строки; право на показ проверяет вызывающий: справочник – equipment.view,
// исполнитель-сотрудник – имя коллеги, staff.view (K1).
import type { Db, Tx } from '../../core/audit.ts';

export interface ExecutorRef {
  id: string;
  kind: 'staff' | 'contractor' | 'service_center' | 'manufacturer';
  name: string;
  staffId: string | null;
}

/** Исполнители по ID, архивные тоже: прошлый ремонт хранит исполнителя. */
export async function getExecutorRefs(db: Db | Tx, ids: string[]): Promise<Map<string, ExecutorRef>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const r = await db.query<{ id: string; kind: ExecutorRef['kind']; name: string; staff_id: string | null }>(
    `SELECT id, kind, name, staff_id FROM app.repair_executors WHERE id = ANY($1::uuid[])`,
    [uniq],
  );
  return new Map(r.rows.map((x) => [x.id, { id: x.id, kind: x.kind, name: x.name, staffId: x.staff_id }]));
}

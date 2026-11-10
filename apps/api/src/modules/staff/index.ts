// Публичный вход модуля staff для других модулей (ADR 0002 п.1–2): сотрудников читают только отсюда.
import type { Db, Tx } from '../../core/audit.ts';

export interface StaffRef {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Поиск неархивных сотрудников по префиксу имени или фамилии. zone: null – вся сеть; иначе – есть действующее назначение на филиал или город зоны (TC-16). */
export async function searchStaffByName(
  db: Db | Tx,
  input: { text: string; zone: { branchIds: string[]; cityIds: string[] } | null; limit: number },
): Promise<StaffRef[]> {
  const params: unknown[] = [`${escapeLike(input.text.toLowerCase())}%`, input.limit];
  let zone = 'TRUE';
  if (input.zone) {
    params.push(input.zone.branchIds, input.zone.cityIds);
    zone = `EXISTS (SELECT 1 FROM app.staff_assignments a WHERE a.staff_id = s.id AND a.revoked_at IS NULL
                    AND (a.branch_id = ANY($3::uuid[]) OR a.city_id = ANY($4::uuid[])))`;
  }
  const r = await db.query<{ id: string; first_name: string; last_name: string; role: string }>(
    `SELECT s.id, s.first_name, s.last_name, s.role FROM app.staff s
     WHERE s.status <> 'archived' AND (lower(s.last_name) LIKE $1 OR lower(s.first_name) LIKE $1) AND ${zone}
     ORDER BY lower(s.last_name), lower(s.first_name), s.id LIMIT $2`,
    params,
  );
  return r.rows.map((x) => ({ id: x.id, firstName: x.first_name, lastName: x.last_name, role: x.role }));
}

/** Сотрудники по ID для строк отчётов (K24 §6): имя коллеги видит роль со staff.view – проверяет вызывающий. Архивные тоже: прошлая смена хранит имя. */
export async function getStaffRefs(db: Db | Tx, ids: string[]): Promise<Map<string, StaffRef>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const r = await db.query<{ id: string; first_name: string; last_name: string; role: string }>(`SELECT id, first_name, last_name, role FROM app.staff WHERE id = ANY($1::uuid[])`, [uniq]);
  return new Map(r.rows.map((x) => [x.id, { id: x.id, firstName: x.first_name, lastName: x.last_name, role: x.role }]));
}

/** Имя для строки отчёта: «Имя Фамилия», пустое – null. */
export const staffDisplayName = (ref: StaffRef): string | null => `${ref.firstName.trim()} ${ref.lastName.trim()}`.trim() || null;

/** Имена сотрудников по id для подписей «автор» в журналах (S4-80, K21 §9): любые статусы – история не теряет имён
 *  после архива. Неизвестные id пропускаются. Право на список сотрудников (staff.view) здесь не проверяется:
 *  имя сотрудника рядом с его действием – не ПДн клиента, решает вызывающий модуль. */
export async function getStaffNames(db: Db | Tx, ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const r = await db.query<{ id: string; name: string }>(`SELECT id, first_name || ' ' || last_name AS name FROM app.staff WHERE id = ANY($1::uuid[])`, [uniq]);
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

// S0-18. Тестовые данные Э0: 2 города, 3 филиала в разных зонах, демо-значения справочников,
// сотрудники трёх ролей с назначениями. Ресурсы, тарифы, исключения графика, демо-клиенты – S1-28 (db/seed/resources.ts):
// CLI ниже запускает его следом за засевом Э0, тем же окружением.
// Повторный запуск не плодит дубли: всё ищется по коду/email и создаётся, только если нет.
// Демо-данные помечены (19 §10.1): коды городов и филиалов с префиксом demo-, email @demo.yu-club.test,
// комментарий DEMO_MARK; код демо-причин – demo_*. На прод не попадают: при APP_ENV/NODE_ENV = production
// засев отказывается работать до первого запроса к базе.
// Города и филиалы создаются командами модуля network – с графиком 10:00–22:00 и аудитом (actor system).
//
// CLI: APP_ENV=stage DATABASE_URL=... SEED_PASSWORD=... node db/seed/dev.ts
// (пароль демо-сотрудников – только из окружения; уже созданным сотрудникам пароль не меняется).
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { systemClock, type Clock } from '../../apps/api/src/core/time.ts';
import { createBranch, createCity, setBranchStatus } from '../../apps/api/src/modules/network/commands.ts';
import { assertPasswordStrength, hashPassword, withTx, type Pool } from '../../apps/api/src/modules/staff/auth.ts';
import { seedResources } from './resources.ts';

export const DEMO_MARK = 'DEMO: тестовые данные Э0 (db/seed/dev.ts), не для прода';
export const DEMO_EMAIL_DOMAIN = 'demo.yu-club.test';
const LOCK_KEY = 7_204_513_018;

const CITIES = [
  { code: 'demo-nsk', slug: 'novosibirsk', name: 'Новосибирск', region: 'Новосибирская область', timezone: 'Asia/Novosibirsk' },
  { code: 'demo-msk', slug: 'moskva', name: 'Москва', region: 'Москва', timezone: 'Europe/Moscow' },
] as const;

// Третья зона – тестовая с переходом времени (K8 проверяет на Europe/Berlin): ловить ошибки суток на стенде.
const BRANCHES = [
  { code: 'demo-nsk-krasny', city: 'demo-nsk', slug: 'krasny', name: 'Ю Клуб на Красном', address: 'Красный проспект, 25', timezone: undefined, status: 'active' },
  { code: 'demo-msk-arbat', city: 'demo-msk', slug: 'arbat', name: 'Ю Клуб Арбат', address: 'ул. Арбат, 10', timezone: undefined, status: 'active' },
  { code: 'demo-msk-dst', city: 'demo-msk', slug: 'test-dst', name: 'Тестовый филиал (зона с переходом времени)', address: 'тестовый адрес', timezone: 'Europe/Berlin', status: 'preparing' },
] as const;

const REASONS = [
  { domain: 'booking_cancel_club', code: 'demo_power_outage', name: 'Отключение электричества (демо)' },
  { domain: 'resource_block', code: 'demo_maintenance', name: 'Плановое обслуживание (демо)' },
] as const;

const STAFF = [
  { key: 'owner', role: 'owner', firstName: 'Ольга', lastName: 'Владимирова (демо)' },
  { key: 'director', role: 'director', firstName: 'Денис', lastName: 'Директоров (демо)', city: 'demo-nsk' },
  { key: 'admin', role: 'admin', firstName: 'Анна', lastName: 'Админова (демо)', branch: 'demo-msk-arbat' },
] as const;

export interface SeedReport {
  created: { cities: number; branches: number; reasons: number; staff: number; assignments: number };
  cityIds: Record<string, string>;
  branchIds: Record<string, string>;
  staffIds: Record<string, string>;
}

/** Прод – отказ (19 §10.1). Разрешены только явные непродовые окружения. */
export function assertNotProduction(env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined }): void {
  const v = (env.APP_ENV ?? env.NODE_ENV ?? '').toLowerCase();
  if (!['development', 'dev', 'stage', 'staging', 'test'].includes(v)) {
    throw new Error(`Демо-данные только для dev/stage/test, APP_ENV=${v || 'не задан'} – засев остановлен`);
  }
}

export async function seedDev(
  pool: Pool,
  opts: { env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined }; password: string },
  clock: Clock = systemClock,
): Promise<SeedReport> {
  assertNotProduction(opts.env);
  assertPasswordStrength(opts.password);
  const hash = await hashPassword(opts.password);
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]); // два параллельных засева не создадут дублей
    const report: SeedReport = { created: { cities: 0, branches: 0, reasons: 0, staff: 0, assignments: 0 }, cityIds: {}, branchIds: {}, staffIds: {} };

    // Владелец: активный уже есть (seed-owner) – берём его, иначе демо-Владелец (единственный активный – индекс 0006).
    const existingOwner = await tx.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`);
    for (const s of STAFF) {
      const email = `${s.key}@${DEMO_EMAIL_DOMAIN}`;
      if (s.role === 'owner' && existingOwner.rows[0]) {
        report.staffIds.owner = existingOwner.rows[0].id;
        continue;
      }
      const found = await tx.query<{ id: string }>('SELECT id FROM app.staff WHERE email = $1', [email]);
      if (found.rows[0]) {
        report.staffIds[s.key] = found.rows[0].id;
        continue;
      }
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [s.firstName, s.lastName, email, s.role, hash],
      );
      report.staffIds[s.key] = r.rows[0]!.id;
      report.created.staff++;
    }

    const ownerId = report.staffIds.owner!;
    const ctx: AccessContext = {
      actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() },
      role: 'owner',
      network: true,
      cityIds: new Set(),
      branchIds: new Set(),
      at: clock.now(),
    };
    const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'seed-dev' }, source: 'cli', requestId: `seed-dev:${clock.now().toISOString()}` };

    for (const c of CITIES) {
      const found = await tx.query<{ id: string }>('SELECT id FROM app.cities WHERE code = $1', [c.code]);
      if (found.rows[0]) {
        report.cityIds[c.code] = found.rows[0].id;
        continue;
      }
      report.cityIds[c.code] = (await createCity(tx, ctx, { ...c, comment: DEMO_MARK }, meta, clock)).id;
      report.created.cities++;
    }

    for (const b of BRANCHES) {
      const found = await tx.query<{ id: string }>('SELECT id FROM app.branches WHERE code = $1', [b.code]);
      if (found.rows[0]) {
        report.branchIds[b.code] = found.rows[0].id;
        continue;
      }
      const input = { cityId: report.cityIds[b.city], code: b.code, slug: b.slug, name: b.name, address: b.address, internalComment: DEMO_MARK, ...(b.timezone ? { timezone: b.timezone } : {}) };
      const created = await createBranch(tx, ctx, input, meta, clock);
      if (b.status === 'active') await setBranchStatus(tx, ctx, created.id, { rowVersion: created.rowVersion, status: 'active' }, meta, clock);
      report.branchIds[b.code] = created.id;
      report.created.branches++;
    }

    for (const r of REASONS) {
      const ins = await tx.query(
        `INSERT INTO app.dict_reasons (domain, code, name) VALUES ($1, $2, $3) ON CONFLICT (domain, code) DO NOTHING`,
        [r.domain, r.code, r.name],
      );
      report.created.reasons += ins.rowCount ?? 0;
    }

    for (const s of STAFF) {
      if (!('city' in s) && !('branch' in s)) continue;
      const staffId = report.staffIds[s.key]!;
      const [scope, cityId, branchId] = 'city' in s ? ['city', report.cityIds[s.city]!, null] : ['branch', null, report.branchIds[s.branch]!];
      const has = await tx.query(
        `SELECT 1 FROM app.staff_assignments WHERE staff_id = $1 AND scope_type = $2 AND city_id IS NOT DISTINCT FROM $3::uuid
           AND branch_id IS NOT DISTINCT FROM $4::uuid AND revoked_at IS NULL`,
        [staffId, scope, cityId, branchId],
      );
      if (has.rowCount) continue;
      await tx.query(
        `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $5)`,
        [staffId, scope, cityId, branchId, ownerId],
      );
      report.created.assignments++;
    }
    return report;
  });
}

async function cli(): Promise<void> {
  assertNotProduction(process.env);
  const url = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url) throw new Error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
  if (!password) throw new Error('Нужен SEED_PASSWORD в окружении (пароль демо-сотрудников, не аргументом)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 1 });
  try {
    const r = await seedDev(pool, { env: process.env, password });
    console.log(`Засев Э0: создано ${JSON.stringify(r.created)}; вход: director@${DEMO_EMAIL_DOMAIN}, admin@${DEMO_EMAIL_DOMAIN}`);
    const e1 = await seedResources(pool, { env: process.env });
    console.log(`Засев Э1: создано ${JSON.stringify(e1.created)}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

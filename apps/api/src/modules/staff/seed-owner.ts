// Засев первого Владельца (ADR 0005 п.9: Владельца создаёт только установка, не CRM).
// Секретов в коде нет: пароль – только из окружения OWNER_PASSWORD (в аргументах его видно в списке процессов).
// После первого входа Владелец обязан сменить пароль (must_change_password = true).
//
// CLI: DATABASE_URL=... OWNER_EMAIL=... OWNER_PASSWORD=... node apps/api/src/modules/staff/seed-owner.ts \
//        [--email owner@example.ru] [--first-name Имя] [--last-name Фамилия]
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { writeAudit } from '../../core/audit.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertPasswordStrength, hashPassword, normalizeEmail, withTx, type Pool } from './auth.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function seedOwner(
  pool: Pool,
  input: { email: string; password: string; firstName?: string; lastName?: string },
  clock: Clock = systemClock,
): Promise<{ id: string }> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new Error('Неверный email Владельца');
  assertPasswordStrength(input.password);
  const hash = await hashPassword(input.password);
  return withTx(pool, async (tx) => {
    await tx.query('LOCK TABLE app.staff IN SHARE ROW EXCLUSIVE MODE'); // два параллельных засева не создадут двоих
    const owner = await tx.query("SELECT 1 FROM app.staff WHERE role = 'owner' AND status = 'active'");
    if (owner.rowCount) throw new Error('Активный Владелец уже есть – засев не перезаписывает');
    const taken = await tx.query('SELECT 1 FROM app.staff WHERE email = $1', [email]);
    if (taken.rowCount) throw new Error('Сотрудник с таким email уже есть');
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.staff (first_name, last_name, email, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, 'owner', $4, true) RETURNING id`,
      [input.firstName ?? 'Владелец', input.lastName ?? 'Сети', email, hash],
    );
    const id = r.rows[0]!.id;
    await writeAudit(
      tx,
      { actor: { kind: 'system', process: 'seed-owner' }, source: 'cli', requestId: `seed-owner:${clock.now().toISOString()}` },
      { action: 'staff.created', object: { type: 'staff', id }, after: { email, role: 'owner', mustChangePassword: true } },
      clock,
    );
    return { id };
  });
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' } },
  });
  const url = process.env.DATABASE_URL;
  const email = values.email ?? process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!url) throw new Error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
  if (!email) throw new Error('Нужен --email или OWNER_EMAIL');
  if (!password) throw new Error('Нужен OWNER_PASSWORD в окружении (не аргументом)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 1 });
  try {
    const input: Parameters<typeof seedOwner>[1] = { email, password };
    if (values['first-name']) input.firstName = values['first-name'];
    if (values['last-name']) input.lastName = values['last-name'];
    const { id } = await seedOwner(pool, input);
    console.log(`Владелец создан: ${id}. При первом входе потребуется сменить пароль.`);
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

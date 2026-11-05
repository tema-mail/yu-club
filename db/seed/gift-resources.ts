// S3-62. Боевая идемпотентная процедура: подарочный ресурс и тариф 0 ₽ в каждом филиале с VR-комнатой (K20 §8.2). НЕ демо-посев:
// работает и на проде, демо-флага нет, демо-данных не создаёт; без неё подарок в уже существующих комнатах не записывается.
// Исполнитель в аудите – первый действующий Владелец (нужен seed-owner). Повторный запуск ничего не дублирует.
//
// CLI: DATABASE_URL=... npm run gift:ensure
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { systemClock, type Clock } from '../../apps/api/src/core/time.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { ensureGiftResource, systemGiftContext } from '../../apps/api/src/modules/events/gift-resource.ts';

export interface GiftEnsureSummary {
  branches: number;
  created: number;
  existed: number;
  noVrRoom: number;
  tariffsCreated: number;
}

export async function ensureAllGiftResources(pool: pg.Pool, clock: Clock = systemClock): Promise<GiftEnsureSummary> {
  const owner = await pool.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active' ORDER BY created_at, id LIMIT 1`);
  if (!owner.rows[0]) throw new Error('Нет действующего Владельца: сначала seed-owner');
  const branches = await pool.query<{ id: string }>(`SELECT id FROM app.branches WHERE status <> 'archived' ORDER BY id`);
  const summary: GiftEnsureSummary = { branches: branches.rows.length, created: 0, existed: 0, noVrRoom: 0, tariffsCreated: 0 };
  for (const { id } of branches.rows) {
    const { ctx, meta } = systemGiftContext(owner.rows[0].id, clock.now());
    const r = await runOccupancyCommand(pool, (tx) => ensureGiftResource(tx, ctx, id, meta, clock));
    if (r.status === 'no_vr_room') {
      summary.noVrRoom++;
      continue;
    }
    if (r.status === 'created') summary.created++;
    else summary.existed++;
    if (r.tariffCreated) summary.tariffsCreated++;
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 2 });
  ensureAllGiftResources(pool)
    .then((s) => {
      console.info(JSON.stringify(s));
      return pool.end();
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

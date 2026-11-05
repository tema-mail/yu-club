// K21 §8: шаблоны сообщений и плейсхолдеры. Плейсхолдеры – только белый список, неизвестный – ошибка при сохранении.
// Шаблон копируется в кампанию при создании: правка шаблона созданные кампании не меняет. Управляет Владелец.
// Подстановка – при разворачивании (campaign-runner.ts); имя клиента попадает в notifications.title/body, поэтому
// обезличивание заменяет его пустой подстановкой (anonymize в campaign-runner.ts, K21 §15).
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, runIdempotent, type IdempotentResult } from '../../core/idempotency.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import type { Clock } from '../../core/time.ts';
import { withTx, type Pool } from '../clients/index.ts';

export const PLACEHOLDERS = ['client.firstName', 'branch.name', 'branch.address', 'city.name'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PlaceholderValues = Partial<Record<Placeholder, string | null>>;

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const KNOWN: ReadonlySet<string> = new Set(PLACEHOLDERS);

/** Неизвестный плейсхолдер → TEMPLATE_PLACEHOLDER_UNKNOWN (K21 §12). Одинокие скобки – тоже ошибка: опечатка не уйдёт клиенту. */
export function assertPlaceholders(...texts: string[]): void {
  for (const text of texts) {
    const unknown = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!).filter((p) => !KNOWN.has(p));
    const rest = text.replace(PLACEHOLDER_RE, '');
    if (unknown.length > 0 || /[{}]/.test(rest)) {
      throw new AppError('TEMPLATE_PLACEHOLDER_UNKNOWN', 422, 'В тексте неизвестный плейсхолдер', { unknown, allowed: PLACEHOLDERS });
    }
  }
}

/** Подстановка. Нет значения – пусто; лишние пробелы вокруг пропуска схлопываются, знак после имени не отрывается. */
export function renderText(text: string, values: PlaceholderValues): string {
  return text
    .replace(PLACEHOLDER_RE, (_m, name: string) => values[name as Placeholder] ?? '')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.!?:;])/g, '$1')
    .replace(/^[ ,.!?:;]+/, '')
    .trim();
}

export interface TemplateDto {
  id: string;
  name: string;
  category: 'service' | 'marketing';
  title: string;
  body: string;
  status: 'active' | 'archived';
  rowVersion: number;
}

interface TemplateRow {
  id: string;
  name: string;
  category: 'service' | 'marketing';
  title: string;
  body: string;
  status: 'active' | 'archived';
  row_version: number;
}

const COLUMNS = 'id, name, category, title, body, status, row_version';
const dto = (r: TemplateRow): TemplateDto => ({ id: r.id, name: r.name, category: r.category, title: r.title, body: r.body, status: r.status, rowVersion: r.row_version });

export async function listTemplates(db: Db, opts: { status?: 'active' | 'archived' } = {}): Promise<TemplateDto[]> {
  const r = await db.query<TemplateRow>(
    `SELECT ${COLUMNS} FROM app.notification_templates WHERE ($1::text IS NULL OR status = $1) ORDER BY name, id`,
    [opts.status ?? null],
  );
  return r.rows.map(dto);
}

/** Активный шаблон для копирования в кампанию. Нет или в архиве – NOT_FOUND. */
export async function activeTemplate(db: Db, id: string): Promise<TemplateDto> {
  const r = await db.query<TemplateRow>(`SELECT ${COLUMNS} FROM app.notification_templates WHERE id = $1 AND status = 'active'`, [id]);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', 404, 'Шаблон не найден');
  return dto(r.rows[0]);
}

export const TEMPLATE_CREATE_ROUTE = 'POST /api/crm/v1/notifications/templates';
export const TEMPLATE_UPDATE_ROUTE = 'PATCH /api/crm/v1/notifications/templates/:id';

export interface TemplateInput {
  name: string;
  category: 'service' | 'marketing';
  title: string;
  body: string;
}

export async function createTemplate(pool: Pool, clock: Clock, ctx: AccessContext, meta: AuditRequestMeta, input: TemplateInput, key: string): Promise<IdempotentResult> {
  assertCan(ctx, 'notifications.templates.manage', { network: true });
  assertPlaceholders(input.title, input.body);
  return withTx(pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, TEMPLATE_CREATE_ROUTE), key, request: { route: TEMPLATE_CREATE_ROUTE, body: input }, clock }, async () => {
      const now = clock.now();
      const r = await tx.query<TemplateRow>(
        `INSERT INTO app.notification_templates (name, category, title, body, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${COLUMNS}`,
        [input.name, input.category, input.title, input.body, ctx.actor.staffId, now],
      );
      const row = r.rows[0]!;
      await writeAudit(tx, meta, { action: 'notification.template_created', object: { type: 'notification_template', id: row.id }, after: { name: row.name, category: row.category } }, clock);
      return { status: 201, body: dto(row) };
    }),
  );
}

export interface TemplatePatch {
  rowVersion: number;
  name?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  status?: 'active' | 'archived' | undefined;
}

export async function updateTemplate(pool: Pool, clock: Clock, ctx: AccessContext, meta: AuditRequestMeta, id: string, patch: TemplatePatch, key: string): Promise<IdempotentResult> {
  assertCan(ctx, 'notifications.templates.manage', { network: true });
  return withTx(pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, TEMPLATE_UPDATE_ROUTE), key, request: { route: TEMPLATE_UPDATE_ROUTE, params: { id }, body: patch }, clock }, async () => {
      const cur = (await tx.query<TemplateRow>(`SELECT ${COLUMNS} FROM app.notification_templates WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new AppError('NOT_FOUND', 404, 'Шаблон не найден');
      if (cur.row_version !== patch.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Шаблон уже изменён', { rowVersion: cur.row_version });
      const title = patch.title ?? cur.title;
      const body = patch.body ?? cur.body;
      assertPlaceholders(title, body);
      const r = await tx.query<TemplateRow>(
        `UPDATE app.notification_templates SET name = $2, title = $3, body = $4, status = $5, row_version = row_version + 1, updated_at = $6 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, patch.name ?? cur.name, title, body, patch.status ?? cur.status, clock.now()],
      );
      const row = r.rows[0]!;
      const archived = cur.status === 'active' && row.status === 'archived';
      await writeAudit(
        tx,
        meta,
        { action: archived ? 'notification.template_archived' : 'notification.template_updated', object: { type: 'notification_template', id }, before: { name: cur.name, status: cur.status }, after: { name: row.name, status: row.status } },
        clock,
      );
      return { status: 200, body: dto(row) };
    }),
  );
}

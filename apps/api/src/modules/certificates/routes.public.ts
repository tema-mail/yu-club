// S2-54. K16 §8: ЛК «Мои сертификаты» на /api/public/v1 – список и история движения остатка (08 §10).
// Видны сертификаты, где клиент – получатель, или покупатель при пустом получателе. Кода и его хэша в ответах нет;
// внутренних комментариев (основание записи K3, причины) – тоже. Чужой номер – 404 как несуществующий.
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../core/errors.ts';
import { systemClock } from '../../core/time.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import { CERT_SELECT, normalizeNumber, toCertificateDto, type CertificateRow } from './sale.ts';

/** Сертификат «мой» (решение по 08 §10 «привязанные к профилю»). $1 – clientId. */
const MINE = '(c.recipient_client_id = $1 OR (c.recipient_client_id IS NULL AND c.buyer_client_id = $1))';

type HistoryType = 'sale' | 'redeem' | 'return' | 'expire' | 'correction';
const ENTRY_TYPE: Record<string, HistoryType> = {
  'certificate.issue': 'sale',
  'certificate.redeem': 'redeem',
  'certificate.expire': 'expire',
  'certificate.correction': 'correction',
};

export async function certificatePublicRoutes(app: FastifyInstance, deps: ClientPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  app.get('/me/certificates', async (request, reply) => {
    const { clientId } = await authenticateClient(deps, request, reply);
    const now = clock.now();
    const r = await deps.pool.query<CertificateRow & { burned: string | null }>(
      `SELECT x.*, (SELECT -le.amount FROM journal.ledger_entries le WHERE le.id = x.expired_entry_id) AS burned
       FROM (${CERT_SELECT} WHERE ${MINE}) x ORDER BY x.sold_at DESC, x.id DESC LIMIT 200`,
      [clientId],
    );
    return {
      items: r.rows.map((row) => {
        const dto = toCertificateDto(row, now);
        // у истёкшего – сгоревшая сумма; задача ещё не прошла – сгорит весь остаток
        const burnedKop = dto.status === 'expired' ? (row.burned !== null ? Number(row.burned) : dto.balanceKop) : null;
        return { number: dto.number, nominalKop: dto.nominalKop, balanceKop: dto.status === 'expired' ? 0 : dto.balanceKop, soldAt: dto.soldAt, expiresOn: dto.expiresOn, status: dto.status, burnedKop };
      }),
    };
  });

  app.get('/me/certificates/:number/history', async (request, reply) => {
    const { clientId } = await authenticateClient(deps, request, reply);
    const number = normalizeNumber(String((request.params as { number: string }).number).slice(0, 40));
    const c = await deps.pool.query<{ ledger_account_id: string }>(`SELECT c.ledger_account_id FROM app.certificates c WHERE c.number = $2 AND ${MINE}`, [clientId, number]);
    if (!c.rows[0]) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    const r = await deps.pool.query<{ entry_type: string; reversed_type: string | null; amount: string; balance_after: string; occurred_at: Date; branch_name: string | null }>(
      `SELECT le.entry_type, o.entry_type AS reversed_type, le.amount, le.balance_after, le.occurred_at, b.name AS branch_name
       FROM journal.ledger_entries le
       LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
       LEFT JOIN app.branches b ON b.id = le.branch_id
       WHERE le.account_id = $1 ORDER BY le.occurred_at, le.id`,
      [c.rows[0].ledger_account_id],
    );
    return {
      items: r.rows.map((e) => ({
        at: e.occurred_at.toISOString(),
        // сторно погашения – «возврат»; сторно выпуска (отмена продажи) – «корректировка»: своего типа в K16 §8 нет
        type: e.entry_type === 'reversal' ? (e.reversed_type === 'certificate.redeem' ? 'return' : 'correction') : (ENTRY_TYPE[e.entry_type] ?? 'correction'),
        amountKop: Number(e.amount),
        balanceAfterKop: Number(e.balance_after),
        branchName: e.branch_name,
      })),
    };
  });
}

// S4-40: токен предпросмотра (K22 §11). Подделка, истечение, новая правка черновика, чужой секрет, блокировка сотрудника – токен недействителен (404).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockDef, ensureBlock } from '../../apps/api/src/modules/content/blocks.ts';
import { issuePreviewToken, PREVIEW_TTL_MS, resolvePreview, verifyPreviewToken } from '../../apps/api/src/modules/content/preview.ts';
import { saveDraft } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, fails, NOW, type ContentFixture } from '../helpers/content.ts';

const SECRET = 'p'.repeat(40);
let f: ContentFixture;

const claims = () => ({ entityType: 'home_block' as const, entityId: randomUUID(), draftRowVersion: 3, staffId: randomUUID() });
const noMedia = () => [];

beforeAll(async () => {
  f = await contentFixture();
});
afterAll(async () => {
  await f.close();
});

describe('S4-40: подпись и срок', () => {
  it('верный токен разбирается; срок – 10 минут: ровно на границе уже недействителен', () => {
    const c = claims();
    const token = issuePreviewToken(SECRET, c, NOW);
    expect(verifyPreviewToken(SECRET, token, NOW)).toMatchObject(c);
    expect(verifyPreviewToken(SECRET, token, new Date(NOW.getTime() + PREVIEW_TTL_MS - 1)).entityId).toBe(c.entityId);
    expect(() => verifyPreviewToken(SECRET, token, new Date(NOW.getTime() + PREVIEW_TTL_MS))).toThrowError();
  });

  it('подделка: чужой секрет, правка полезной нагрузки, мусор – одинаковый PREVIEW_TOKEN_INVALID 404', () => {
    const token = issuePreviewToken(SECRET, claims(), NOW);
    const [payload, signature] = token.split('.') as [string, string];
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), draftRowVersion: 99 })).toString('base64url');
    for (const bad of [issuePreviewToken('z'.repeat(40), claims(), NOW), `${tampered}.${signature}`, `${payload}.`, payload, '', '..', 'a.b.c', `${payload}.${signature}.x`]) {
      try {
        verifyPreviewToken(SECRET, bad, NOW);
        expect.unreachable(`принят токен ${bad}`);
      } catch (err) {
        expect(err).toMatchObject({ code: 'PREVIEW_TOKEN_INVALID', httpStatus: 404 });
      }
    }
  });
});

describe('S4-40: черновик по токену', () => {
  it('отдаёт черновик и вид сущности; новая правка черновика – токен недействителен, новый – работает; заблокированный сотрудник – нет', async () => {
    const c = f.owner();
    const { row } = await f.inTx((tx) => ensureBlock(tx, c, { blockType: 'hero', cityId: null, draft: { blockType: 'hero', payload: { title: 'Черновик 1' } } }, f.meta(c), clock));
    const tokenFor = (rowVersion: number, staffId = f.staffId) => issuePreviewToken(SECRET, { entityType: 'home_block', entityId: row.id, draftRowVersion: rowVersion, staffId, branchId: randomUUID() }, NOW);
    const first = tokenFor(row.row_version);
    const shown = await resolvePreview(f.pool, SECRET, first, NOW, noMedia);
    expect(shown).toMatchObject({ entityType: 'home_block', kind: 'hero', draft: { payload: { title: 'Черновик 1' } } });
    expect(shown.branchId).not.toBeNull();
    const saved = await f.inTx((tx) => saveDraft(tx, c, blockDef, row.id, { rowVersion: row.row_version, draft: { blockType: 'hero', payload: { title: 'Черновик 2' } } }, f.meta(c), clock));
    await fails(resolvePreview(f.pool, SECRET, first, NOW, noMedia), 'PREVIEW_TOKEN_INVALID');
    expect((await resolvePreview(f.pool, SECRET, tokenFor(saved.row_version), NOW, noMedia)).draft).toEqual({ blockType: 'hero', payload: { title: 'Черновик 2' } });
    await fails(resolvePreview(f.pool, SECRET, tokenFor(saved.row_version, randomUUID()), NOW, noMedia), 'PREVIEW_TOKEN_INVALID');
    await f.db.client.query(`UPDATE app.staff SET status = 'blocked' WHERE id = $1`, [f.staffId]);
    await fails(resolvePreview(f.pool, SECRET, tokenFor(saved.row_version), NOW, noMedia), 'PREVIEW_TOKEN_INVALID');
    await f.db.client.query(`UPDATE app.staff SET status = 'active' WHERE id = $1`, [f.staffId]);
  });

  it('медиа в предпросмотре – из медиатеки с заглушкой очищенного', async () => {
    const c = f.owner();
    const image = await f.image(31, 'Фото');
    const { row } = await f.inTx((tx) => ensureBlock(tx, c, { blockType: 'about', cityId: null, draft: { blockType: 'about', payload: { body: 'x' } } }, f.meta(c), clock));
    const token = issuePreviewToken(SECRET, { entityType: 'home_block', entityId: row.id, draftRowVersion: row.row_version, staffId: f.staffId }, NOW);
    expect((await resolvePreview(f.pool, SECRET, token, NOW, () => [image])).media[image]).toMatchObject({ alt: 'Фото', removed: false });
    await f.db.client.query(`UPDATE app.content_media SET status = 'purged' WHERE id = $1`, [image]);
    expect((await resolvePreview(f.pool, SECRET, token, NOW, () => [image])).media[image]).toMatchObject({ removed: true, url: null });
  });
});

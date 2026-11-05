// S4-42: внутренний маршрут черновика. Без секрета → 404; с секретом и токеном – черновик и медиа; маршрут не регистрируется без PREVIEW_SECRET;
// новая правка – токен недействителен; ответ no-store.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { issuePreviewToken } from '../../apps/api/src/modules/content/preview.ts';
import { publicationDef, type PublicationDraft } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, saveDraft } from '../../apps/api/src/modules/content/versions.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';

const SECRET = 'p'.repeat(40);
const URL_BASE = '/api/internal/v1/content/preview';
let f: ContentFixture;
let app: FastifyInstance;
let plain: FastifyInstance;
let rowId: string;
let rowVersion: number;
let cover: string;
const marker = `ЧЕРНОВИК-${randomUUID()}`;
const draft = (): PublicationDraft => ({ scope: { type: 'network' }, title: marker, body: `![x](media:${cover})`, coverMediaId: cover });
const token = (version = rowVersion, entityId = rowId) => issuePreviewToken(SECRET, { entityType: 'publication', entityId, draftRowVersion: version, staffId: f.staffId }, NOW);
const get = (server: FastifyInstance, t: string, secret?: string) => server.inject({ method: 'GET', url: `${URL_BASE}/${encodeURIComponent(t)}`, headers: secret ? { 'x-preview-secret': secret } : {} });

beforeAll(async () => {
  f = await contentFixture();
  cover = await f.image(71, 'Обложка');
  const c = f.owner();
  const row = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, draft(), f.meta(c), clock));
  rowId = row.id;
  rowVersion = row.row_version;
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool }, content: { mediaStore: f.store, previewSecret: SECRET } });
  plain = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool }, content: { mediaStore: f.store } });
});
afterAll(async () => {
  await app.close();
  await plain.close();
  await f.close();
});

describe('S4-42: внутренний маршрут черновика', () => {
  it('с секретом и токеном – черновик, медиа, вид; no-store', async () => {
    const res = await get(app, token(), SECRET);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ entityType: 'publication', entityId: rowId, kind: 'news', draft: { title: marker } });
    expect(body.media[cover]).toMatchObject({ alt: 'Обложка', removed: false });
    expect(body.media[cover].url).toMatch(/^\/media\//);
  });

  it('без секрета, с неверным секретом, с подделанным токеном, чужой сущностью → одинаковый 404 без текста черновика', async () => {
    const answers = [
      await get(app, token()),
      await get(app, token(), 'неверный-секрет'),
      await get(app, `${token()}x`, SECRET),
      await get(app, 'мусор', SECRET),
      await get(app, token(rowVersion, randomUUID()), SECRET),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(marker);
    }
  });

  it('новая правка черновика – прежний токен недействителен, новый работает', async () => {
    const c = f.owner();
    const first = token();
    const saved = await f.inTx((tx) => saveDraft(tx, c, publicationDef, rowId, { rowVersion, draft: { ...draft(), lead: 'правка' } }, f.meta(c), clock));
    rowVersion = saved.row_version;
    expect((await get(app, first, SECRET)).statusCode).toBe(404);
    expect((await get(app, token(), SECRET)).json().draft.lead).toBe('правка');
  });

  it('маршрут не регистрируется без PREVIEW_SECRET: 404 от Fastify, а не обработчика', async () => {
    const res = await get(plain, token(), SECRET);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(marker);
    expect(plain.hasRoute({ method: 'GET', url: `${URL_BASE}/*` })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: `${URL_BASE}/*` })).toBe(true);
  });

  it('публичный префикс маршрут не отдаёт', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/public/v1/content/preview/${encodeURIComponent(token())}`, headers: { 'x-preview-secret': SECRET } })).statusCode).toBe(404);
  });
});

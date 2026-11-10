// K5 №218: GET /content/requisites – реквизиты оператора из настроек сети legal.* (K7 «Реквизиты оператора»). По умолчанию все null
// (сайт блок не рисует); заданные Владельцем – в ответе, пустые остаются null; кэш public, max-age=60, ETag меняется от значений, 304 по If-None-Match.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { setSetting, type SettingKey } from '../../apps/api/src/core/settings.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';

let f: ContentFixture;
let app: FastifyInstance;
const get = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/api/public/v1/content/requisites', headers });
const EMPTY = { operatorName: null, inn: null, ogrn: null, address: null, phone: null, email: null };

async function set(key: SettingKey, value: string): Promise<void> {
  const c = f.owner();
  await f.inTx((tx) => setSetting(tx, c, { key, scope: { network: true }, value, validFrom: clock.now() }, f.meta(c), clock));
}

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool, clock } });
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('№218 /content/requisites', () => {
  it('пусто по умолчанию: все поля null, без сессии, кэш 60 с и ETag; повтор с If-None-Match – 304', async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(EMPTY);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    const etag = String(r.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const again = await get({ 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('заданные Владельцем реквизиты – в ответе, пустые остаются null; пробелы не считаются значением; ETag меняется', async () => {
    const before = String((await get()).headers.etag);
    await set('legal.operator_name', 'ООО «Ю-Клуб»');
    await set('legal.inn', '5405123456');
    await set('legal.ogrn', '1025400000001');
    await set('legal.address', '630099, Новосибирск, Красный проспект, 25');
    await set('legal.phone', '   ');
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ...EMPTY, operatorName: 'ООО «Ю-Клуб»', inn: '5405123456', ogrn: '1025400000001', address: '630099, Новосибирск, Красный проспект, 25' });
    expect(String(r.headers.etag)).not.toBe(before);
    expect((await get({ 'if-none-match': before })).statusCode).toBe(200);
    expect(r.body).not.toMatch(/legal\.|valueId|validFrom|created_by/);
  });
});

// Мок медиатеки CRM строго по apps/api/src/modules/content/routes.media.ts и media.ts (K11 №224–227, K22 §8): загрузка multipart с лимитом
// 10 МБ и проверкой сигнатуры (SVG, GIF – MEDIA_TYPE_NOT_ALLOWED), дубль по sha256 – та же запись (200, duplicate), alt и подпись с rowVersion,
// архив используемого живой версией – MEDIA_IN_USE со списком, удаление – только Владелец и только неиспользуемого. Подключается из mock-content.ts.
// №227а очистка по требованию субъекта (media-purge.ts): только Владелец, reasonCode из списка, основание ≤ 200; ссылки на файл убираются из
// черновиков, живые сущности получают новую версию без фото. Отличие от API (осознанное): строка медиа убирается из мока целиком –
// в списке и по id её и так нет (у API status = 'purged'); повтор отвечает 404, а не 200 без изменений.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { PURGE_REASON_CODES } from '../../../packages/contracts/src/media-purge.ts';
import { Fail, MAX_BYTES, type Media, type Rec, type Staffish, UUID, cms, invalid, notFound, refsOf, storageKey, str } from './mock-cms.ts';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export interface MediaHelpers {
  command: (name: string, run: (s: Staffish, req: FastifyRequest) => { status: number; body: unknown }) => Handler;
  read: (run: (s: Staffish, req: FastifyRequest) => unknown) => Handler;
  assertRole: (s: Staffish, action: string) => void;
  strict: (body: unknown, keys: Record<string, (v: unknown) => boolean>, required: string[]) => Rec;
  rv: (v: unknown) => boolean;
}

export function registerMedia(app: FastifyInstance, P: string, h: MediaHelpers): void {
  const { command, read, assertRole, strict, rv } = h;

  const mediaDto = (m: Media) => ({ id: m.id, mime: m.mime, bytes: m.bytes, width: m.width, height: m.height, variants: [], storageKey: storageKey(m), url: `/media/${storageKey(m)}`, alt: m.alt, title: m.title, originalName: m.originalName, purpose: m.purpose, status: m.status, createdAt: m.createdAt, archivedAt: m.archivedAt, rowVersion: m.rowVersion });
  const usages = (id: string) => {
    const out: Array<{ entityType: string; entityId: string; field: string; live: boolean }> = [];
    for (const r of cms.rows) {
      if (r.status !== 'archived') for (const x of refsOf(r.type, r.draft)) if (x.mediaId === id) out.push({ entityType: r.type, entityId: r.id, field: x.field, live: false });
      if (r.status === 'published' && r.liveVersionId) {
        const snap = cms.versions.find((v) => v.id === r.liveVersionId)?.snapshot ?? {};
        for (const x of refsOf(r.type, snap)) if (x.mediaId === id) out.push({ entityType: r.type, entityId: r.id, field: x.field, live: true });
      }
    }
    return out.sort((a, b) => `${a.entityType}${a.entityId}${a.field}${String(a.live)}`.localeCompare(`${b.entityType}${b.entityId}${b.field}${String(b.live)}`));
  };
  const inVersions = (id: string) => cms.versions.some((v) => Object.keys((v.snapshot.media ?? {}) as Rec).includes(id));
  const mediaRow = (id: string) => {
    const m = UUID.test(id) ? cms.media.find((x) => x.id === id) : undefined;
    if (!m) throw notFound();
    return m;
  };

  /** multipart/form-data: части разбираются по границе (у сервера – @fastify/multipart, лимит части 10 МБ). */
  app.register(async (scoped) => {
    scoped.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 12 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scoped.post(`${P}/content/media`, command('media.upload', (s, req) => {
      assertRole(s, 'content.media.upload');
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(req.headers['content-type'] ?? ''));
      if (!boundary || !Buffer.isBuffer(req.body)) throw invalid([{ path: 'body', message: 'нужен файл' }]);
      const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
      const buf = req.body;
      const fields: Record<string, string> = {};
      let file: Buffer | null = null;
      let name: string | null = null;
      for (let i = buf.indexOf(sep); i !== -1;) {
        const next = buf.indexOf(sep, i + sep.length);
        if (next === -1) break;
        const part = buf.subarray(i + sep.length + 2, next - 2);
        const head = part.indexOf('\r\n\r\n');
        const headers = part.subarray(0, head).toString();
        const content = part.subarray(head + 4);
        const field = /name="([^"]*)"/.exec(headers)?.[1] ?? '';
        const fname = /filename="([^"]*)"/.exec(headers);
        if (fname) {
          file = Buffer.from(content);
          name = fname[1] ?? null;
        } else fields[field] = content.toString();
        i = next;
      }
      if (!file || file.length === 0) throw invalid([{ path: 'file', message: 'нужен файл' }]);
      if (file.length > MAX_BYTES) throw new Fail(413, 'MEDIA_TOO_LARGE', 'Можно загрузить JPG, PNG или WebP до 10 МБ', { maxBytes: MAX_BYTES });
      const purpose = (fields.purpose ?? 'image') as 'image' | 'document';
      if (!['image', 'document'].includes(purpose) || (fields.alt?.length ?? 0) > 500 || (fields.title?.length ?? 0) > 200) throw invalid([{ path: 'purpose', message: 'неверное значение' }]);
      const sniffed = file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff ? 'image/jpeg'
        : file.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png'
        : file.subarray(0, 4).toString() === 'RIFF' && file.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
        : file.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : null;
      const ok = purpose === 'document' ? ['application/pdf'] : ['image/jpeg', 'image/png', 'image/webp'];
      if (!sniffed || !ok.includes(sniffed)) throw new Fail(415, 'MEDIA_TYPE_NOT_ALLOWED', 'Можно загрузить JPG, PNG или WebP до 10 МБ', { detected: sniffed });
      const sha256 = createHash('sha256').update(file).digest('hex');
      const dup = cms.media.find((m) => m.sha256 === sha256);
      if (dup) return { status: 200, body: { media: mediaDto(dup), duplicate: true } };
      const png = sniffed === 'image/png' && file.length >= 24;
      const m: Media = {
        id: randomUUID(), sha256, mime: sniffed, bytes: file.length, width: sniffed === 'application/pdf' ? null : png ? file.readUInt32BE(16) : 1600, height: sniffed === 'application/pdf' ? null : png ? file.readUInt32BE(20) : 900,
        alt: str(fields.alt) || null, title: str(fields.title) || null, originalName: name, purpose, status: 'active', createdAt: new Date().toISOString(), archivedAt: null, rowVersion: 1,
      };
      cms.media.push(m);
      return { status: 201, body: { media: mediaDto(m), duplicate: false } };
    }));
  });
  app.get(`${P}/content/media`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    if ((q.type && !['image', 'document'].includes(q.type)) || (q.archived && !['true', 'false'].includes(q.archived)) || (q.q && q.q.length > 200)) throw invalid([{ path: 'type', message: 'неверное значение' }]);
    const needle = q.q?.toLowerCase();
    const list = cms.media
      .filter((m) => m.status === (q.archived === 'true' ? 'archived' : 'active') && (!q.type || m.purpose === q.type) && (!needle || [m.alt, m.title, m.originalName].some((x) => x?.toLowerCase().includes(needle))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const from = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
    return { items: list.slice(from, from + limit).map(mediaDto), nextCursor: from + limit < list.length ? Buffer.from(String(from + limit)).toString('base64url') : null };
  }));
  app.get(`${P}/content/media/:id`, read((s, req) => {
    assertRole(s, 'content.view');
    return mediaDto(mediaRow((req.params as { id: string }).id));
  }));
  app.patch(`${P}/content/media/:id`, command('media.update', (s, req) => {
    const b = strict(req.body, { alt: (v) => v === null || (typeof v === 'string' && v.length <= 500), title: (v) => v === null || (typeof v === 'string' && v.length <= 200), rowVersion: rv }, ['rowVersion']);
    assertRole(s, 'content.media.upload');
    const m = mediaRow((req.params as { id: string }).id);
    if (m.rowVersion !== b.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Запись изменилась', { current: mediaDto(m) });
    if (b.alt !== undefined) m.alt = str(b.alt) || null;
    if (b.title !== undefined) m.title = str(b.title) || null;
    m.rowVersion += 1;
    return { status: 200, body: mediaDto(m) };
  }));
  app.post(`${P}/content/media/:id/archive`, command('media.archive', (s, req) => {
    assertRole(s, 'content.media.archive');
    const m = mediaRow((req.params as { id: string }).id);
    if (m.status === 'archived') return { status: 200, body: mediaDto(m) };
    const live = usages(m.id).filter((u) => u.live);
    if (live.length) throw new Fail(409, 'MEDIA_IN_USE', 'Файл используется на сайте', { usages: live });
    m.status = 'archived';
    m.archivedAt = new Date().toISOString();
    m.rowVersion += 1;
    return { status: 200, body: mediaDto(m) };
  }));
  app.get(`${P}/content/media/:id/usages`, read((s, req) => {
    assertRole(s, 'content.view');
    const m = mediaRow((req.params as { id: string }).id);
    return { usages: usages(m.id), inVersions: inVersions(m.id) };
  }));
  const PURGE_CODES: readonly string[] = PURGE_REASON_CODES;
  // Сбой удаления файлов после фиксации (routes.media.ts): POST /__test/media-remove-fails – следующая очистка ответит filesPending: true.
  let removeFails = false;
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/__test/reset') removeFails = false;
  });
  app.post('/__test/media-remove-fails', async () => {
    removeFails = true;
    return { removeFails };
  });
  /** stripMedia сервера: поле-идентификатор и элемент массива исчезают, картинка в Markdown вырезается. */
  const strip = (value: unknown, id: string): unknown => {
    if (typeof value === 'string') return value.replace(new RegExp(`!\\[[^\\]]*\\]\\(media:${id}\\)`, 'gi'), '');
    if (Array.isArray(value)) return value.filter((x) => x !== id).map((x) => strip(x, id));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, x]) => x !== id).map(([k, x]) => [k, strip(x, id)]));
    return value;
  };
  app.post(`${P}/content/media/:id/purge`, command('media.purge', (s, req) => {
    assertRole(s, 'content.media.purge');
    const b = strict(req.body, { reasonCode: (v) => PURGE_CODES.includes(String(v)), basis: (v) => typeof v === 'string' && v.length <= 200 }, ['reasonCode']);
    const m = mediaRow((req.params as { id: string }).id);
    const affected: Array<{ entityType: string; entityId: string; versionNo: number | null }> = [];
    for (const r of cms.rows) {
      const live = r.status === 'published' && r.liveVersionId ? cms.versions.find((v) => v.id === r.liveVersionId) : undefined;
      if (live && JSON.stringify(live.snapshot).includes(m.id)) {
        const media = { ...((live.snapshot.media ?? {}) as Rec) };
        delete media[m.id];
        const no = cms.versions.filter((v) => v.entityType === r.type && v.entityId === r.id).length + 1;
        const v = { ...live, id: String(cms.seq++), versionNo: no, action: 'publish' as const, publishedBy: s.id, publishedAt: new Date().toISOString(), reason: `Очистка фото: ${String(b.reasonCode)}`, sourceVersionId: null, snapshot: { ...(strip(live.snapshot, m.id) as Rec), media } };
        cms.versions.push(v);
        r.liveVersionId = v.id;
        r.rowVersion += 1;
        affected.push({ entityType: r.type, entityId: r.id, versionNo: no });
      }
      if (JSON.stringify(r.draft).includes(m.id)) {
        r.draft = strip(r.draft, m.id) as Rec;
        r.rowVersion += 1;
        if (!affected.some((a) => a.entityId === r.id)) affected.push({ entityType: r.type, entityId: r.id, versionNo: null });
      }
    }
    cms.media = cms.media.filter((x) => x.id !== m.id);
    const filesPending = removeFails;
    removeFails = false;
    return { status: 200, body: { purged: true, affected, filesPending } };
  }));
  app.delete(`${P}/content/media/:id`, command('media.delete', (s, req) => {
    assertRole(s, 'content.media.purge');
    const m = mediaRow((req.params as { id: string }).id);
    const u = usages(m.id);
    if (u.length) throw new Fail(409, 'MEDIA_IN_USE', 'Файл используется', { usages: u });
    if (inVersions(m.id)) throw new Fail(409, 'MEDIA_IN_USE', 'Файл есть в опубликованных версиях', { usages: [], inVersions: true });
    cms.media = cms.media.filter((x) => x.id !== m.id);
    return { status: 200, body: { deleted: true } };
  }));
}

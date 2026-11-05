// S3-94: вложения в бэкапе. Настоящие backup.sh и restore-check.sh на подмене docker (база не нужна: проверяется логика файлов):
// снимок каталога в том же запуске, что дамп; живой storage_key без файла или с другим размером – ОШИБКА; недействительная версия файла не требует.
// Статически: каталог смонтирован только в api, общий Caddy его не видит, адреса вложений – 404 на обоих доменах.
// Живая проверка на стенде – docs/TEHDOLG-zapusk.md 2.4.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '../..');
const SHA = 'ab'.repeat(32);
const KEY = `ab/${SHA}`;
let tmp = '';
let env: NodeJS.ProcessEnv;

// docker exec [-i] <контейнер> <команда…>: psql отвечает по тексту запроса, файлы кладёт как pg_dump в смонтированный /backups.
const STUB = `#!/usr/bin/env bash
shift; [ "$1" = "-i" ] && shift; shift
case "$1" in
  pg_isready|pg_restore) exit 0 ;;
  psql)
    for a in "$@"; do
      case "$a" in
        *to_regclass*attachments*) echo "$HAS_ATTACHMENTS"; exit 0 ;;
        *to_regclass*content_media*) echo f; exit 0 ;;
        *CREATE\\ DATABASE*|*DROP\\ DATABASE*) exit 0 ;;
      esac
    done
    sql=$(cat)
    case "$sql" in
      *pg_export_snapshot*)
        name=$(printf '%s' "$sql" | sed -n 's#.*/backups/\\(.*\\)\\.dump\\.part.*#\\1#p' | head -1)
        printf 'dump' >"$BACKUP_DIR/$name.dump.part"
        printf 'rows app.x 1\\nledger_sum 0\\n' >"$BACKUP_DIR/$name.counts.part" ;;
      *app.attachments*) cat "$ATT_ROWS" ;;
      *) printf 'rows app.x 1\\nledger_sum 0\\n' ;;
    esac ;;
esac
`;

async function script(name: string, extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  try {
    const r = await run('bash', [join(ROOT, 'deploy', name)], { env: { ...env, ...extra } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}
const snapshot = () => {
  const d = readdirSync(env.BACKUP_DIR!).find((x) => x.endsWith('.attachments'));
  return d ? join(env.BACKUP_DIR!, d) : null;
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'yu-backup-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), STUB);
  chmodSync(join(bin, 'docker'), 0o755);
  const att = join(tmp, 'attachments');
  mkdirSync(join(att, 'ab'), { recursive: true });
  writeFileSync(join(att, KEY), 'hello');
  const rows = join(tmp, 'rows');
  writeFileSync(rows, `${KEY} 5\n`);
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    ENV_FILE: join(tmp, 'нет.env'),
    BACKUP_DIR: join(tmp, 'backups'),
    BACKUP_FILE_DIRS: `attachments=${att}`,
    ATT_ROWS: rows,
    HAS_ATTACHMENTS: 't',
  };
  const b = await script('backup.sh');
  expect(b.code, b.out).toBe(0);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('backup.sh + restore-check.sh', () => {
  it('снимок вложений в том же запуске, что дамп: имя общее', () => {
    const files = readdirSync(env.BACKUP_DIR!);
    const dump = files.find((f) => f.endsWith('.dump'))!;
    expect(files).toContain(dump.replace(/\.dump$/, '.attachments'));
    expect(readFileSync(join(snapshot()!, KEY), 'utf8')).toBe('hello');
  });

  it('все живые файлы на месте – зелёная проверка, число вложений в строке', async () => {
    const r = await script('restore-check.sh');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('вложений 1');
    expect(r.out).not.toContain('ОШИБКА');
  });

  it('таблицы вложений ещё нет – пропуск', async () => {
    const r = await script('restore-check.sh', { HAS_ATTACHMENTS: 'f' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('вложений 0');
  });

  it('файла нет в снимке – ОШИБКА с адресом файла', async () => {
    const other = `cd/${'cd'.repeat(32)}`;
    const rows = join(tmp, 'rows-missing');
    writeFileSync(rows, `${KEY} 5\n${other} 7\n`);
    const r = await script('restore-check.sh', { ATT_ROWS: rows });
    expect(r.code).toBe(1);
    expect(r.out).toContain('ОШИБКА');
    expect(r.out).toContain(`нет файла вложения: ${other}`);
  });

  it('другой размер – ОШИБКА: обрезанный файл не считается восстановленным', async () => {
    const rows = join(tmp, 'rows-size');
    writeFileSync(rows, `${KEY} 6\n`);
    const r = await script('restore-check.sh', { ATT_ROWS: rows });
    expect(r.code).toBe(1);
    expect(r.out).toContain('размер вложения');
  });

  it('снимка нет, а живые строки есть – ОШИБКА; строк нет – снимок не нужен', async () => {
    const snap = snapshot()!;
    rmSync(snap, { recursive: true });
    try {
      const r = await script('restore-check.sh');
      expect(r.code).toBe(1);
      expect(r.out).toContain('живых вложений');
      const empty = join(tmp, 'rows-empty');
      writeFileSync(empty, '');
      expect((await script('restore-check.sh', { ATT_ROWS: empty })).code).toBe(0);
    } finally {
      mkdirSync(join(snap, 'ab'), { recursive: true });
      writeFileSync(join(snap, KEY), 'hello');
    }
  });

  it('путь из базы не выходит за снимок', async () => {
    const rows = join(tmp, 'rows-escape');
    writeFileSync(rows, '../../etc/passwd 1\n');
    const r = await script('restore-check.sh', { ATT_ROWS: rows });
    expect(r.code).toBe(1);
    expect(r.out).toContain('недопустимый storage_key');
    expect(existsSync(join(tmp, 'etc'))).toBe(false);
  });
});

describe('Caddy и compose: каталог вложений не раздаётся', () => {
  const caddy = readFileSync(join(ROOT, 'deploy/Caddyfile.yu-club'), 'utf8');
  const compose = readFileSync(join(ROOT, 'deploy/compose.yml'), 'utf8');

  it('на обоих доменах адреса вложений – 404, раздачи файлов из каталога нет', () => {
    const sites = caddy.split(/^(?=yu[-\w.]+nip\.io \{)/m).filter((s) => s.includes('nip.io {'));
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toMatch(/@attachments path \/attachments \/attachments\/\*/);
      expect(site).toMatch(/handle @attachments \{\s+respond 404\s+\}/);
    }
    expect(caddy).not.toMatch(/root \* .*attachments/);
    expect(caddy).not.toMatch(/Caddyfile.*attachments.*file_server/);
  });

  it('том вложений – только у api, том вне веб-корня, у сервиса caddy в проекте его нет', () => {
    const lines = compose.split('\n').filter((l) => /^\s+- .*:\/data\/attachments/.test(l));
    expect(lines).toHaveLength(1);
    const blocks = compose.split(/^ {2}(?=[a-z]+:\n)/m);
    const owner = blocks.filter((b) => /:\/data\/attachments/.test(b));
    expect(owner).toHaveLength(1);
    expect(owner[0]!.startsWith('api:')).toBe(true);
  });
});

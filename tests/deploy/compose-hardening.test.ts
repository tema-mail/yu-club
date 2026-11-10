// Защита контейнеров (скилл «безопасность»): наружу ничего не публикуется (вход только через общий Caddy),
// процессы Node – без capabilities и без повышения привилегий, образы под USER node; .env.example – все переменные
// compose без настоящих значений. Статически по тексту: на маке Docker нет (TEHDOLG 7.3 – живая проверка `docker ps`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const compose = readFileSync(join(ROOT, 'deploy/compose.yml'), 'utf8');
const dev = readFileSync(join(ROOT, 'deploy/compose.dev.yml'), 'utf8');
const example = readFileSync(join(ROOT, 'deploy/.env.example'), 'utf8');
const services = Object.fromEntries(
  compose.split(/^ {2}(?=[a-z]+:\n)/m).filter((b) => /^[a-z]+:\n/.test(b)).map((b) => [b.slice(0, b.indexOf(':')), b]),
);
const NODE_SERVICES = ['migrate', 'api', 'worker', 'crm', 'site'];

describe('compose: контейнеры не торчат наружу и не имеют лишних прав', () => {
  it('ни один сервис не публикует порты; внутренняя сеть internal: true', () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/internal:\n\s+name: yu-club-internal\n\s+internal: true/);
    expect(dev).toMatch(/- "127\.0\.0\.1:5432:5432"/);
  });

  for (const name of NODE_SERVICES) {
    it(`${name}: no-new-privileges и cap_drop ALL`, () => {
      expect(services[name], name).toBeDefined();
      expect(services[name]).toMatch(/security_opt:\s*\[\s*"?no-new-privileges:true"?\s*\]/);
      expect(services[name]).toMatch(/cap_drop:\s*\[\s*ALL\s*\]/);
    });
  }

  it('образы Node запускаются под USER node', () => {
    for (const app of ['api', 'crm', 'site']) expect(readFileSync(join(ROOT, `apps/${app}/Dockerfile`), 'utf8')).toMatch(/^USER node$/m);
  });
});

describe('deploy/.env.example', () => {
  it('содержит каждую переменную compose.yml и не содержит настоящих значений', () => {
    const vars = [...new Set([...compose.matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]!))];
    expect(vars.length).toBeGreaterThan(20);
    for (const v of vars) expect(example, v).toMatch(new RegExp(`^${v}=`, 'm'));
    // секреты – только пустые: их генерирует deploy.sh на сервере
    for (const v of ['POSTGRES_PASSWORD', 'YU_OWNER_PASSWORD', 'YU_APP_PASSWORD', 'YU_BOSS_PASSWORD', 'YU_REPORTS_PASSWORD', 'SESSION_PEPPER', 'CERT_PEPPER', 'PREVIEW_SECRET', 'VAPID_PRIVATE_KEY', 'UNSUBSCRIBE_SECRET']) {
      expect(example, v).toMatch(new RegExp(`^${v}=$`, 'm'));
    }
    expect(example).not.toMatch(/[0-9a-f]{32,}/i);
  });
});

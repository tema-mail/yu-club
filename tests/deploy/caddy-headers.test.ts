// Защитные заголовки обоих доменов в deploy/Caddyfile.yu-club (скилл «защита-сайта», проверка перед боем, TEHDOLG 7.3).
// Статически по тексту конфига: стенд выкладывается только deploy/deploy.sh, живой `curl -sI` – шаг 7.3 перед боем.
// CSP – через `?` (значение по умолчанию): ответ API со своей, более строгой политикой (выдача вложения №350 – `default-src 'none'; sandbox`,
// PDF медиатеки – `sandbox`) остаётся как есть, а не затирается общей. HSTS на стенде нет намеренно: `tls internal` (самоподписанный) +
// HSTS = браузер не даст открыть стенд; строка для боя – TEHDOLG 1.3.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const caddy = readFileSync(join(ROOT, 'deploy/Caddyfile.yu-club'), 'utf8');
const SITE_DOMAIN = 'yu-club.168.113.179.49.nip.io';
const blocks = caddy.split(/^(?=yu[-\w.]+nip\.io \{)/m).filter((s) => s.includes('nip.io {'));
const site = blocks.find((b) => b.startsWith(`${SITE_DOMAIN} {`))!;
const crm = blocks.find((b) => b.startsWith('yu-crm.'))!;

/** Значение заголовка из верхнего блока header { … } домена. */
function header(block: string, name: string): string | undefined {
  const top = /header \{([\s\S]*?)\n\t\}/.exec(block)?.[1] ?? '';
  const m = new RegExp(`^\\s*(\\??)${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} "([^"]*)"`, 'm').exec(top);
  return m ? `${m[1]}${m[2]}` : undefined;
}
const csp = (block: string) => header(block, 'Content-Security-Policy');
const directive = (policy: string, name: string) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name)?.slice(name.length).trim();

describe('Caddyfile: защитные заголовки на обоих доменах', () => {
  it('два домена: сайт и CRM', () => {
    expect(blocks).toHaveLength(2);
    expect(site).toBeDefined();
    expect(crm).toBeDefined();
  });

  for (const [name, block] of [['сайт', site], ['CRM', crm]] as const) {
    it(`${name}: nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, без Server, noindex`, () => {
      expect(header(block, 'X-Content-Type-Options')).toBe('nosniff');
      expect(header(block, 'X-Frame-Options')).toBe('DENY');
      expect(header(block, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(header(block, 'X-Robots-Tag')).toBe('noindex, nofollow');
      const pp = header(block, 'Permissions-Policy') ?? '';
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) expect(pp, feature).toContain(`${feature}=()`);
      expect(block).toMatch(/^\t\t-Server$/m);
    });

    it(`${name}: CSP – значение по умолчанию (?), без * и unsafe-eval, frame-ancestors 'none', base-uri, form-action, object-src 'none'`, () => {
      const policy = csp(block);
      expect(policy, 'нет Content-Security-Policy').toBeDefined();
      expect(policy!.startsWith('?'), 'CSP должна быть ?-умолчанием: ответ API со своей политикой не затирается').toBe(true);
      const p = policy!.slice(1);
      expect(p).not.toMatch(/(^|\s)\*(\s|;|$)/);
      expect(p).not.toContain('unsafe-eval');
      expect(p).not.toMatch(/\bhttp:/);
      expect(directive(p, 'default-src')).toBe("'self'");
      expect(directive(p, 'frame-ancestors')).toBe("'none'");
      expect(directive(p, 'object-src')).toBe("'none'");
      expect(directive(p, 'form-action')).toBe("'self'");
      expect(directive(p, 'connect-src')).toBe("'self'");
      expect(directive(p, 'base-uri')).toMatch(/^'self'/);
    });
  }

  it('сайт: service worker /sw.js разрешён (worker-src), чужие фреймы – нет', () => {
    const p = csp(site)!.slice(1);
    expect(directive(p, 'worker-src')).toBe("'self'");
    expect(directive(p, 'frame-src')).toBe("'none'");
  });

  it('CRM: предпросмотр – <iframe srcdoc> с <base href> на сайт: домен сайта в base-uri, style-src, img-src; frame-src self', () => {
    const p = csp(crm)!.slice(1);
    const origin = `https://${SITE_DOMAIN}`;
    for (const d of ['base-uri', 'style-src', 'img-src', 'font-src']) expect(directive(p, d), d).toContain(origin);
    expect(directive(p, 'frame-src')).toBe("'self'");
    // deploy.sh заменяет адрес стенда на боевой по всему файлу – домен в CSP переедет вместе с блоком
    expect(crm.split(SITE_DOMAIN).length - 1).toBeGreaterThanOrEqual(4);
  });

  it('медиа: PDF – скачивание и sandbox (своя CSP раньше общей по умолчанию)', () => {
    expect(site).toMatch(/header @pdf Content-Disposition "attachment"/);
    expect(site).toMatch(/header @pdf Content-Security-Policy "sandbox"/);
  });
});

// Настоящий адрес посетителя для лимита входа (K12: > 50 неудач с IP за 15 мин).
// Входящему X-Forwarded-For верим, только если соединение пришло от доверенного прокси (TRUSTED_PROXIES);
// тогда берём самый правый адрес цепочки, который не является доверенным прокси. Иначе – адрес соединения.

/** По умолчанию: loopback и сети Docker (bridge и сети Compose – 172.16.0.0/12). */
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1,172.16.0.0/12';

function normalize(ip: string): string {
  const t = ip.trim().toLowerCase();
  return t.startsWith('::ffff:') && t.includes('.') ? t.slice(7) : t;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function matches(ip: string, rule: string): boolean {
  const [base, bitsRaw] = rule.split('/');
  if (!base) return false;
  if (bitsRaw === undefined) return normalize(base) === ip;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(normalize(base));
  const bits = Number(bitsRaw);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false; // CIDR – только IPv4
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

export function parseTrusted(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_TRUSTED_PROXIES).split(',').map((s) => s.trim()).filter(Boolean);
}

export function isTrusted(ip: string, trusted: string[]): boolean {
  const n = normalize(ip);
  return trusted.some((r) => matches(n, r));
}

export function clientIp(remote: string, xff: string | null, trusted: string[]): string {
  const peer = normalize(remote);
  if (!xff || !isTrusted(peer, trusted)) return peer;
  const chain = xff.split(',').map(normalize).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(chain[i]!, trusted)) return chain[i]!;
  }
  return chain[0] ?? peer; // вся цепочка – доверенные прокси
}

// Коды ошибок модуля certificates (K16 §12; K10 §7 – CERTIFICATE_* отдаёт обработчик способа certificate).
// BALANCE_BELOW_LIMIT (K3) наружу не отдаётся – переводится в CERTIFICATE_INSUFFICIENT (K16 §5 п.7).
import type { HttpStatus } from '../../core/errors.ts';

export const errors = {
  CERTIFICATE_NOT_FOUND: 404, // нет номера или неверный код – одно сообщение (K16 §3)
  CERTIFICATE_PIN_LOCKED: 429, // 5 неверных кодов, блок 15 минут (Q-105)
  CERTIFICATE_EXPIRED: 409, // now ≥ expiresAt (08 §6.3 п.3)
  CERTIFICATE_NOT_ACTIVE: 409, // cancelled, needs_review, used_up
  CERTIFICATE_INSUFFICIENT: 409, // остаток меньше суммы (details.balanceKop)
  CERTIFICATE_USED: 409, // отмена продажи использованного
  CORRECTION_EXCEEDS_NOMINAL: 422, // остаток после корректировки > номинала (08 §9.3)
  NOMINAL_OUT_OF_RANGE: 422, // номинал ≤ 0 или вне certificate.nominal_min_kop / max_kop
} as const satisfies Record<string, HttpStatus>;

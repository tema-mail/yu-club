// Сборка реестров модулей (ADR 0002 §Реестры): коды ошибок и действий аудита.
// Единственное место, где core импортирует модули – и только их файлы реестров.
// Дубль кода между модулями (или с core) – ошибка при загрузке, то есть при старте и в тестах.
import { coreErrors } from './errors.ts';
import { ledgerErrors } from './ledger.ts';
import { settingsAudit, settingsErrors } from './settings.ts';
import { auditActions as bookingAudit } from '../modules/booking/audit.ts';
import { errors as bookingErrors } from '../modules/booking/errors.ts';
import { auditActions as clientsAudit } from '../modules/clients/audit.ts';
import { errors as clientsErrors } from '../modules/clients/errors.ts';
import { auditActions as contentAudit } from '../modules/content/audit.ts';
import { errors as contentErrors } from '../modules/content/errors.ts';
import { auditActions as financeAudit } from '../modules/finance/audit.ts';
import { errors as financeErrors } from '../modules/finance/errors.ts';
import { auditActions as loyaltyAudit } from '../modules/loyalty/audit.ts';
import { errors as loyaltyErrors } from '../modules/loyalty/errors.ts';
import { auditActions as certificatesAudit } from '../modules/certificates/audit.ts';
import { errors as certificatesErrors } from '../modules/certificates/errors.ts';
import { auditActions as dictionariesAudit } from '../modules/dictionaries/audit.ts';
import { errors as dictionariesErrors } from '../modules/dictionaries/errors.ts';
import { auditActions as equipmentAudit } from '../modules/equipment/audit.ts';
import { errors as equipmentErrors } from '../modules/equipment/errors.ts';
import { auditActions as eventsAudit } from '../modules/events/audit.ts';
import { errors as eventsErrors } from '../modules/events/errors.ts';
import { auditActions as networkAudit } from '../modules/network/audit.ts';
import { errors as networkErrors } from '../modules/network/errors.ts';
import { auditActions as notificationsAudit } from '../modules/notifications/audit.ts';
import { errors as notificationsErrors } from '../modules/notifications/errors.ts';
import { auditActions as pricingAudit } from '../modules/pricing/audit.ts';
import { errors as pricingErrors } from '../modules/pricing/errors.ts';
import { auditActions as reportsAudit } from '../modules/reports/audit.ts';
import { errors as reportsErrors } from '../modules/reports/errors.ts';
import { auditActions as resourcesAudit } from '../modules/resources/audit.ts';
import { errors as resourcesErrors } from '../modules/resources/errors.ts';
import { auditActions as shiftsAudit } from '../modules/shifts/audit.ts';
import { errors as shiftsErrors } from '../modules/shifts/errors.ts';
import { auditActions as staffAudit } from '../modules/staff/audit.ts';
import { errors as staffErrors } from '../modules/staff/errors.ts';

const moduleErrors = {
  ledger: ledgerErrors,
  settings: settingsErrors,
  staff: staffErrors,
  dictionaries: dictionariesErrors,
  network: networkErrors,
  clients: clientsErrors,
  resources: resourcesErrors,
  booking: bookingErrors,
  pricing: pricingErrors,
  notifications: notificationsErrors,
  finance: financeErrors,
  loyalty: loyaltyErrors,
  certificates: certificatesErrors,
  shifts: shiftsErrors, // Э3, K18 §15
  equipment: equipmentErrors, // Э3, K19 §15
  events: eventsErrors, // Э3, K20 §16
  // K17 §14 – связи операций кассы (modules/finance/links.ts, S3-05); строкой здесь, а не в finance/errors.ts (решение D3-04)
  finance_links: {
    OPERATION_ALREADY_LINKED: 409, // у операции уже есть живая связь (details.ref)
    OPERATION_LINK_INVALID: 422, // роль не по виду операции, сторнирована, не тот источник (details.reason)
    EVENT_REFUND_EXCEEDS_INCOME: 409, // возврат больше непогашенной части поступления (details.availableKop)
    OPERATION_REVERSED: 409, // возврат по сторнированному поступлению
    INCOME_HAS_REFUNDS: 409, // сторно поступления с живыми возвратами (S3-54)
  },
  content: contentErrors,
  reports: reportsErrors,
} as const;
const moduleAudit = {
  settings: settingsAudit,
  staff: staffAudit,
  dictionaries: dictionariesAudit,
  network: networkAudit,
  clients: clientsAudit,
  resources: resourcesAudit,
  booking: bookingAudit,
  pricing: pricingAudit,
  notifications: notificationsAudit,
  // K3 правило 6: проводку и сторно пишет в аудит модуль-потребитель; код один на всех (K2, Э2).
  ledger: ['ledger.posted', 'ledger.reversed'] as const,
  finance: financeAudit,
  loyalty: loyaltyAudit,
  certificates: certificatesAudit,
  shifts: shiftsAudit, // Э3, K18 §17
  equipment: equipmentAudit, // Э3, K19 §17
  events: eventsAudit, // Э3, K20 §18
  finance_links: ['finance.operation.linked', 'finance.operation.unlinked'] as const, // K17 §14, решение D3-04
  content: contentAudit,
  reports: reportsAudit,
} as const;

type ModuleErrors = typeof moduleErrors;
export type ModuleErrorCode = { [M in keyof ModuleErrors]: keyof ModuleErrors[M] }[keyof ModuleErrors];
export type ModuleAuditAction = (typeof moduleAudit)[keyof typeof moduleAudit][number];

/** Бросает, если один код объявлен в двух местах. Экспортируется для теста. */
export function assertNoDuplicates(kind: string, sources: Record<string, readonly string[]>): void {
  const owner = new Map<string, string>();
  for (const [source, codes] of Object.entries(sources)) {
    for (const code of codes) {
      const prev = owner.get(code);
      if (prev !== undefined) throw new Error(`Реестр ${kind}: код ${code} объявлен и в ${prev}, и в ${source}`);
      owner.set(code, source);
    }
  }
}

assertNoDuplicates('ошибок', {
  core: Object.keys(coreErrors),
  ...Object.fromEntries(Object.entries(moduleErrors).map(([m, e]) => [m, Object.keys(e)])),
});
assertNoDuplicates('аудита', moduleAudit);

/** HTTP-статус любого зарегистрированного кода ошибки. */
export const errorStatus: Readonly<Record<string, number>> = Object.freeze({
  ...coreErrors,
  ...Object.assign({}, ...Object.values(moduleErrors)),
});

export const registeredAuditActions: ReadonlySet<string> = new Set(Object.values(moduleAudit).flat());

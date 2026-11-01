// Сборка реестров модулей (ADR 0002 §Реестры): коды ошибок и действий аудита.
// Единственное место, где core импортирует модули – и только их файлы реестров.
// Дубль кода между модулями (или с core) – ошибка при загрузке, то есть при старте и в тестах.
import { coreErrors } from './errors.ts';
import { ledgerErrors } from './ledger.ts';
import { settingsAudit, settingsErrors } from './settings.ts';
import { errors as bookingErrors } from '../modules/booking/errors.ts';
import { auditActions as clientsAudit } from '../modules/clients/audit.ts';
import { errors as clientsErrors } from '../modules/clients/errors.ts';
import { auditActions as dictionariesAudit } from '../modules/dictionaries/audit.ts';
import { errors as dictionariesErrors } from '../modules/dictionaries/errors.ts';
import { auditActions as networkAudit } from '../modules/network/audit.ts';
import { errors as networkErrors } from '../modules/network/errors.ts';
import { auditActions as resourcesAudit } from '../modules/resources/audit.ts';
import { errors as resourcesErrors } from '../modules/resources/errors.ts';
import { auditActions as staffAudit } from '../modules/staff/audit.ts';
import { errors as staffErrors } from '../modules/staff/errors.ts';

const moduleErrors = { ledger: ledgerErrors, settings: settingsErrors, staff: staffErrors, dictionaries: dictionariesErrors, network: networkErrors, clients: clientsErrors, resources: resourcesErrors, booking: bookingErrors } as const;
const moduleAudit = { settings: settingsAudit, staff: staffAudit, dictionaries: dictionariesAudit, network: networkAudit, clients: clientsAudit, resources: resourcesAudit } as const;

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

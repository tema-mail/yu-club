// Предзагрузка (node --import) для мока, сервера CRM или сайта и процессов тестов: все видят одно зафиксированное «сейчас» (см. e2e.ts).
import { shiftDate } from './clock-shim.ts';

const offset = process.env.E2E_CLOCK_OFFSET_MS;
if (offset !== undefined) shiftDate(Number(offset));

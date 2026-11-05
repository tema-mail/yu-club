// S4-71. Запись файлов экспорта (K24 §7, 14 §16): CSV и XLSX потоком – строки не копятся в памяти, лимит 200 000 строк.
// Выбор: exceljs НЕ подключён (аудит 05.11.2026: две уязвимости moderate через uuid, последний выпуск 4.4.0 – октябрь 2023, пакеты archiver@5,
// unzipper@0.10 старые). Запасной вариант контракта – свой потоковый XLSX: zip-поток на node:zlib + XML листа, зависимостей нет.
// Защита от формул – только текстовые ячейки: начало на = + - @ \t \r получает апостроф; числа и даты не трогаются (иначе ломаются суммы в Excel).
// В XLSX строка всегда inlineStr, формул в файле нет. Даты в файл приходят уже в зоне филиала: 'ГГГГ-ММ-ДД ЧЧ:ММ' – зону применяет вызывающий.
import { crc32, createDeflateRaw } from 'node:zlib';
import { AppError } from '../../core/errors.ts';

export const EXPORT_MAX_ROWS = 200_000;

/** Тип столбца. kop и centi – целые копейки и сотые балла, в файле – с двумя знаками; datetime – строка в зоне филиала. */
export type ColumnKind = 'text' | 'number' | 'kop' | 'centi' | 'datetime';
export type CellValue = string | number | null;

export interface ExportColumn {
  title: string;
  kind: ColumnKind;
}

/** Строка шапки файла (14 §16): подпись и значение; значение итога – числом, как и в данных. */
export interface HeaderLine {
  label: string;
  value: CellValue;
  kind?: ColumnKind | undefined;
}

export interface ExportDocument {
  /** Заголовок: название, период и правило суток, время формирования, фильтры, область, итоги, пояснение единиц. */
  header: readonly HeaderLine[];
  columns: readonly ExportColumn[];
  rows: AsyncIterable<readonly CellValue[]>;
}

export interface WriteProgress {
  rows: number;
}

/** Текстовая ячейка: формула становится текстом. */
export function protectText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Целое в копейках/сотых → строка с двумя знаками без арифметики с плавающей точкой: -15000 → '-150.00'. */
export function hundredths(value: number, point = '.'): string {
  const v = Math.round(value);
  const abs = Math.abs(v);
  return `${v < 0 ? '-' : ''}${Math.trunc(abs / 100)}${point}${String(abs % 100).padStart(2, '0')}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const parseLocal = (value: string): RegExpExecArray | null => LOCAL_RE.exec(value);

type Typed = { type: 'empty' } | { type: 'text'; text: string } | { type: 'number'; text: string; csv: string } | { type: 'date'; serial: number; csv: string };

/** Значение ячейки по типу столбца. Значение не того типа не становится числом: идёт текстом и проходит защиту от формул. */
function typed(value: CellValue, kind: ColumnKind): Typed {
  if (value === null || value === '') return { type: 'empty' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: 'empty' };
    if (kind === 'kop' || kind === 'centi') return { type: 'number', text: hundredths(value), csv: hundredths(value, ',') };
    return { type: 'number', text: String(value), csv: String(value).replace('.', ',') };
  }
  if (kind === 'datetime') {
    const m = parseLocal(value);
    if (m) {
      const [, y, mo, d, h, mi, s] = m;
      const days = (Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)) - Date.UTC(1899, 11, 30)) / 86_400_000;
      return { type: 'date', serial: days, csv: `${d}.${mo}.${y} ${h}:${mi}` };
    }
  }
  return { type: 'text', text: protectText(value) };
}

/** Перебор строк с подсчётом: 200 001-я строка – EXPORT_TOO_LARGE, запись обрывается, файла нет (writeAtomic удаляет временный). */
async function* counted(doc: ExportDocument, progress: WriteProgress): AsyncGenerator<readonly CellValue[]> {
  for await (const row of doc.rows) {
    progress.rows += 1;
    if (progress.rows > EXPORT_MAX_ROWS) throw new AppError('EXPORT_TOO_LARGE', 422, 'Слишком много строк – сузьте период', { maxRows: EXPORT_MAX_ROWS });
    yield row;
  }
}

// ---- CSV: UTF-8 с BOM, разделитель «;», кавычки RFC 4180, \r\n

const csvQuote = (s: string): string => (/[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function csvCell(value: CellValue, kind: ColumnKind): string {
  const t = typed(value, kind);
  if (t.type === 'empty') return '';
  if (t.type === 'text') return csvQuote(t.text);
  return t.csv;
}

const csvLine = (cells: string[]): Buffer => Buffer.from(`${cells.join(';')}\r\n`);

export async function* csvStream(doc: ExportDocument, progress: WriteProgress = { rows: 0 }): AsyncGenerator<Uint8Array> {
  yield Buffer.from([0xef, 0xbb, 0xbf]);
  for (const h of doc.header) yield csvLine([csvCell(h.label, 'text'), csvCell(h.value, h.kind ?? 'text')]);
  yield csvLine([]);
  yield csvLine(doc.columns.map((c) => csvCell(c.title, 'text')));
  const kinds = doc.columns.map((c) => c.kind);
  for await (const row of counted(doc, progress)) yield csvLine(kinds.map((k, i) => csvCell(row[i] ?? null, k)));
}

// ---- zip-поток: DEFLATE без предварительных размеров (бит 3, дескриптор после данных), запись без zip64

const ZIP_LIMIT = 0xffff_ffff;
const dosTime = (d: Date): { time: number; date: number } => ({
  time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.trunc(d.getUTCSeconds() / 2),
  date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
});

const FLAGS = 0x0808; // бит 3 – размеры в дескрипторе, бит 11 – имена в UTF-8

function localHeader(name: Buffer, at: { time: number; date: number }): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(8, 8);
  b.writeUInt16LE(at.time, 10);
  b.writeUInt16LE(at.date, 12);
  b.writeUInt16LE(name.length, 26);
  return Buffer.concat([b, name]);
}

interface ZipEntry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

function descriptor(e: ZipEntry): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(e.crc, 4);
  b.writeUInt32LE(e.compressed, 8);
  b.writeUInt32LE(e.size, 12);
  return b;
}

function centralHeader(e: ZipEntry, at: { time: number; date: number }): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(8, 10);
  b.writeUInt16LE(at.time, 12);
  b.writeUInt16LE(at.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.compressed, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(e.name.length, 28);
  b.writeUInt32LE(e.offset, 42);
  return Buffer.concat([b, e.name]);
}

function endOfCentral(count: number, size: number, offset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  return b;
}

const zipTooLarge = () => new AppError('EXPORT_TOO_LARGE', 422, 'Файл слишком большой – сузьте период');

/** Сжатие одной части потоком: сжатое отдаётся по готовности, в памяти – только окно deflate. */
async function* deflateEntry(entry: ZipEntry, source: AsyncIterable<string | Buffer>): AsyncGenerator<Buffer> {
  const deflate = createDeflateRaw({ level: 6 });
  const pending: Buffer[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  deflate.on('data', (c: Buffer) => {
    pending.push(c);
    notify();
  });
  deflate.on('end', () => {
    done = true;
    notify();
  });
  deflate.on('error', (err: Error) => {
    failure = err;
    notify();
  });
  const drain = function* (): Generator<Buffer> {
    while (pending.length > 0) {
      const c = pending.shift()!;
      entry.compressed += c.length;
      yield c;
    }
  };
  for await (const part of source) {
    const chunk = typeof part === 'string' ? Buffer.from(part) : part;
    entry.crc = crc32(chunk, entry.crc);
    entry.size += chunk.length;
    if (entry.size > ZIP_LIMIT) throw zipTooLarge();
    if (!deflate.write(chunk)) await new Promise<void>((resolve) => deflate.once('drain', () => resolve()));
    yield* drain();
  }
  deflate.end();
  while (!done) {
    if (failure) throw failure;
    if (pending.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    yield* drain();
  }
  yield* drain();
  if (failure) throw failure;
}

async function* zipStream(parts: ReadonlyArray<{ name: string; data: AsyncIterable<string | Buffer> }>, now: Date): AsyncGenerator<Uint8Array> {
  const at = dosTime(now);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const part of parts) {
    const entry: ZipEntry = { name: Buffer.from(part.name), crc: 0, compressed: 0, size: 0, offset };
    entries.push(entry);
    const head = localHeader(entry.name, at);
    offset += head.length;
    yield head;
    for await (const c of deflateEntry(entry, part.data)) {
      offset += c.length;
      if (offset > ZIP_LIMIT) throw zipTooLarge();
      yield c;
    }
    const d = descriptor(entry);
    offset += d.length;
    yield d;
  }
  const central = Buffer.concat(entries.map((e) => centralHeader(e, at)));
  yield central;
  yield endOfCentral(entries.length, central.length, offset);
}

// ---- XLSX: лист «Данные» и лист «Параметры»

// символы, запрещённые в XML 1.0, выбрасываются: иначе Excel считает файл повреждённым
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const xmlEscape = (s: string): string => s.replace(XML_ILLEGAL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE_HUNDREDTHS = 1;
const STYLE_DATETIME = 2;
const STYLE_HEADER = 3;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy\\ hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Данные" sheetId="1" r:id="rId1"/><sheet name="Параметры" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const SHEET_OPEN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
const SHEET_CLOSE = '</sheetData></worksheet>';

function columnRef(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.trunc((n - 1) / 26);
  }
  return out;
}

function xlsxCell(ref: string, value: CellValue, kind: ColumnKind, textStyle = 0): string {
  const t = typed(value, kind);
  if (t.type === 'empty') return '';
  if (t.type === 'number') return `<c r="${ref}"${kind === 'kop' || kind === 'centi' ? ` s="${STYLE_HUNDREDTHS}"` : ''}><v>${t.text}</v></c>`;
  if (t.type === 'date') return `<c r="${ref}" s="${STYLE_DATETIME}"><v>${t.serial}</v></c>`;
  return `<c r="${ref}"${textStyle ? ` s="${textStyle}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(t.text)}</t></is></c>`;
}

async function* dataSheet(doc: ExportDocument, progress: WriteProgress): AsyncGenerator<string> {
  yield SHEET_OPEN;
  yield `<row r="1">${doc.columns.map((c, i) => xlsxCell(`${columnRef(i)}1`, c.title, 'text', STYLE_HEADER)).join('')}</row>`;
  const refs = doc.columns.map((_, i) => columnRef(i));
  const kinds = doc.columns.map((c) => c.kind);
  let r = 1;
  for await (const row of counted(doc, progress)) {
    r += 1;
    yield `<row r="${r}">${kinds.map((k, i) => xlsxCell(`${refs[i]}${r}`, row[i] ?? null, k)).join('')}</row>`;
  }
  yield SHEET_CLOSE;
}

async function* paramsSheet(doc: ExportDocument): AsyncGenerator<string> {
  yield SHEET_OPEN;
  let r = 0;
  for (const h of doc.header) {
    r += 1;
    yield `<row r="${r}">${xlsxCell(`A${r}`, h.label, 'text', STYLE_HEADER)}${xlsxCell(`B${r}`, h.value, h.kind ?? 'text')}</row>`;
  }
  yield SHEET_CLOSE;
}

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

export function xlsxStream(doc: ExportDocument, progress: WriteProgress = { rows: 0 }, now: Date = new Date()): AsyncGenerator<Uint8Array> {
  return zipStream(
    [
      { name: '[Content_Types].xml', data: once(CONTENT_TYPES) },
      { name: '_rels/.rels', data: once(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: once(WORKBOOK) },
      { name: 'xl/_rels/workbook.xml.rels', data: once(WORKBOOK_RELS) },
      { name: 'xl/styles.xml', data: once(STYLES) },
      { name: 'xl/worksheets/sheet1.xml', data: dataSheet(doc, progress) },
      { name: 'xl/worksheets/sheet2.xml', data: paramsSheet(doc) },
    ],
    now,
  );
}

export type ExportFormat = 'csv' | 'xlsx';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Поток файла нужного формата; progress.rows – сколько строк данных записано. */
export function exportStream(format: ExportFormat, doc: ExportDocument, progress: WriteProgress, now?: Date): AsyncGenerator<Uint8Array> {
  return format === 'csv' ? csvStream(doc, progress) : xlsxStream(doc, progress, now);
}

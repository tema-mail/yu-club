// S4-71: запись файлов (K24 §7). Формула в тексте → апостроф; отрицательное число – число; CSV: BOM, «;», RFC 4180, \r\n; XLSX читается как настоящий zip:
// CRC частей сходятся, числа – <v>, строки – inlineStr, формул нет; 200 001 строка → EXPORT_TOO_LARGE; длинный поток не копится в памяти.
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { csvStream, EXPORT_MAX_ROWS, exportStream, hundredths, protectText, xlsxStream, type CellValue, type ExportDocument } from '../../apps/api/src/modules/reports/export-files.ts';

async function* rowsOf(rows: ReadonlyArray<readonly CellValue[]>): AsyncGenerator<readonly CellValue[]> {
  yield* rows;
}
const doc = (rows: ReadonlyArray<readonly CellValue[]>): ExportDocument => ({
  header: [
    { label: 'Отчёт', value: 'Финансы' },
    { label: 'Итого', value: -15000, kind: 'kop' },
    { label: 'Фильтр', value: '=1+1' },
  ],
  columns: [
    { title: 'Комментарий', kind: 'text' },
    { title: 'Сумма', kind: 'kop' },
    { title: 'Минут', kind: 'number' },
    { title: 'Когда', kind: 'datetime' },
  ],
  rows: rowsOf(rows),
});

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

/** Чтение zip по центральному каталогу, как читают файл внешние программы: размеры и CRC – только оттуда. */
function unzip(file: Buffer): Map<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(file.readUInt32LE(at)).toBe(0x02014b50);
    const crc = file.readUInt32LE(at + 16);
    const compressed = file.readUInt32LE(at + 20);
    const size = file.readUInt32LE(at + 24);
    const nameLen = file.readUInt16LE(at + 28);
    const offset = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLen).toString();
    const lhNameLen = file.readUInt16LE(offset + 26);
    const lhExtra = file.readUInt16LE(offset + 28);
    const data = inflateRawSync(file.subarray(offset + 30 + lhNameLen + lhExtra, offset + 30 + lhNameLen + lhExtra + compressed));
    expect(data.length, name).toBe(size);
    expect(crc32(data) >>> 0, name).toBe(crc >>> 0);
    out.set(name, data.toString());
    at += 46 + nameLen;
  }
  return out;
}

describe('защита от формул и числа', () => {
  it('только текст начинающийся с = + - @ \\t \\r', () => {
    for (const v of ['=HYPERLINK("http://x")', '+7913', '-1', '@SUM(1)', '\tx', '\rx']) expect(protectText(v)).toBe(`'${v}`);
    for (const v of ['Иван', '1=1', 'a-b', '']) expect(protectText(v)).toBe(v);
  });
  it('копейки без плавающей точки', () => {
    expect(hundredths(-15000)).toBe('-150.00');
    expect(hundredths(-5, ',')).toBe('-0,05');
    expect(hundredths(19999999999)).toBe('199999999.99');
    expect(hundredths(0)).toBe('0.00');
  });
});

describe('CSV', () => {
  it('BOM, «;», кавычки, \\r\\n; формула – текст с апострофом; -150,00 – число без апострофа; дата без апострофа', async () => {
    const file = await collect(csvStream(doc([['=HYPERLINK("x")', -15000, 1.5, '2026-10-31 23:30'], ['a;b "c"\nd', 0, 10, null]])));
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = file.subarray(3).toString().split('\r\n');
    expect(lines[0]).toBe('Отчёт;Финансы');
    expect(lines[1]).toBe('Итого;-150,00');
    expect(lines[2]).toBe(`Фильтр;'=1+1`);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Комментарий;Сумма;Минут;Когда');
    expect(lines[5]).toBe(`"'=HYPERLINK(""x"")";-150,00;1,5;31.10.2026 23:30`);
    expect(lines[6]).toBe('"a;b ""c""\nd";0,00;10;');
    expect(lines[7]).toBe('');
  });

  it('число текстом в денежном столбце не становится числом и не минует защиту', async () => {
    const file = await collect(csvStream(doc([['x', '=1+1', null, 'не дата']])));
    expect(file.toString()).toContain(`x;'=1+1;;не дата`);
  });

  it('ведущий управляющий символ не обходит защиту: сначала чистка, потом апостроф', async () => {
    const file = await collect(csvStream(doc([['\u0001=HYPERLINK("x")', '\u0000\u001f+7', null, null]])));
    const line = file.subarray(3).toString().split('\r\n')[5];
    expect(line).toBe(`"'=HYPERLINK(""x"")";'+7;;`);
  });
});

describe('XLSX', () => {
  it('настоящий zip; листы «Данные» и «Параметры»; числа – <v>, даты – сериал с форматом, строки – inlineStr, формул нет', async () => {
    const progress = { rows: 0 };
    const zip = unzip(await collect(xlsxStream(doc([['=HYPERLINK("x")', -15000, 7, '2026-10-31 23:30'], ['<a>&"', 150, null, null]]), progress, new Date('2026-11-05T10:00:00Z'))));
    expect(progress.rows).toBe(2);
    expect(zip.get('xl/workbook.xml')).toContain('name="Данные"');
    expect(zip.get('xl/workbook.xml')).toContain('name="Параметры"');
    expect(zip.has('[Content_Types].xml')).toBe(true);
    const data = zip.get('xl/worksheets/sheet1.xml')!;
    expect(data).toContain(`t="inlineStr"><is><t xml:space="preserve">'=HYPERLINK(&quot;x&quot;)</t>`);
    expect(data).toContain('<c r="B2" s="1"><v>-150.00</v></c>');
    expect(data).toContain('<c r="C2"><v>7</v></c>');
    expect(Number(/<c r="D2" s="2"><v>([\d.]+)<\/v>/.exec(data)![1])).toBeCloseTo(46326 + 23.5 / 24, 8); // 31.10.2026 23:30
    expect(data).toContain('&lt;a&gt;&amp;&quot;');
    expect(data).not.toContain('<f>');
    const params = zip.get('xl/worksheets/sheet2.xml')!;
    expect(params).toContain('<c r="B2" s="1"><v>-150.00</v></c>');
    expect(params).toContain(`'=1+1`);
  });

  it('символы, запрещённые в XML, выбрасываются', async () => {
    const zip = unzip(await collect(xlsxStream(doc([['a\u0001b\ud800c', 0, 0, null]]))));
    expect(zip.get('xl/worksheets/sheet1.xml')).toContain('>abc</t>');
  });

  it('ведущий управляющий символ не обходит защиту от формул', async () => {
    const zip = unzip(await collect(xlsxStream(doc([['\u0001=HYPERLINK("x")', '\u0008@SUM(1)', 0, null]]))));
    const data = zip.get('xl/worksheets/sheet1.xml')!;
    expect(data).toContain(`<t xml:space="preserve">'=HYPERLINK(&quot;x&quot;)</t>`);
    expect(data).toContain(`<t xml:space="preserve">'@SUM(1)</t>`);
  });

  it('много столбцов: ссылки за Z – AA', async () => {
    const wide: ExportDocument = { header: [], columns: Array.from({ length: 28 }, (_, i) => ({ title: `к${i}`, kind: 'number' as const })), rows: rowsOf([Array.from({ length: 28 }, (_, i) => i)]) };
    const sheet = unzip(await collect(xlsxStream(wide))).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="AB2"><v>27</v></c>');
  });
});

describe('лимит и поток', () => {
  async function* many(n: number): AsyncGenerator<readonly CellValue[]> {
    for (let i = 0; i < n; i++) yield [`строка ${i}`, i, i, null];
  }
  const large = (n: number): ExportDocument => ({ ...doc([]), rows: many(n) });

  it.each(['csv', 'xlsx'] as const)('%s: 200 000 строк – можно, 200 001 – EXPORT_TOO_LARGE', async (format) => {
    const ok = { rows: 0 };
    await collect(exportStream(format, large(EXPORT_MAX_ROWS), ok));
    expect(ok.rows).toBe(EXPORT_MAX_ROWS);
    await expect(collect(exportStream(format, large(EXPORT_MAX_ROWS + 1), { rows: 0 }))).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', httpStatus: 422 });
  }, 120_000);

  it('XLSX потоком: первые байты приходят до конца данных, ошибка источника обрывает запись', async () => {
    let produced = 0;
    async function* failing(): AsyncGenerator<readonly CellValue[]> {
      for (; produced < 100; produced++) yield ['x', 1, 1, null];
      throw new Error('обрыв');
    }
    const stream = xlsxStream({ ...doc([]), rows: failing() });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(produced).toBe(0);
    await expect(collect(stream)).rejects.toThrow('обрыв');
  });
});

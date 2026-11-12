import { open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const maxFileBytes = 20 * 1024 * 1024;
const maxOutputChars = 100_000;

export async function readDocument(input: {
  path: string; sheet: number; startRow: number; rowCount: number; page: number;
}): Promise<unknown> {
  if (!isAbsolute(input.path)) throw new Error('Provide the absolute path of the document attached by the user.');
  const extension = extname(input.path).toLowerCase();
  if (extension !== '.xlsx' && extension !== '.pdf') throw new Error('Only .xlsx and .pdf documents are supported.');
  const file = await open(input.path, 'r');
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Document must be a regular file no larger than 20 MiB.');
    bytes = await file.readFile();
    if (bytes.length > maxFileBytes) throw new Error('Document is larger than 20 MiB.');
  } finally {
    await file.close();
  }

  let result: unknown;
  if (extension === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    const sheets = workbook.worksheets.map((sheet, index) => ({
      index: index + 1, name: sheet.name, rowCount: sheet.rowCount, state: sheet.state,
    }));
    const sheet = workbook.worksheets[input.sheet - 1];
    if (!sheet) throw new Error(`Sheet ${input.sheet} does not exist. The workbook contains ${sheets.length} sheets.`);
    const rows = [];
    for (let number = input.startRow; number <= Math.min(sheet.rowCount, input.startRow + input.rowCount - 1); number++) {
      const cells: { address: string; value: ExcelJS.CellValue }[] = [];
      sheet.getRow(number).eachCell(cell => { cells.push({ address: cell.address, value: cell.value }); });
      rows.push({ number, cells });
    }
    result = { format: 'xlsx', sheets, sheet: input.sheet, startRow: input.startRow, rows,
      nextRow: input.startRow + input.rowCount <= sheet.rowCount ? input.startRow + input.rowCount : null };
  } else {
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      if (input.page > pdf.numPages) throw new Error(`Page ${input.page} does not exist. The PDF has ${pdf.numPages} pages.`);
      const page = await pdf.getPage(input.page);
      const content = await page.getTextContent();
      const items = content.items.filter(item => 'str' in item).map(item => ({
        text: item.str, x: item.transform[4], y: item.transform[5], endOfLine: item.hasEOL,
      }));
      result = { format: 'pdf', page: input.page, pageCount: pdf.numPages, items,
        hasExtractableText: items.some(item => item.text.trim().length > 0) };
    } finally {
      await loading.destroy();
    }
  }
  if (JSON.stringify(result).length > maxOutputChars) {
    throw new Error(extension === '.xlsx'
      ? 'Document output is too large; request fewer rows.'
      : 'Page text is too large to return.');
  }
  return result;
}

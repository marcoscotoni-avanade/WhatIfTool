import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { readDocument } from '../../apps/mcp-server/src/documents';

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'whatif-document-test-'));
  directories.push(directory);
  return directory;
}

function samplePdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Project Alpha) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const options = { sheet: 1, startRow: 1, rowCount: 1, page: 1 };

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('local document reading', () => {
  it('reads workbook sheet metadata, cell values and paginated rows', async () => {
    const path = join(await temporaryDirectory(), 'plan.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Plan');
    sheet.addRow(['Code', 'Name']);
    sheet.addRow(['A1', { formula: '1+1', result: 2 }]);
    workbook.addWorksheet('Second').addRow(['Other']);
    await workbook.xlsx.writeFile(path);

    await expect(readDocument({ ...options, path })).resolves.toMatchObject({
      format: 'xlsx', sheets: [{ index: 1, name: 'Plan', rowCount: 2 }, { index: 2, name: 'Second' }],
      rows: [{ number: 1, cells: [{ address: 'A1', value: 'Code' }, { address: 'B1', value: 'Name' }] }],
      nextRow: 2,
    });
    await expect(readDocument({ ...options, path, startRow: 2 })).resolves.toMatchObject({
      rows: [{ number: 2, cells: [{ address: 'A2', value: 'A1' }, { address: 'B2', value: { formula: '1+1', result: 2 } }] }],
      nextRow: null,
    });
    await expect(readDocument({ ...options, path, sheet: 2 })).resolves.toMatchObject({
      rows: [{ cells: [{ value: 'Other' }] }],
    });
    await expect(readDocument({ ...options, path, sheet: 3 })).rejects.toThrow('Sheet 3 does not exist');
  });

  it('reads PDF text and reports pages without extractable text', async () => {
    const path = join(await temporaryDirectory(), 'plan.pdf');
    await writeFile(path, samplePdf());
    await expect(readDocument({ ...options, path })).resolves.toMatchObject({
      format: 'pdf', page: 1, pageCount: 2, hasExtractableText: true,
      items: expect.arrayContaining([expect.objectContaining({ text: 'Project Alpha', x: 72, y: 720 })]),
    });
    await expect(readDocument({ ...options, path, page: 2 })).resolves.toMatchObject({
      page: 2, hasExtractableText: false,
    });
    await expect(readDocument({ ...options, path, page: 3 })).rejects.toThrow('Page 3 does not exist');
  });

  it('rejects unsupported, relative, and invalid documents', async () => {
    await expect(readDocument({ ...options, path: 'plan.xlsx' })).rejects.toThrow('absolute path');
    await expect(readDocument({ ...options, path: join(await temporaryDirectory(), 'plan.txt') })).rejects.toThrow('Only .xlsx and .pdf');
    const path = join(await temporaryDirectory(), 'broken.pdf');
    await writeFile(path, 'not a pdf');
    await expect(readDocument({ ...options, path })).rejects.toThrow();
  });
});

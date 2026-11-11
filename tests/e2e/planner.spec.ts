import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

test('demo -> risk flow -> milestone contributions -> baseline -> what-if -> SQLite reopen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  await expect(page.locator('.plan-node')).toHaveCount(8);
  await page.getByRole('button', { name: '<> GO LIVE', exact: false }).click();
  await expect(page.locator('.rank-item').first()).toContainText('Data Migration');
  await expect(page.locator('.inspector-heading h2')).toHaveText('LIVE');
  await expect(page.locator('.milestone-focus')).toContainText('Risk Exposure');
  await expect(page.locator('.react-flow__edge-text').first()).toContainText('%');
  await page.getByRole('button', { name: 'Publish Baseline', exact: true }).click();
  await page.getByRole('button', { name: 'Publish baseline', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ Activity', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'New Scenario', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Supplier Delay');
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.locator('.react-flow__node[data-id="activity-2"]').click();
  await page.getByRole('spinbutton', { name: 'Duration', exact: true }).fill('18');
  await page.getByRole('spinbutton', { name: 'Duration', exact: true }).press('Tab');
  await expect(page.locator('.react-flow__node[data-id="activity-2"]')).toContainText('12 -> 18d');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('.comparison-table').first()).toContainText('+6d');
  const riskDelta = await page.locator('.comparison-table').first().locator('tbody tr').nth(1).locator('td').last().innerText();
  expect(Number(riskDelta)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved locally.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Recent Projects', exact: true }).click();
  await page.getByRole('button', { name: 'ERP Go Live', exact: false }).click();
  await expect(page.locator('.plan-node')).toHaveCount(8);
  await page.getByRole('combobox', { name: 'Active scenario', exact: true }).selectOption({ label: 'Supplier Delay' });
  await page.locator('.react-flow__node[data-id="activity-2"]').click();
  await expect(page.getByRole('spinbutton', { name: 'Duration', exact: true })).toHaveValue('18');
  expect(errors).toEqual([]);
});

test('grid edits synchronize selection, commands undo, cycles reject, dependencies edit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  const migration = page.locator('.ag-center-cols-container [row-id="activity-2"]');
  await migration.locator('[col-id="duration"]').dblclick();
  await page.locator('.ag-cell-inline-editing input').fill('16');
  await page.locator('.ag-cell-inline-editing input').press('Enter');
  await expect(page.locator('.react-flow__node[data-id="activity-2"]')).toContainText('16d');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="activity-2"]')).toContainText('12d');
  await page.locator('.react-flow__node[data-id="activity-2"]').click();
  await expect(page.locator('.ag-center-cols-container [row-id="activity-2"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.ag-center-cols-container [row-id="activity-5"] [col-id="duration"]').click();
  await expect(page.locator('.react-flow__node[data-id="activity-5"]')).toHaveClass(/selected/);
  await expect(page.locator('.inspector-heading h2')).toHaveText('UAT');
  await page.getByRole('button', { name: 'Add Dependency', exact: true }).click();
  await page.getByRole('combobox', { name: 'Predecessor', exact: true }).selectOption('activity-7');
  await page.getByRole('combobox', { name: 'Successor', exact: true }).selectOption('activity-0');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cycle');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.locator('.react-flow__edge[data-id="edge-0"]').click();
  await page.getByRole('combobox', { name: 'Dependency type', exact: true }).selectOption('SS');
  await expect(page.locator('.react-flow__edge[data-id="edge-0"]')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Dependency type', exact: true })).toHaveValue('SS');
  for (const type of ['FF', 'SF', 'FS']) {
    await page.getByRole('combobox', { name: 'Dependency type', exact: true }).selectOption(type);
    await expect(page.getByRole('combobox', { name: 'Dependency type', exact: true })).toHaveValue(type);
  }
  await page.getByRole('spinbutton', { name: 'Lag / lead', exact: true }).fill('-2');
  await page.getByRole('spinbutton', { name: 'Lag / lead', exact: true }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Lag / lead', exact: true })).toHaveValue('-2');
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  const paste = page.getByRole('textbox', { name: 'TSV edits', exact: true });
  await paste.pressSequentially('code\tduration\nMIG\t14');
  await expect(paste).toBeFocused();
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  await page.getByRole('button', { name: 'Fit View', exact: true }).first().click();
  await expect(page.locator('.react-flow__node[data-id="activity-2"]')).toContainText('14d');
});

test('Get Schema downloads an XLSX template with instructions and an example for spreadsheet paste', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Get Schema', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('activity-edit-template.xlsx');
  const path = await download.path();
  if (!path) throw new Error('XLSX template download is missing.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Istruzioni', 'Template']);
  const instructions = workbook.getWorksheet('Istruzioni')!;
  const template = workbook.getWorksheet('Template')!;
  const fields = Array.from({ length: template.columnCount }, (_, i) => String(template.getRow(1).getCell(i + 1).value));
  expect(fields).toEqual([
    'code', 'name', 'description', 'type', 'effortHours', 'duration', 'durationUnit', 'elapsedMode', 'scheduleMode',
    'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'constraintType', 'constraintDate', 'targetDate',
    'intrinsicRisk', 'probabilityOfDelay', 'delayP80', 'calendarId', 'ownerId', 'status',
  ]);
  expect(template.rowCount).toBe(2);
  for (const field of fields) {
    const row = instructions.getRows(10, fields.length)?.find(row => row.getCell(1).value === field);
    expect(row?.getCell(2).value).toBeTruthy();
  }
  expect(instructions.getRow(10 + fields.indexOf('type')).getCell(2).value).toBe('TASK | MILESTONE | SUMMARY');
  expect(template.getCell('A2').value).toBeTruthy();
  const sampleTsv = [1, 2].map(row => fields.map((_, i) => {
    const value = String(template.getRow(row).getCell(i + 1).value ?? '');
    return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join('\t')).join('\n');
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  await page.getByRole('textbox', { name: 'TSV edits', exact: true }).fill(sampleTsv);
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="activity-2"]').click();
  const originalName = await page.getByRole('textbox', { name: 'Activity name', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  await page.getByRole('textbox', { name: 'TSV edits', exact: true }).fill(
    'code\tdescription\townerId\r\nMIG\t"Review ""SCM""\nSignoff"\t',
  );
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Review "SCM"\nSignoff');
  await expect(page.getByRole('textbox', { name: 'Activity name', exact: true })).toHaveValue(originalName);
  await expect(page.getByRole('combobox', { name: 'Owner', exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Paste TSV inserts new activities alongside updates and undoes the entire batch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  await page.getByRole('textbox', { name: 'TSV edits', exact: true }).fill('code\tname\nNEW-1\tFirst task');
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  await page.getByRole('textbox', { name: 'TSV edits', exact: true }).fill('code\tname\nNEW-1\tUpdated task\nNEW-2\tSecond task');
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.ag-pinned-left-cols-container [col-id="name"]')).toHaveText(['Updated task', 'Second task']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.locator('.ag-pinned-left-cols-container [col-id="name"]')).toHaveText(['First task']);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Copy selected exports every data column and preserves empty cells', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('button', { name: '+ Add row', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Column with Header Selection', exact: true }).check();
  await page.getByRole('button', { name: 'Copy selected', exact: true }).click();
  await expect(page.getByText('Selected rows copied as tab-separated values.', { exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const [headers, ...records] = copied.split(/\r?\n/).map(line => line.split('\t'));
  if (!headers) throw new Error('Clipboard export is missing headers.');
  expect(headers).toEqual([
    'code', 'name', 'type', 'effortHours', 'duration', 'ownerId', 'tagsText', 'durationUnit',
    'scheduleMode', 'plannedStart', 'plannedFinish', 'calculatedStart', 'calculatedFinish',
    'predecessors', 'constraintType', 'constraintDate', 'totalSlack', 'risk', 'status',
  ]);
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record).toHaveLength(headers.length);
    for (const field of ['ownerId', 'tagsText', 'plannedStart', 'plannedFinish', 'predecessors', 'constraintDate']) {
      expect(record[headers.indexOf(field)]).toBe('');
    }
    expect(record[headers.indexOf('effortHours')]).toBe('0');
    expect(record[headers.indexOf('type')]).toBe('TASK');
    expect(record[headers.indexOf('status')]).toBe('NOT_STARTED');
  }
  expect(records[0]?.[0]).not.toBe(records[1]?.[0]);
});

test('creates activities in both views, layouts, and reopens a downloaded SQLite file', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('File Round Trip');
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('button', { name: '+ Add row', exact: true }).click();
  await page.getByRole('button', { name: '+ Milestone', exact: true }).click();
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Fit View', exact: true }).first().click();
  await expect(page.locator('.plan-node')).toHaveCount(3);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto Layout', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('File Round Trip.pgplan');
  const path = await download.path();
  expect(path).not.toBeNull();
  await expect(page.getByText('This browser does not support choosing a save location. The project was downloaded using your browser download settings.', { exact: true })).toBeVisible();
  await page.reload();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path!);
  await expect(page.locator('.plan-node')).toHaveCount(3);
  await expect(page.locator('.project-heading')).toContainText('File Round Trip');
});

test('right-click task cards duplicates the selected task or creates a nearby task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  const taskCard = page.locator('.react-flow__node[data-id="activity-2"]');
  await taskCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate task card' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
  await expect(page.getByRole('combobox', { name: 'Activity type', exact: true })).toHaveValue('TASK');
  await taskCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New task card' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);
  await expect(page.getByRole('combobox', { name: 'Activity type', exact: true })).toHaveValue('TASK');
});

test('project tag catalog assigns tags, filters the grid, and pane context creates a task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();

  await page.getByRole('button', { name: 'Setup', exact: true }).click();
  await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('Critical');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await page.getByRole('textbox', { name: 'New tag', exact: true }).fill('Finance');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await page.getByRole('button', { name: 'Apply tag catalog', exact: true }).click();

  await page.getByText('Select tags (0)', { exact: true }).click();
  await page.getByLabel('Critical', { exact: true }).check();
  await page.getByLabel('Finance', { exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Tags (read-only)', exact: true })).toHaveValue('Critical, Finance');
  const task = page.locator('.react-flow__node.selected');
  await expect(task.locator('.task-tag-chip')).toHaveText(['Critical', 'Finance']);
  const taskId = await task.getAttribute('data-id');
  const tagCell = page.locator(`.ag-center-cols-container [row-id="${taskId}"] [col-id="tagsText"]`);
  await expect(tagCell).toHaveText('Critical, Finance');

  const pane = page.locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await pane.click({ button: 'right', position: { x: paneBox!.width - 250, y: 30 } });
  const menuItems = page.getByRole('menuitem');
  await expect(menuItems).toHaveCount(1);
  await expect(menuItems.first()).toHaveText('New task card');
  await menuItems.first().click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(2);
  await page.locator('.ag-header-cell[col-id="tagsText"] .ag-header-cell-filter-button').click();
  const tagFilter = page.locator('.ag-popup .ag-filter input').first();
  await tagFilter.fill('Critical');
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1);
  await expect(page.locator('.ag-center-cols-container [row-id] [col-id="tagsText"]')).toHaveText('Critical, Finance');
});

test('global setup auto-saves every minute without a banner while manual save keeps its confirmation', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Auto Save Test');
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Setup', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable auto-save' }).check();
  await page.clock.fastForward(60_000);
  await expect(page.getByRole('img', { name: 'Auto-save completed' })).toBeVisible();
  await expect(page.getByText('Project saved locally.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved locally.', { exact: true })).toBeVisible();
});

test('team owner and effort proposals support accept, keep and undo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  const teamDialog = page.getByRole('dialog', { name: 'Project team' });
  const name = teamDialog.getByRole('textbox').last();
  await name.fill('Marco'); await name.press('Tab');
  const allocation = teamDialog.getByRole('spinbutton');
  await allocation.fill('50'); await allocation.press('Tab');
  await page.getByRole('button', { name: 'Apply team', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('combobox', { name: 'Owner', exact: true }).selectOption({ label: 'Marco (50%)' });
  await page.getByRole('button', { name: 'Keep durations', exact: true }).click();
  const taskCard = page.locator('.react-flow__node').first();
  await expect(taskCard.locator('.node-owner')).toContainText('Marco');
  await page.getByRole('spinbutton', { name: 'Effort (hours)', exact: true }).fill('40');
  await page.getByRole('spinbutton', { name: 'Effort (hours)', exact: true }).press('Tab');
  const proposal = page.getByRole('dialog', { name: 'Recalculate duration?' });
  await expect(proposal).toContainText('10 d');
  await page.getByRole('button', { name: 'Apply selected', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Duration', exact: true })).toHaveValue('10');
  await page.getByRole('spinbutton', { name: 'Effort (hours)', exact: true }).fill('48');
  await page.getByRole('spinbutton', { name: 'Effort (hours)', exact: true }).press('Tab');
  await expect(proposal).toContainText('12 d');
  await page.getByRole('button', { name: 'Keep durations', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Duration', exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('.react-flow__node').first().click();
  await expect(page.getByRole('spinbutton', { name: 'Effort (hours)', exact: true })).toHaveValue('40');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Project saved locally.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Recent Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New Project', exact: false }).click();
  await page.locator('.react-flow__node').first().click();
  await expect(page.getByRole('combobox', { name: 'Owner', exact: true })).toHaveValue(/.+/);
  await expect(page.getByRole('spinbutton', { name: 'Duration', exact: true })).toHaveValue('10');
});

test('TSV edits offer one selectable duration preview without overwriting an excluded duration', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  await page.getByRole('button', { name: 'Paste TSV', exact: true }).click();
  await page.getByRole('textbox', { name: 'TSV edits', exact: true }).fill('code\teffortHours\tduration\nMIG\t40\t7\nUAT\t32\t6');
  await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Recalculate duration?' });
  await expect(dialog).toContainText('MIG'); await expect(dialog).toContainText('UAT');
  await dialog.getByRole('checkbox').first().uncheck();
  await dialog.getByRole('button', { name: 'Apply selected' }).click();
  await expect(page.locator('.react-flow__node[data-id="activity-2"]')).toContainText('7d');
  await expect(page.locator('.react-flow__node[data-id="activity-5"]')).toContainText('4d');
});

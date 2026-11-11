import { expect, test } from '@playwright/test';

test('baseline management confirms deletion and archives referenced baselines without breaking scenarios', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
  await page.getByRole('button', { name: 'Publish Baseline', exact: true }).click();
  await page.getByRole('button', { name: 'Publish baseline', exact: true }).click();
  await page.getByRole('button', { name: 'Manage Baselines', exact: true }).click();
  await page.getByRole('button', { name: 'Delete baseline', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm delete', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Confirm baseline name' }).fill('Baseline v1');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText('Baseline v1');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'New Scenario', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: 'Manage Baselines', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete baseline', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('textbox', { name: 'Confirm baseline name' }).fill('Baseline v1');
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active scenario' }).locator('option')).not.toContainText(['[B] Baseline v1']);
  await expect(page.locator('.react-flow__node')).toHaveCount(8);
});

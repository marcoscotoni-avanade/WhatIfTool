import { expect, test } from '@playwright/test';

test('Save As requests a file location and writes a SQLite project to the chosen handle', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: async (options: { suggestedName: string }) => {
      document.documentElement.dataset.suggestedName = options.suggestedName;
      document.documentElement.dataset.pickerActivated = String(navigator.userActivation.isActive);
      return {
        name: 'Renamed project.pgplan',
        createWritable: async () => ({
          write: async (data: ArrayBuffer) => {
            document.documentElement.dataset.savedSignature = new TextDecoder().decode(new Uint8Array(data).slice(0, 15));
          },
          close: async () => { document.documentElement.dataset.fileClosed = 'true'; },
        }),
      };
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-suggested-name', 'New Project.pgplan');
  await expect(page.locator('html')).toHaveAttribute('data-picker-activated', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-saved-signature', 'SQLite format 3');
  await expect(page.locator('html')).toHaveAttribute('data-file-closed', 'true');
  await expect(page.getByText('Project saved locally.', { exact: true })).toBeVisible();
});

test('cancelling Save As leaves the project unsaved without reporting an error', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: async () => {
    throw new DOMException('User cancelled', 'AbortError');
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create New Project', exact: true }).click();
  await page.getByRole('button', { name: 'Create / apply', exact: true }).click();
  await page.getByRole('button', { name: '+ Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(page.locator('.project-heading')).toContainText('*');
  await expect(page.getByText('Project saved locally.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

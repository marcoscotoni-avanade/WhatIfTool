import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPlannerServer } from '../../apps/planner-service/src/server';
import type { RemoteSnapshot } from '../../apps/desktop/src/store/connection';
import { createProject } from '@planner/domain';

test('real connected UI approves an agent edit and publishes UI edits to the authoritative service', async ({ page }) => {
  test.setTimeout(60_000);
  const directory = resolve(`.connected-e2e-${randomUUID()}`);
  const uiToken = randomUUID(), agentToken = randomUUID();
  const app = await createPlannerServer({ directory, uiToken, agentToken, port: 0 });
  const url = `http://127.0.0.1:${await app.listen()}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  async function agentRead<T>(path: string): Promise<T> {
    const response = await fetch(url + path, { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(response.ok).toBe(true);
    return await response.json() as T;
  }
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open Demo Project', exact: true }).click();
    await page.getByRole('button', { name: 'Connect service', exact: true }).click();
    await page.getByRole('textbox', { name: 'Service URL', exact: true }).fill(url);
    await page.getByRole('textbox', { name: 'UI token', exact: true }).fill(uiToken);
    await page.getByRole('button', { name: 'Connect current project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connected · r0', exact: true })).toBeVisible();
    const projects = await agentRead<{ id: string; name: string; revision: number }[]>('/api/projects');
    expect(projects).toHaveLength(1);
    const route = `/api/projects/${projects[0]!.id}`;
    const original = await agentRead<RemoteSnapshot>(route);
    const activityId = 'activity-2';
    const proposedName = 'Approved by the real connected UI';
    const requested = await fetch(url + route + '/commands', {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: original.revision, operationId: randomUUID(),
        action: 'updateActivities', args: [[activityId], { name: proposedName }] }),
    });
    expect(requested.ok).toBe(true);
    const operation = await requested.json() as { status: string; operation: { id: string } };
    expect(operation.status).toBe('approval_required');
    expect((await agentRead<RemoteSnapshot>(route)).model.activities.find(activity => activity.id === activityId)!.name).not.toBe(proposedName);
    const status = page.getByRole('region', { name: 'Service status' });
    await expect(status).toContainText('Agent requests updateActivities');
    await expect(status).toContainText(proposedName);
    await expect(status.getByLabel('Proposed changes')).toContainText('Before');
    await expect(status.getByLabel('Proposed changes')).toContainText('After');
    await expect(status.getByLabel('Proposed changes')).toContainText(proposedName);
    await status.getByRole('button', { name: 'Approve', exact: true }).click();
    const nameCell = page.locator(`.ag-pinned-left-cols-container [row-id="${activityId}"] [col-id="name"]`);
    await expect(nameCell).toHaveText(proposedName);
    await expect(page.getByRole('button', { name: 'Connected · r1', exact: true })).toBeVisible();
    await expect.poll(async () => (await agentRead<RemoteSnapshot>(route)).revision).toBe(1);
    await expect.poll(async () => (await agentRead<RemoteSnapshot>(route)).model.activities.find(activity => activity.id === activityId)!.name).toBe(proposedName);
    const operationStatus = await agentRead<{ status: string }>(route + `/operations/${operation.operation.id}`);
    expect(operationStatus.status).toBe('approved');
    const uiName = 'Written from the connected grid';
    await nameCell.dblclick();
    await page.locator('.ag-cell-inline-editing input').fill(uiName);
    await page.locator('.ag-cell-inline-editing input').press('Enter');
    await expect(nameCell).toHaveText(uiName);
    await expect.poll(async () => (await agentRead<RemoteSnapshot>(route)).model.activities.find(activity => activity.id === activityId)!.name).toBe(uiName);
    await expect(page.getByRole('button', { name: 'Connected · r2', exact: true })).toBeVisible();
    await expect(status).toContainText('live polling');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Authoritative project snapshot exported locally.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await agentRead<RemoteSnapshot>(route)).dirty).toBe(false);
    const makeProposal = await fetch(url + route + '/commands', {
      method: 'POST', headers: { Authorization: `Bearer ${uiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: (await agentRead<RemoteSnapshot>(route)).revision, operationId: randomUUID(),
        action: 'updateActivities', args: [[activityId], { effortHours: 88 }] }),
    });
    expect(makeProposal.ok).toBe(true);
    const proposalSnapshot = await makeProposal.json() as RemoteSnapshot;
    expect(proposalSnapshot.pendingEdit?.id).toBeTruthy();
    const decisionRequest = await fetch(url + route + '/commands', {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: proposalSnapshot.revision, operationId: randomUUID(),
        action: 'finishEdit', args: [[activityId], proposalSnapshot.pendingEdit!.id] }),
    });
    expect((await decisionRequest.json()).status).toBe('approval_required');
    const dialog = page.getByRole('dialog', { name: 'Recalculate duration?' });
    await expect(dialog.getByRole('region', { name: 'Agent duration request' })).toContainText('MIG');
    await dialog.getByRole('button', { name: 'Approve agent decision' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await agentRead<RemoteSnapshot>(route)).pendingEdit).toBeUndefined();
    expect((await agentRead<RemoteSnapshot>(route)).model.activities.find(activity => activity.id === activityId)!.duration).toBe(11);
    const newProject = createProject('Imported from agent');
    const importRequest = await fetch(url + '/api/imports', {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newProject, operationId: randomUUID() }),
    });
    expect(importRequest.ok).toBe(true);
    await page.getByRole('button', { name: /Connected · r/ }).click();
    const connectionDialog = page.getByRole('dialog', { name: 'Local planning service' });
    const importApproval = connectionDialog.getByRole('region', { name: 'Import Imported from agent' });
    await expect(async () => {
      await connectionDialog.getByRole('button', { name: 'List import requests' }).click();
      await expect(importApproval).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await expect(importApproval).toContainText('status: pending');
    await importApproval.getByRole('button', { name: 'Approve import' }).click();
    await expect(importApproval).toContainText('status: approved');
    expect((await agentRead<RemoteSnapshot>(`/api/projects/${newProject.project.id}`)).model.project.name).toBe('Imported from agent');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

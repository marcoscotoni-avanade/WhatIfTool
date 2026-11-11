import { useStore } from 'zustand';
import { createProjectEngine, type PlannerState } from '../../../../packages/application/src/index';
import { createConnection } from './connection';

export const projectStore = createProjectEngine();
export const connection = createConnection(projectStore);
export const useProjectStore = Object.assign(
  <T = PlannerState>(selector: (state: PlannerState) => T = (state => state as T)) => useStore(projectStore, selector),
  projectStore,
);
// Connected mutations are asynchronous; dialogs must await this before showing success or closing.
export async function persistAction(action: () => unknown): Promise<boolean> {
  try {
    const result = await action();
    if (connection.connected()) await connection.settle();
    return result !== false && !projectStore.getState().error;
  } catch (error) { projectStore.getState().report(error); return false; }
}

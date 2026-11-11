import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { SqliteProjectRepository, type BinaryStore } from '@planner/persistence';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { connection, persistAction, useProjectStore } from '../store/useProjectStore';
import { toModel } from '../store/document';

const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('project-risk-planner', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('projects');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transaction<T>(mode: IDBTransactionMode, operation: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', mode), r = operation(tx.objectStore('projects'));
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error ?? r.error);
    tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction aborted.'));
  });
}
const binaryStore: BinaryStore = {
  read: id => transaction<Uint8Array | undefined>('readonly', s => s.get(id)),
  write: async (id, bytes) => { await transaction('readwrite', s => s.put(bytes, id)); },
  remove: async id => { await transaction('readwrite', s => s.delete(id)); },
  keys: async () => (await transaction('readonly', s => s.getAllKeys())).map(String),
};
export const repository = SqliteProjectRepository.create(binaryStore, () => wasmUrl);
export function download(name: string, bytes: BlobPart, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type })), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface BrowserSaveHandle {
  name: string;
  createWritable(): Promise<{ write(data: ArrayBuffer): Promise<void>; close(): Promise<void> }>;
}
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<BrowserSaveHandle>;
};
export async function saveProject(saveAs = false, options: { automatic?: boolean; notify?: boolean } = {}): Promise<boolean> {
  const native = isTauri();
  let browserFile: BrowserSaveHandle | undefined;
  if (saveAs && !native) {
    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      try {
        // Request the picker before asynchronous work consumes browser user activation.
        browserFile = await picker.call(window, {
          suggestedName: `${useProjectStore.getState().document.project.name}.pgplan`,
          types: [{ description: 'Project Risk Planner', accept: { 'application/octet-stream': ['.pgplan'] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
        throw error;
      }
    }
  }
  if (connection.connected()) {
    await connection.settle();
    if (useProjectStore.getState().pendingEdit) throw new Error('Complete or cancel the duration proposal before saving.');
  }
  const s = useProjectStore.getState(), m = toModel(s.document), revision = s.revision, repo = await repository;
  let path = s.path;
  if (native && (saveAs || !path) && !(options.automatic && !path)) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    path = await save({ defaultPath: `${m.project.name}.pgplan`, filters: [{ name: 'Project Risk Planner', extensions: ['pgplan'] }] }) ?? undefined;
    if (!path) return false;
  }
  const bytes = repo.encode(m, s.calculationStatus === 'ready' ? s.results : undefined);
  if (native && path) await invoke('write_project', { path, bytes: Array.from(bytes) });
  if (browserFile) {
    const writable = await browserFile.createWritable();
    await writable.write(new Uint8Array(bytes).buffer);
    await writable.close();
  } else if (!native && saveAs) download(`${m.project.name}.pgplan`, new Uint8Array(bytes).buffer);
  await repo.saveProject(m, s.calculationStatus === 'ready' ? s.results : undefined);
  if (connection.connected()) {
    if (useProjectStore.getState().revision !== revision) throw new Error('The project changed during export. The file contains the earlier snapshot; save again.');
    if (!await persistAction(() => useProjectStore.getState().saveCompleted(revision, undefined, false))) return false;
    useProjectStore.setState({ path, ...(options.notify !== false ? { notice: 'Authoritative project snapshot exported locally.' } : {}) });
  } else useProjectStore.getState().saveCompleted(revision, path, options.notify);
  if (!native && saveAs && !browserFile && options.notify !== false) {
    useProjectStore.setState({ notice: 'This browser does not support choosing a save location. The project was downloaded using your browser download settings.' });
  }
  return true;
}
export async function openNativeProject(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog'), { readFile } = await import('@tauri-apps/plugin-fs');
  const path = await open({ multiple: false, filters: [{ name: 'Project Risk Planner', extensions: ['pgplan'] }] });
  if (!path || Array.isArray(path)) return;
  const repo = await repository, m = repo.decode(await readFile(path));
  if (!connection.connected()) await repo.saveProject(m);
  await persistAction(() => useProjectStore.getState().load(m, path));
}

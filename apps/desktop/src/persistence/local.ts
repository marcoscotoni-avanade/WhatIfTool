import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { SqliteProjectRepository, type BinaryStore } from '@planner/persistence';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../store/useProjectStore';
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
export async function saveProject(saveAs = false, options: { automatic?: boolean; notify?: boolean } = {}): Promise<boolean> {
  const s = useProjectStore.getState(), m = toModel(s.document), revision = s.revision, repo = await repository;
  let path = s.path;
  if (isTauri() && (saveAs || !path) && !(options.automatic && !path)) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    path = await save({ defaultPath: `${m.project.name}.pgplan`, filters: [{ name: 'Project Risk Planner', extensions: ['pgplan'] }] }) ?? undefined;
    if (!path) return false;
  }
  const bytes = repo.encode(m, s.calculationStatus === 'ready' ? s.results : undefined);
  if (isTauri() && path) await invoke('write_project', { path, bytes: Array.from(bytes) });
  await repo.saveProject(m, s.calculationStatus === 'ready' ? s.results : undefined);
  if (!isTauri() && saveAs) download(`${m.project.name}.pgplan`, new Uint8Array(bytes).buffer);
  useProjectStore.getState().saveCompleted(revision, path, options.notify);
  return true;
}
export async function openNativeProject(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog'), { readFile } = await import('@tauri-apps/plugin-fs');
  const path = await open({ multiple: false, filters: [{ name: 'Project Risk Planner', extensions: ['pgplan'] }] });
  if (!path || Array.isArray(path)) return;
  const repo = await repository, m = repo.decode(await readFile(path));
  await repo.saveProject(m);
  useProjectStore.getState().load(m, path);
}

import { invoke, convertFileSrc } from '@tauri-apps/api/tauri'

export async function initSession() {
  await invoke('init_session')
}
export async function scanFolder(path: string): Promise<{ path: string; fileName: string }[]> {
  return await invoke('scan_folder', { path })
}
export async function readMetadata(path: string) {
  return await invoke('read_metadata', { path })
}
export async function writeComment(path: string, comment: string) {
  return await invoke('write_comment', { path, comment })
}
export async function readTagsFile(): Promise<string> {
  return await invoke('read_tags_file')
}
export async function writeTagsFile(json: string) {
  return await invoke('write_tags_file', { json })
}
export async function chooseFolder(): Promise<string | null> {
  return await invoke('choose_folder')
}
export async function logEvent(message: string) {
  return await invoke('log_event', { message })
}
export function fileUrl(path: string) {
  return convertFileSrc(path)
}

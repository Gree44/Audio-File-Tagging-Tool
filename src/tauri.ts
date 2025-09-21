import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import type { TrackMeta } from "./types";

export async function initSession(): Promise<void> {
  await invoke<void>("init_session");
}

export async function scanFolder(
  path: string
): Promise<{ path: string; fileName: string }[]> {
  return invoke<{ path: string; fileName: string }[]>("scan_folder", { path });
}

export async function readMetadata(path: string): Promise<TrackMeta> {
  return invoke<TrackMeta>("read_metadata", { path });
}

export async function writeComment(
  path: string,
  comment: string
): Promise<void> {
  await invoke<void>("write_comment", { path, comment });
}

export async function readTagsFile(): Promise<string> {
  return invoke<string>("read_tags_file");
}

export async function writeTagsFile(json: string): Promise<void> {
  await invoke<void>("write_tags_file", { json });
}

export async function chooseFolder(): Promise<string | null> {
  try {
    const res = await open({ directory: true, multiple: false });
    const path = typeof res === "string" ? res : null;
    if (!path) console.info("[chooseFolder] user cancelled");
    else console.info("[chooseFolder] selected:", path);
    return path;
  } catch (e) {
    console.error("[chooseFolder] failed:", e);
    return null;
  }
}

export async function logEvent(message: string): Promise<void> {
  await invoke<void>("log_event", { message });
}

export function fileUrl(path: string) {
  return convertFileSrc(path);
}

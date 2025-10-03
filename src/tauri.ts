import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import type { TrackMeta } from "./types";
import { readBinaryFile } from "@tauri-apps/api/fs";

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

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "aif":
    case "aiff":
      return "audio/aiff";
    case "flac":
      return "audio/flac"; // Safari can’t play FLAC; waveform will still render if decoding succeeds
    default:
      return "application/octet-stream";
  }
}

export async function fileBlobUrl(path: string): Promise<string> {
  const bytes = await readBinaryFile(path); // Uint8Array<ArrayBufferLike>

  // Normalize to a real ArrayBuffer for the Blob ctor
  const arrayBuffer =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) // ArrayBuffer
      : new Uint8Array(bytes as any).buffer;

  const blob = new Blob([arrayBuffer], { type: mimeFor(path) });
  return URL.createObjectURL(blob);
}

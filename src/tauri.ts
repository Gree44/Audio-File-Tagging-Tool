import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import type { TrackMeta } from "./types";
import { readBinaryFile } from "@tauri-apps/api/fs";
import type { Settings } from "./types";

export async function initSession(): Promise<void> {
  await invoke<void>("init_session");
}

export async function scanFolder(
  path: string
): Promise<{ path: string; fileName: string }[]> {
  const raw = await invoke<any>("scan_folder", { path });
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((x: any) => ({
      path: x.path,
      fileName: x.fileName ?? x.file_name ?? "",
    }))
    .filter((x) => x.path && x.fileName);
}

export async function readMetadata(path: string): Promise<TrackMeta> {
  const m = await invoke<any>("read_metadata", { path });
  // normalize snake_case from Rust v1 to our TS interface
  return {
    path: m.path,
    fileName: m.fileName ?? m.file_name ?? "",
    title: m.title ?? undefined,
    artists: m.artists ?? [],
    genre: m.genre ?? undefined,
    comment: m.comment ?? "",
    pictureDataUrl: m.pictureDataUrl ?? m.picture_data_url ?? null,
    format: m.format ?? undefined,
  };
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

export async function getMediaUrl(path: string): Promise<string> {
  return invoke<string>("media_url_for_path", { path });
}

export async function logEvent(message: string): Promise<void> {
  await invoke<void>("log_event", { message });
}

export function fileUrl(path: string): string {
  try {
    const u = convertFileSrc(path);
    if (typeof u === "string" && u.startsWith("asset://")) return u;
  } catch {
    // fall through to manual build
  }
  // Manual fallback: encode the ABSOLUTE path as one segment
  // Example: asset://localhost/%2FUsers%2Fjanmuller%2F...
  const encoded = encodeURIComponent(path);
  return `asset://localhost/${encoded}`;
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

export async function listTagBanks(): Promise<string[]> {
  return invoke<string[]>("list_tag_banks");
}
export async function readTagsFileBank(bank: string): Promise<string> {
  return invoke<string>("read_tags_file_bank", { bank });
}
export async function writeTagsFileBank(
  bank: string,
  json: string
): Promise<void> {
  return invoke<void>("write_tags_file_bank", { bank, json });
}
export async function getLastUsedBank(): Promise<string | null> {
  return invoke<string | null>("get_last_used_bank");
}
export async function setLastUsedBank(bank: string): Promise<void> {
  return invoke<void>("set_last_used_bank", { bank });
}

export function sanitizeBank(name: string): string {
  const out = name
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "default";
}

export async function readSettings(): Promise<Settings> {
  const s = await invoke<any>("read_settings");
  // fields are camelCase from Rust via serde(rename_all)
  return {
    showTitle: !!s.showTitle,
    showAuthors: !!s.showAuthors,
    showGenre: !!s.showGenre,
    instantPlayback: !!s.instantPlayback,
  };
}

export async function writeSettings(s: Settings): Promise<void> {
  await invoke<void>("write_settings", { settings: s });
}

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::{api::{dialog::blocking::FileDialogBuilder, path::app_data_dir}};
use lofty::{Accessor, ItemKey, PictureType, TaggedFileExt, TagType, Tag};
use std::{fs, path::{Path, PathBuf}, io::Write};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use chrono::Local;
use base64::{engine::general_purpose, Engine as _};

use std::{convert::Infallible, io};

use hyper::{Body, Request, Response, Server, StatusCode, header, Method};
use hyper::header::{HeaderName, HeaderValue};
use hyper::service::{make_service_fn, service_fn};
use tokio::io::{AsyncSeekExt, AsyncReadExt};
use tokio_util::io::ReaderStream;


use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::Manager;

use serde_json::json;
use tauri::api::path::document_dir;

use serde::{Deserialize, Serialize};



static TAGS_SCHEMA_VERSION: u32 = 1; // also update in src/lib/tags.ts if changed

static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SimpleFile { path: String, file_name: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackMeta {
  path: String,
  file_name: String,
  title: Option<String>,
  artists: Vec<String>,
  genre: Option<String>,
  comment: String,
  picture_data_url: Option<String>,
  format: Option<String>,
}

struct AppState {
  media_base: String, // e.g. "http://127.0.0.1:12123"
}


fn data_dir() -> PathBuf { app_data_dir(&tauri::Config::default()).unwrap_or(std::env::current_dir().unwrap()) }
fn tags_file_path() -> PathBuf { let mut p = data_dir(); p.push("tags.json"); p }
fn logs_dir() -> PathBuf { let mut p = data_dir(); p.push("logs"); p }
fn banks_dir() -> PathBuf {
  // ~/Documents/AudioTagger/Banks
  let base = document_dir()
    .unwrap_or_else(|| std::env::current_dir().unwrap())
    .join("AudioTagger")
    .join("Banks");
  let _ = fs::create_dir_all(&base);
  base
}

fn default_tags_json() -> String {
  format!(r#"{{ "version": {}, "tags": [] }}"#, TAGS_SCHEMA_VERSION)
}

fn documents_root() -> PathBuf {
  // ~/Documents/AudioTagger
  let base = document_dir()
    .unwrap_or(std::env::current_dir().unwrap())
    .join("AudioTagger");
  let _ = std::fs::create_dir_all(&base);
  base
}


fn sanitize_bank(name: &str) -> String {
  let s = name.trim().to_lowercase();
  let mut out = String::with_capacity(s.len());
  for ch in s.chars() {
    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { out.push(ch); }
    else if ch.is_whitespace() { out.push('-'); }
  }
  let out = out.trim_matches('-').to_string();
  if out.is_empty() { "default".into() } else { out }
}

fn bank_path(name: &str) -> PathBuf {
  banks_dir().join(format!("tags.{}.json", sanitize_bank(name)))
}

fn prefs_path() -> PathBuf {
  documents_root().join("prefs.json")
}



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
  show_title: bool,
  show_authors: bool,
  show_genre: bool,
  instant_playback: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self {
      show_title: true,
      show_authors: true,
      show_genre: true,
      instant_playback: false,
    }
  }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
  last_used_bank: Option<String>,
  settings: Option<Settings>,
}



fn load_prefs() -> Prefs {
  let path = prefs_path();
  match std::fs::read_to_string(&path) {
    Ok(s) => {
      // Robust to old formats: if it’s valid JSON, parse Prefs;
      // otherwise treat content as legacy last_used_bank string.
      if s.trim_start().starts_with('{') {
        serde_json::from_str::<Prefs>(&s).unwrap_or_default()
      } else {
        Prefs { last_used_bank: Some(s.trim().to_string()), settings: None }
      }
    }
    Err(_) => Prefs::default(),
  }
}

fn save_prefs(p: &Prefs) -> Result<(), String> {
  let path = prefs_path();
  let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())
}

//////////////////// commands ////////////////////

#[tauri::command]
fn read_settings() -> Result<Settings, String> {
  let p = load_prefs();
  Ok(p.settings.unwrap_or_default())
}

#[tauri::command]
fn write_settings(settings: Settings) -> Result<(), String> {
  let mut p = load_prefs();
  p.settings = Some(settings);
  save_prefs(&p)
}


#[tauri::command]
fn init_session() -> Result<(), String> {
  fs::create_dir_all(logs_dir()).map_err(|e| e.to_string())?;
  let name = Local::now().format("%Y%m%d_%H%M%S.log").to_string();
  let mut p = logs_dir(); p.push(name);
  *LOG_PATH.lock() = Some(p.clone());
  let mut f = fs::File::create(&p).map_err(|e| e.to_string())?;
  writeln!(f, "session_start {}", Local::now().to_rfc3339()).map_err(|e| e.to_string())?;
  Ok(())
}

fn log_line(s: &str) {
  if let Some(p) = LOG_PATH.lock().clone() { if let Ok(mut f) = fs::OpenOptions::new().append(true).open(p) { let _ = writeln!(f, "{} {}", Local::now().format("%H:%M:%S"), s); } }
}

#[tauri::command]
fn log_event(message: String) { log_line(&message); }

#[tauri::command]
fn choose_folder() -> Option<String> { FileDialogBuilder::new().pick_folder().map(|p| p.to_string_lossy().to_string()) }

fn supported_ext(p: &Path) -> bool {
  if let Some(ext) = p.extension().and_then(|e| e.to_str()) { matches!(ext.to_lowercase().as_str(), "mp3"|"flac"|"wav"|"aiff"|"aif"|"m4a") } else { false }
}

#[tauri::command]
fn scan_folder(path: String) -> Result<Vec<SimpleFile>, String> {
  let mut out = vec![];
  for entry in fs::read_dir(PathBuf::from(&path)).map_err(|e| e.to_string())? { let e = entry.map_err(|e| e.to_string())?; let p = e.path(); if p.is_file() && supported_ext(&p) { out.push(SimpleFile{ path: p.to_string_lossy().to_string(), file_name: p.file_name().unwrap().to_string_lossy().to_string() }) } }
  out.sort_by(|a,b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
  Ok(out)
}

fn read_picture_data_url(tf: &lofty::TaggedFile) -> Option<String> {
  if let Some(tag) = tf.primary_tag() {
    for pic in tag.pictures() {
      if pic.pic_type() == PictureType::CoverFront || pic.pic_type() == PictureType::Other {
        let mime = pic.mime_type().map(|m| m.to_string()).unwrap_or("image/jpeg".into());
        let b64 = general_purpose::STANDARD.encode(pic.data());
        return Some(format!("data:{};base64,{}", mime, b64)); 
      } 
    }
  }
  None
}

#[tauri::command]
fn read_metadata(path: String) -> Result<TrackMeta, String> {
  use lofty::{ItemKey, TagType};
  use std::path::PathBuf;

  let p = PathBuf::from(&path);
  let tf = lofty::read_from_path(&p).map_err(|e| e.to_string())?;

  // Prefer the tag types that Rekordbox/Engine DJ use for each format.
  let ext = p
    .extension()
    .and_then(|s| s.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();

  let order: &[TagType] = match ext.as_str() {
    "mp3" | "aif" | "aiff" => &[TagType::Id3v2],
    "flac" => &[TagType::VorbisComments],
    "m4a" | "mp4" | "alac" => &[TagType::Mp4Ilst],
    "wav" => &[TagType::RiffInfo, TagType::Id3v2],
    _ => &[],
  };

  // Helper: get the first available tag in our preferred order, else primary.
  let preferred_tag = order
    .iter()
    .find_map(|tt| tf.tag(*tt))
    .or_else(|| tf.primary_tag());

  // Fields from the preferred tag (with graceful fallback).
  let title = preferred_tag
    .and_then(|t| t.title().map(|s| s.to_string()));

  let mut artists: Vec<String> = Vec::new();
  if let Some(t) = preferred_tag {
    if let Some(a) = t.artist() {
      artists.push(a.to_string());
    }
  }

  let genre = preferred_tag
    .and_then(|t| t.genre().map(|s| s.to_string()));

  // Comment: try preferred order; if missing, fall back to primary.
  let mut comment: Option<String> = None;
  for tt in order {
    if let Some(tag) = tf.tag(*tt) {
      if let Some(s) = tag.get_string(&ItemKey::Comment) {
        comment = Some(s.to_string());
        break;
      }
    }
  }
  if comment.is_none() {
    if let Some(tag) = tf.primary_tag() {
      if let Some(s) = tag.get_string(&ItemKey::Comment) {
        comment = Some(s.to_string());
      }
    }
  }
  let comment = comment.unwrap_or_default();

  // Picture & format
  let pic = read_picture_data_url(&tf);
  let format = p
    .extension()
    .and_then(|e| e.to_str())
    .map(|s| s.to_uppercase());

  Ok(TrackMeta {
    path: path.clone(),
    file_name: p
      .file_name()
      .map(|s| s.to_string_lossy().to_string())
      .unwrap_or_else(|| path.clone()),
    title,
    artists,
    genre,
    comment,
    picture_data_url: pic,
    format,
  })
}

#[inline]
fn save_tagged_file_to_path(tf: &lofty::TaggedFile, path: &std::path::Path) -> Result<(), String> {
  <lofty::TaggedFile as lofty::AudioFile>::save_to_path(tf, path)
    .map_err(|e| e.to_string())
}




#[tauri::command]
fn write_comment(path: String, comment: String) -> Result<(), String> {
  use std::path::PathBuf;

  let p = PathBuf::from(&path);
  let mut tf: lofty::TaggedFile = lofty::read_from_path(&p).map_err(|e| e.to_string())?;


  // choose tag types by format
  let ext = p
    .extension()
    .and_then(|s| s.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();

  let targets: &[TagType] = match ext.as_str() {
    // MP3 / AIFF -> ID3v2 COMM
    "mp3" | "aif" | "aiff" => &[TagType::Id3v2],
    // FLAC -> Vorbis COMMENT=
    "flac" => &[TagType::VorbisComments],
    // M4A/MP4/ALAC -> MP4 ©cmt (ilst)
    "m4a" | "mp4" | "alac" => &[TagType::Mp4Ilst],
    // WAV -> RIFF INFO ICMT and ID3v2 (write both)
    "wav" => &[TagType::RiffInfo, TagType::Id3v2],
    // fallback to the file’s primary tag type (no unwrap_or here)
    _ => &[],
  };

  let mut wrote_any = false;

  // write to all targeted tag types (creating if absent)
  for tt in targets {
    if tf.tag(*tt).is_none() {
      tf.insert_tag(Tag::new(*tt));
    }
    if let Some(tag) = tf.tag_mut(*tt) {
      tag.insert_text(ItemKey::Comment, comment.clone());
      wrote_any = true;
    }
  }

  // if the format branch didn't match, write to the primary tag type
  if !wrote_any {
    let tt = tf.primary_tag_type(); // returns TagType directly
    if tf.tag(tt).is_none() {
      tf.insert_tag(Tag::new(tt));
    }
    if let Some(tag) = tf.tag_mut(tt) {
      tag.insert_text(ItemKey::Comment, comment.clone());
    }
  }

  // save the file (TaggedFile::save_to takes a path; needs AudioFile trait in scope)
  save_tagged_file_to_path(&tf, p.as_path())



}



#[tauri::command]
fn write_tags_file(json: String) -> Result<(), String> {
  let p = tags_file_path();
  fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
  fs::write(&p, json).map_err(|e| e.to_string())?;
  log_line("write_tags_file");
  Ok(())
}

#[tauri::command]
fn list_tag_banks() -> Result<Vec<String>, String> {
  let base = banks_dir();
  let mut out = Vec::new();
  if let Ok(rd) = fs::read_dir(&base) {
    for e in rd.flatten() {
      let p = e.path();
      if let (Some(stem), Some(ext)) =
        (p.file_stem().and_then(|s| s.to_str()), p.extension().and_then(|e| e.to_str()))
      {
        if ext == "json" && stem.starts_with("tags.") {
          out.push(stem.trim_start_matches("tags.").to_string());
        }
      }
    }
  }
  if !out.iter().any(|s| s == "default") {
    out.push("default".into());
  }
  out.sort();
  Ok(out)
}

#[tauri::command]
fn read_tags_file_bank(bank: String) -> Result<String, String> {
  let path = bank_path(&bank);
  match fs::read_to_string(&path) {
    Ok(s) => Ok(s),
    Err(_) => {
      let empty = default_tags_json();
      let _ = fs::write(&path, &empty);
      Ok(empty)
    }
  }
}

#[tauri::command]
fn write_tags_file_bank(bank: String, json: String) -> Result<(), String> {
  let path = bank_path(&bank);
  fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_last_used_bank() -> Result<Option<String>, String> {
  Ok(load_prefs().last_used_bank)
}

#[tauri::command]
fn set_last_used_bank(bank: String) -> Result<(), String> {
  let mut p = load_prefs();
  p.last_used_bank = Some(bank);
  save_prefs(&p)
}



fn add_cors_headers(headers: &mut hyper::HeaderMap) {
  headers.insert(
    HeaderName::from_static("access-control-allow-origin"),
    HeaderValue::from_static("*"),
  );
  headers.insert(
    HeaderName::from_static("access-control-allow-methods"),
    HeaderValue::from_static("GET,HEAD,OPTIONS"),
  );
  headers.insert(
    HeaderName::from_static("access-control-allow-headers"),
    HeaderValue::from_static("*"),
  );
  headers.insert(
    HeaderName::from_static("vary"),
    HeaderValue::from_static("Origin"),
  );
}


async fn media_response(req: Request<Body>) -> Result<Response<Body>, Infallible> {
  let not_found = || {
    let mut resp = Response::builder()
      .status(StatusCode::NOT_FOUND)
      .body(Body::empty())
      .unwrap();
    add_cors_headers(resp.headers_mut());
    resp
  };

  // CORS preflight
  if req.method() == Method::OPTIONS {
    let mut resp = Response::builder()
      .status(StatusCode::NO_CONTENT)
      .body(Body::empty())
      .unwrap();
    add_cors_headers(resp.headers_mut());
    return Ok(resp);
  }

  let uri = req.uri();
  if uri.path() != "/audio" {
    return Ok(not_found());
  }

  // Extract and decode ?path=...
  let path = uri
    .query()
    .and_then(|q| q.split('&').find(|p| p.starts_with("path=")))
    .and_then(|kv| kv.split_once('=').map(|(_, v)| v.to_string()))
    .and_then(|enc| {
      percent_encoding::percent_decode_str(&enc)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
    });

  let path = match path {
    Some(p) => p,
    None => return Ok(not_found()),
  };

  if !std::path::Path::new(&path).exists() {
    return Ok(not_found());
  }

  let mut file = match tokio::fs::File::open(&path).await {
    Ok(f) => f,
    Err(_) => return Ok(not_found()),
  };
  let meta = match tokio::fs::metadata(&path).await {
    Ok(m) => m,
    Err(_) => return Ok(not_found()),
  };
  let file_len = meta.len();
  let mime = mime_guess::from_path(&path).first_or_octet_stream();

  let mut status = StatusCode::OK;
  let mut start: u64 = 0;
  let mut end: u64 = file_len.saturating_sub(1);

  if let Some(range) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
    if let Some(r) = range.strip_prefix("bytes=") {
      let mut parts = r.split('-');
      if let Some(s) = parts.next().and_then(|s| s.parse::<u64>().ok()) {
        start = s.min(end);
      }
      if let Some(e) = parts.next().and_then(|e| if e.is_empty() { None } else { e.parse::<u64>().ok() }) {
        end = e.min(end);
      }
      if start <= end {
        status = StatusCode::PARTIAL_CONTENT;
      } else {
        let mut resp = Response::builder()
          .status(StatusCode::RANGE_NOT_SATISFIABLE)
          .body(Body::empty())
          .unwrap();
        add_cors_headers(resp.headers_mut());
        return Ok(resp);
      }
    }
  }

  // HEAD: send headers only (faster for WaveSurfer's probes, if any)
  if req.method() == Method::HEAD {
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = status;
    let headers = resp.headers_mut();
    add_cors_headers(headers);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap());
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
      let cr = format!("bytes {}-{}/{}", start, end, file_len);
      headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&cr).unwrap());
    }
    return Ok(resp);
  }

  // GET: stream the requested range
  if (file.seek(std::io::SeekFrom::Start(start)).await).is_err() {
    return Ok(not_found());
  }
  let to_read = end - start + 1;
  let reader = tokio::io::AsyncReadExt::take(file, to_read);
  let stream = tokio_util::io::ReaderStream::new(reader);
  let body = Body::wrap_stream(stream);

  let mut resp = Response::new(body);
  *resp.status_mut() = status;
  let headers = resp.headers_mut();
  add_cors_headers(headers);
  headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap());
  headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
  if status == StatusCode::PARTIAL_CONTENT {
    let cr = format!("bytes {}-{}/{}", start, end, file_len);
    headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&cr).unwrap());
  }
  Ok(resp)
}



async fn start_media_server() -> io::Result<u16> {
  let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
  let port = std_listener.local_addr()?.port();
  std_listener.set_nonblocking(true)?;

  let make = make_service_fn(|_conn| async {
    Ok::<_, Infallible>(service_fn(media_response))
  });

  let server = Server::from_tcp(std_listener)
    .map_err(io::Error::other)?
    .serve(make);

  tauri::async_runtime::spawn(async move {
    if let Err(e) = server.await {
      eprintln!("media server error: {}", e);
    }
  });

  Ok(port)
}


#[tauri::command]
fn media_url_for_path(path: String, state: tauri::State<AppState>) -> String {
  let enc = utf8_percent_encode(&path, NON_ALPHANUMERIC).to_string();
  format!("{}/audio?path={}", state.media_base, enc)
}



pub fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      init_session, log_event, choose_folder, scan_folder, read_metadata, write_comment, write_tags_file, media_url_for_path, list_tag_banks, read_tags_file_bank, write_tags_file_bank, read_settings,
   write_settings,
   get_last_used_bank,
   set_last_used_bank,
  get_last_used_bank, set_last_used_bank
    ])
    .setup(|app| {
    tauri::async_runtime::block_on(async {
      match start_media_server().await {
        Ok(port) => {
          let base = format!("http://127.0.0.1:{}", port);
          app.manage(AppState { media_base: base });
        }
        Err(e) => {
          eprintln!("Failed to start media server: {}", e);
          app.manage(AppState { media_base: "http://127.0.0.1:0".into() });
        }
      }
    });
    Ok(())
  })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
    
}

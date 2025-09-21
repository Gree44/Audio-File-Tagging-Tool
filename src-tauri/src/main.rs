#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::{api::{dialog::blocking::FileDialogBuilder, path::app_data_dir}};
use serde::Serialize;
use lofty::{Accessor, ItemKey, PictureType, TaggedFileExt, TagType, Tag, AudioFile};
use std::{fs, path::PathBuf, io::Write};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use chrono::Local;
use base64::{engine::general_purpose, Engine as _};


static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Serialize)]
struct SimpleFile { path: String, file_name: String }

#[derive(Serialize)]
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

fn data_dir() -> PathBuf { app_data_dir(&tauri::Config::default()).unwrap_or(std::env::current_dir().unwrap()) }
fn tags_file_path() -> PathBuf { let mut p = data_dir(); p.push("tags.json"); p }
fn logs_dir() -> PathBuf { let mut p = data_dir(); p.push("logs"); p }

#[tauri::command]
fn init_session() -> Result<(), String> {
  fs::create_dir_all(&logs_dir()).map_err(|e| e.to_string())?;
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

fn supported_ext(p: &PathBuf) -> bool {
  if let Some(ext) = p.extension().and_then(|e| e.to_str()) { match ext.to_lowercase().as_str() {"mp3"|"flac"|"wav"|"aiff"|"aif"|"m4a" => true, _ => false} } else { false }
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
  let p = PathBuf::from(&path);
  let tf = lofty::read_from_path(&p).map_err(|e| e.to_string())?;
  let tag = tf.primary_tag().or_else(|| tf.first_tag());
  let title = tag.and_then(|t| t.title().map(|s| s.to_string()));
  let mut artists = vec![]; if let Some(t) = tag { if let Some(a) = t.artist() { artists.push(a.to_string()) } }
  let genre = tag.and_then(|t| t.genre().map(|s| s.to_string()));
  let comment = tag.and_then(|t| t.get_string(&ItemKey::Comment).map(|s| s.to_string())).unwrap_or_default();
  let pic = read_picture_data_url(&tf);
  let format = p.extension().and_then(|e| e.to_str()).map(|s| s.to_uppercase());
  Ok(TrackMeta {
    path: path.clone(),
    file_name: p.file_name().unwrap().to_string_lossy().to_string(),
    title, artists, genre, comment,
    picture_data_url: pic,
    format,
    })
  }

#[tauri::command]
fn write_comment(path: String, comment: String) -> Result<(), String> {
  let _guard = WRITE_LOCK.lock();
  let p = PathBuf::from(&path);
  let mut tf = lofty::read_from_path(&p).map_err(|e| e.to_string())?;

  // choose an existing primary tag if possible, else create one
  let tag_type = tf.primary_tag().map(|t| t.tag_type()).unwrap_or(TagType::Id3v2);

  if let Some( tag_ref) = tf.primary_tag_mut() {
    // write into the existing primary tag
    tag_ref.insert_text(ItemKey::Comment, comment.clone());
  } else {
    // create a new tag and insert it
    let mut tag = Tag::new(tag_type);
    tag.insert_text(ItemKey::Comment, comment.clone());
    tf.insert_tag(tag);
  }

  // persist
  tf.save_to_path(&p).map_err(|e| e.to_string())?;
  log_line(&format!("write_comment path=\"{}\"", path));
  Ok(())

}

#[tauri::command]
fn read_tags_file() -> Result<String, String> {
  let p = tags_file_path();
  if !p.exists() { let default = serde_json::json!({"version":1,"tags":[]}); fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?; fs::write(&p, serde_json::to_vec_pretty(&default).unwrap()).map_err(|e| e.to_string())?; }
  let s = fs::read_to_string(&p).map_err(|e| e.to_string())?; Ok(s)
}

#[tauri::command]
fn write_tags_file(json: String) -> Result<(), String> {
  let p = tags_file_path();
  fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
  fs::write(&p, json).map_err(|e| e.to_string())?;
  log_line("write_tags_file");
  Ok(())
}

pub fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      init_session, log_event, choose_folder, scan_folder, read_metadata, write_comment, read_tags_file, write_tags_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

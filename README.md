# Audio Tagger (Tauri + React + Rust)

**Features implemented**
- Open a folder, list supported audio files (MP3, FLAC, WAV, AIFF, M4A)
- Waveform preview with play/pause, time display (elapsed left / total right)
- Current position red line with darker played region
- Embedded cover art preview (if present)
- Metadata display (title, authors, genre) — toggle in Settings ⚙️
- Tag manager: create/edit/delete tags with type (main/mandatory/optional), parent, optional amount range
- Tags persisted to `tags.json` (app data dir)
- Tagging a song writes immediately to the file's **comment** field, semicolon-separated, no spaces
- Parent and mandatory tags auto-applied; enforced again on song load
- Block removing mandatory tags; enforce at least one **main** tag
- Keyboard shortcuts: `o` (open folder on start), `Space` play/pause, `←/→` seek 10s (hold Shift for 30s), `A` prev, `D` next, `+` manage tags, `1..0` first 10 tags, `Shift+1..9` next 10
- Per-session logfile under app data dir `/logs/YYYYMMDD_HHMMSS.log`
- Writes serialized so file ops can't interleave

## Quick start (macOS)
```bash
# 1) Xcode command line tools (if not installed)
xcode-select --install

# 2) Install Rust toolchain
curl https://sh.rustup.rs -sSf | sh -s -- -y
source $HOME/.cargo/env

# 3) Install Node.js 18+ (use nvm if you like)
# if you have nvm:
#   nvm install --lts
# otherwise: download from nodejs.org

# 4) Install deps & run
npm i
npm run tauri:dev
```

The Tauri dev process will build the Rust side and launch a window on top of `vite`.

## Notes
- For M4A/MP4, comments are written to the canonical atom via `lofty`'s `ItemKey::Comment`.
- If your files are read-only, writing will fail; the app shows a popup and logs the error.
- Amount tags are emitted as `<name><integer>` (e.g., `energy3`). Default is `0` until you set it.
- To change which metadata fields show, click ⚙️ (top-right).

## Roadmap
- Batch tagging across folder
- Precompute waveform peaks and cache
- Region markers + apply tags from region
- Mirror keywords into custom frames (ID3 TXXX, MP4 ----)

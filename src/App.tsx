import React, { useEffect, useState, useRef } from "react";
import {
  initSession,
  chooseFolder,
  scanFolder,
  readMetadata,
  writeComment,
  logEvent,
  getMediaUrl,
  readTagsFileBank,
  writeTagsFileBank,
  listTagBanks,
  getLastUsedBank,
  setLastUsedBank,
  sanitizeBank,
  readSettings,
  writeSettings,
} from "./tauri";
import Waveform from "./components/Waveform";
import { TagDef, TagsFile, TrackMeta, Settings } from "./types";
import {
  emptyTags,
  idFromName,
  parseCommentToTags,
  enforceParentAndMandatory,
  stringifyTagsForComment,
  validateTagName,
  ensureAtLeastOneMain,
  dedupeById,
  coerceTagsFile,
  unknownTokensFromComment,
  splitTokens,
} from "./lib/tags";
import { StatusViewport, pushStatus } from "./ui/Status";

function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping =
        tag === "input" ||
        tag === "textarea" ||
        (target as HTMLElement | null)?.isContentEditable;

      if (isTyping) return;

      const key = [e.shiftKey ? "Shift+" : "", e.key].join("");
      const simple = e.key;
      if (bindings[key]) {
        e.preventDefault();
        bindings[key](e);
      } else if (bindings[simple]) {
        e.preventDefault();
        bindings[simple](e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}

function StartScreen({
  onOpenFolder,
  onManageTags,
  onOpenSettings,
  banks,
  bank,
  onSelectBank,
  onCreateBank,
}: {
  onOpenFolder: () => void;
  onManageTags: () => void;
  onOpenSettings: () => void;
  banks: string[];
  bank: string;
  onSelectBank: (b: string) => void;
  onCreateBank: () => void;
}) {
  useHotkeys({ o: () => onOpenFolder(), "+": () => onManageTags() });
  return (
    <div className="col" style={{ padding: 24, gap: 16 }}>
      <div className="toolbar">
        <div style={{ fontWeight: 700 }}>Audio Tagger</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onManageTags}>
            Manage Tags <span className="kbd">+</span>
          </button>

          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#555" }}>Tag bank</span>
            <select
              value={bank}
              onChange={(e) => {
                const val = e.currentTarget.value;
                if (val === "__new__") {
                  e.currentTarget.value = bank; // revert visual selection
                  onCreateBank(); // <-- open modal
                } else {
                  onSelectBank(val);
                }
              }}
              style={{ padding: 6 }}
            >
              {banks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value="__new__">➕ New bank…</option>
            </select>
          </label>

          <button className="btn primary" onClick={onOpenFolder}>
            Open Folder <span className="kbd">o</span>
          </button>

          <button className="btn" onClick={onOpenSettings}>
            Settings ⚙️
          </button>
        </div>
      </div>
      <div className="panel">
        <h3>Tag Collections</h3>
        <p>
          Define your tags (main, mandatory, optional). Parent relationships
          auto-apply. Amount tags append a number (e.g., <code>energy5</code>).
        </p>
        <p>
          Tags are saved locally to <code>tags.json</code>.
        </p>
      </div>
    </div>
  );
}

function TagManager({
  tags,
  setTags,
  onClose,
}: {
  tags: TagsFile;
  setTags: (t: TagsFile) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    type: "main" | "mandatory" | "optional";
    parent: string | "";
    hasAmount: boolean;
    min: number;
    max: number;
  }>({
    name: "",
    type: "optional",
    parent: "",
    hasAmount: false,
    min: 0,
    max: 5,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  function reset() {
    setForm({
      name: "",
      type: "optional",
      parent: "",
      hasAmount: false,
      min: 0,
      max: 5,
    });
    setEditing(null);
    setError(null);
  }

  function save() {
    try {
      validateTagName(form.name);
      const id = editing ?? idFromName(form.name);
      const def: TagDef = {
        id,
        name: form.name,
        type: form.type,
        parent: form.parent || null,
        amountRange: form.hasAmount ? { min: form.min, max: form.max } : null,
      };
      let next = { ...tags, tags: [...tags.tags] };
      const ix = next.tags.findIndex((t) => t.id === id);
      if (ix >= 0) next.tags[ix] = def;
      else next.tags.push(def);
      setTags(next);
      reset();
    } catch (e: any) {
      setError(String(e.message || e));
    }
  }

  function del(id: string) {
    const next = { ...tags, tags: tags.tags.filter((t) => t.id !== id) };
    setTags(next);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        tabIndex={0}
        onKeyDown={(e) => {
          e.stopPropagation(); // prevent global hotkeys while typing in the modal
          if (e.key === "Enter") save();
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Manage Tags</h3>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <div className="panel" style={{ borderColor: "#f00", color: "#900" }}>
            {error}
          </div>
        )}

        <div className="grid">
          <label className="col">
            Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label className="col">
            Type
            <select
              value={form.type}
              onChange={(e) =>
                setForm((f) => ({ ...f, type: e.target.value as any }))
              }
            >
              <option value="main">main</option>
              <option value="mandatory">mandatory</option>
              <option value="optional">optional</option>
            </select>
          </label>
          <label className="col">
            Parent
            <select
              value={form.parent}
              onChange={(e) =>
                setForm((f) => ({ ...f, parent: e.target.value }))
              }
            >
              <option value="">(none)</option>
              {tags.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="col">
            Amount tag?
            <input
              type="checkbox"
              checked={form.hasAmount}
              onChange={(e) =>
                setForm((f) => ({ ...f, hasAmount: e.target.checked }))
              }
            />
          </label>
          {form.hasAmount && (
            <>
              <label className="col">
                Min
                <input
                  type="number"
                  value={form.min}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, min: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="col">
                Max
                <input
                  type="number"
                  value={form.max}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, max: Number(e.target.value) }))
                  }
                />
              </label>
            </>
          )}
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button className="btn primary" onClick={save}>
            Save <span className="kbd">Enter</span>
          </button>
          <button className="btn" onClick={reset}>
            Reset
          </button>
        </div>

        <div className="panel" style={{ marginTop: 12 }}>
          <div className="row" style={{ fontWeight: 600, marginBottom: 6 }}>
            <div style={{ width: 160 }}>Name</div>
            <div style={{ width: 100 }}>Type</div>
            <div style={{ width: 140 }}>Parent</div>
            <div>Amount</div>
          </div>
          {tags.tags.map((t) => (
            <div
              key={t.id}
              className="row"
              style={{ alignItems: "center", marginBottom: 4 }}
            >
              <div style={{ width: 160 }}>{t.name}</div>
              <div style={{ width: 100 }}>
                <span className="tag-type">{t.type}</span>
              </div>
              <div style={{ width: 140 }}>
                {t.parent
                  ? tags.tags.find((x) => x.id === t.parent)?.name
                  : "—"}
              </div>
              <div>
                {t.amountRange
                  ? `${t.amountRange.min}..${t.amountRange.max}`
                  : "—"}
              </div>
              <div style={{ marginLeft: "auto" }} className="row">
                <button
                  className="btn ghost"
                  onClick={() => {
                    setEditing(t.id);
                    setForm({
                      name: t.name,
                      type: t.type,
                      parent: t.parent || "",
                      hasAmount: !!t.amountRange,
                      min: t.amountRange?.min ?? 0,
                      max: t.amountRange?.max ?? 5,
                    });
                  }}
                >
                  Edit
                </button>
                <button className="btn ghost" onClick={() => del(t.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SongTagging({
  folder,
  onBack,
  tagsFile,
  setTagsFile,
  settings,
  onOpenSettings,
  bank,
  banks,
  onSelectBank,
  onCreateBank,
}: {
  folder: string;
  onBack: () => void;
  tagsFile: TagsFile;
  setTagsFile: (t: TagsFile) => void;
  settings: Settings;
  onOpenSettings: () => void;
  bank: string;
  banks: string[];
  onSelectBank: (b: string) => void;
  onCreateBank: () => void;
}) {
  // ---- Stable hook order (these never change across renders) ----
  const [files, setFiles] = useState<{ path: string; fileName: string }[]>([]);
  const [sortAsc, setSortAsc] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [meta, setMeta] = useState<TrackMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [loading, setLoading] = useState(true);
  const [volume, setVolume] = useState(0.3); // default 30%
  const [audioLoading, setAudioLoading] = useState(false);
  const [waveLoading, setWaveLoading] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string>(""); // URL we pass to <Waveform>
  const isInitialLoadRef = useRef(true);
  const [confirmSwitchOpen, setConfirmSwitchOpen] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<{
    tag: TagDef;
    amount: number | null;
  } | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  // ---- Hoisted helpers (function declarations avoid TDZ) ----
  async function loadTrackForEntry(entry: { path: string; fileName: string }) {
    try {
      // clear old media immediately
      setPlaying(false);
      setMediaUrl(""); // unmounts Waveform (destroys audio + ws)
      setAudioLoading(true);
      setWaveLoading(true);

      // NEW: get a fast streaming URL from Rust (HTTP with Range)
      const newUrl = await getMediaUrl(entry.path);
      console.debug("[loadTrackForEntry] http URL =", newUrl);
      setMediaUrl(newUrl);

      // fetch metadata in parallel
      console.time(`[readMetadata] ${entry.fileName}`);
      const m: TrackMeta = await readMetadata(entry.path);
      console.timeEnd(`[readMetadata] ${entry.fileName}`);
      setMeta(m);

      // Warn if comment contains a different TagB than current bank
      try {
        const tokens = (m.comment || "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        const tagb = tokens.find((t) => t.startsWith("TagB:"));
        if (tagb) {
          const fromFile = tagb.slice("TagB:".length);
          if (fromFile && fromFile !== bank) {
            pushStatus(
              <span>
                This file was tagged with a different bank: <b>{fromFile}</b>
              </span>
            );
          }
        }
      } catch {}
    } catch (e) {
      console.error("[readMetadata] failed:", e);
      alert("Failed to read metadata: " + e);
    }
  }

  async function selectIndex(ix: number) {
    if (!files.length) return;
    const bounded = (ix + files.length) % files.length;
    setCurrentIndex(bounded);
    await loadTrackForEntry(files[bounded]);
    if (settings.instantPlayback && !isInitialLoadRef.current) {
      setPlaying(true);
    }
  }

  async function doClearTags() {
    if (!meta) return;
    try {
      await writeComment(meta.path, "");
      await logEvent(`clear_tags path="${meta.path}"`);
      setMeta({ ...meta, comment: "" });
      pushStatus(<span>All tags cleared.</span>);
    } catch (e) {
      alert("Failed to clear tags: " + e);
    }
  }

  // ---- Scan effect (runs once per folder) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        console.time("[scanFolder]");
        setLoading(true);
        const list = await scanFolder(folder);
        if (!alive) return;
        console.log("[scanFolder] returned", list.length, "files");

        list.sort((a, b) => a.fileName.localeCompare(b.fileName));
        setFiles(list);
        if (list.length) {
          await loadTrackForEntry(list[0]);
          setCurrentIndex(0);
          isInitialLoadRef.current = false;
        } else {
          setMeta(null);
        }
      } catch (e) {
        console.error("[scanFolder] failed:", e);
        alert("Failed to scan folder: " + e);
      } finally {
        if (alive) setLoading(false);
        console.timeEnd("[scanFolder]");
      }
    })();
    return () => {
      alive = false;
    };
  }, [folder]);

  // ---- Global hotkeys (never conditional) ----
  useHotkeys({
    " ": () => setPlaying((p) => !p),
    ArrowLeft: () =>
      window.dispatchEvent(new CustomEvent("seekrel", { detail: -10 } as any)),
    "Shift+ArrowLeft": () =>
      window.dispatchEvent(new CustomEvent("seekrel", { detail: -30 } as any)),
    ArrowRight: () =>
      window.dispatchEvent(new CustomEvent("seekrel", { detail: 10 } as any)),
    "Shift+ArrowRight": () =>
      window.dispatchEvent(new CustomEvent("seekrel", { detail: 30 } as any)),
    d: () => selectIndex(currentIndex + 1),
    a: () => selectIndex(currentIndex - 1),
    "+": () => setShowManager(true),
  });

  const flatTags = tagsFile.tags;
  useHotkeys(
    Object.fromEntries([
      ...Array.from({ length: Math.min(10, flatTags.length) }, (_, i) => [
        String((i + 1) % 10),
        () => toggleTag(flatTags[i]),
      ]),
      ...Array.from(
        { length: Math.max(0, Math.min(20, flatTags.length) - 10) },
        (_, i) => [`Shift+${i + 1}`, () => toggleTag(flatTags[i + 10])]
      ),
    ] as [string, (e: KeyboardEvent) => void][])
  );

  function tokenList() {
    return parseCommentToTags(meta?.comment || "", tagsFile.tags);
  }

  async function clearTagsConfirm() {
    if (!meta) return;
    if (!meta.comment) {
      pushStatus(<span>No tags to clear.</span>);
      return;
    }
    const ok = window.confirm(
      "Clear ALL tags for this file? This will erase the entire comment field."
    );
    if (!ok) return;

    try {
      await writeComment(meta.path, ""); // wipe comment completely
      await logEvent(`clear_tags path="${meta.path}"`);
      setMeta({ ...meta, comment: "" }); // update UI
      pushStatus(<span>All tags cleared.</span>);
    } catch (e) {
      alert("Failed to clear tags: " + e);
    }
  }

  async function persistTagsWithBankDecision(
    chosen: { tag: TagDef; amount: number | null }[],
    removeUnknowns: boolean,
    keepUnknowns: boolean
  ) {
    if (!meta) return;

    const final = enforceParentAndMandatory(dedupeById(chosen), tagsFile.tags);
    if (!ensureAtLeastOneMain(final, tagsFile.tags)) {
      alert("At least one MAIN tag is required");
      return;
    }

    // Base from known tags:
    let str = stringifyTagsForComment(final);

    // Keep or remove unknowns currently present in the file
    if (keepUnknowns && !removeUnknowns) {
      const unknown = unknownTokensFromComment(
        meta.comment || "",
        tagsFile.tags
      );
      if (unknown.length) {
        if (str && !str.endsWith(";")) str += ";";
        str += unknown.map((u) => `${u};`).join("");
        // ensure single trailing ';' is fine; stringifyTagsForComment already normalizes knowns
      }
    }
    // else (removeUnknowns) => do nothing; unknowns are not appended

    // Ensure TagB:<current_bank>; and replace any existing TagB token
    const toks = splitTokens(str).filter((t) => !t.startsWith("TagB:"));
    toks.push(`TagB:${bank}`);
    str = toks.join(";") + ";";

    try {
      await writeComment(meta.path, str);
      await logEvent(`write_comment path="${meta.path}" -> "${str}"`);
      setMeta({ ...meta, comment: str });
    } catch (e) {
      alert("Write failed: " + e);
    }
  }

  async function toggleTag(t: TagDef) {
    if (!meta) return;
    let list = tokenList();
    const has = list.some((x) => x.tag.id === t.id);
    if (t.type === "mandatory" && has) {
      alert("Mandatory tags cannot be removed");
      return;
    }

    // Only intercept when ADDING a tag, there are existing tags from another bank
    if (!has && bankDiffAndHasTags) {
      setPendingAdd({ tag: t, amount: t.amountRange ? 0 : null });
      setConfirmSwitchOpen(true);
      return;
    }

    if (has) list = list.filter((x) => x.tag.id !== t.id);
    else list.push({ tag: t, amount: t.amountRange ? 0 : null });
    await persistTagsWithBankDecision(
      list,
      /*removeUnknowns*/ false,
      /*keepUnknowns*/ true
    );
  }

  async function setAmount(t: TagDef, n: number) {
    let list = tokenList();
    const ix = list.findIndex((x) => x.tag.id === t.id);
    const adding = ix < 0;

    if (adding && bankDiffAndHasTags) {
      setPendingAdd({ tag: t, amount: n });
      setConfirmSwitchOpen(true);
      return;
    }

    if (ix >= 0) list[ix] = { tag: t, amount: n };
    else list.push({ tag: t, amount: n });
    await persistTagsWithBankDecision(
      list,
      /*removeUnknowns*/ false,
      /*keepUnknowns*/ true
    );
  }

  function toggleSort() {
    const next = !sortAsc;
    setSortAsc(next);
    const sorted = [...files].sort((a, b) =>
      next
        ? a.fileName.localeCompare(b.fileName)
        : b.fileName.localeCompare(a.fileName)
    );
    const currentPath = files[currentIndex]?.path;
    setFiles(sorted);
    const newIx = sorted.findIndex((s) => s.path === currentPath);
    if (newIx >= 0) setCurrentIndex(newIx);
  }
  function getBankFromComment(comment: string): string | null {
    const tok = splitTokens(comment).find((t) => t.startsWith("TagB:"));
    return tok ? tok.slice("TagB:".length) : null;
  }

  const unknown: string[] = React.useMemo(
    () => unknownTokensFromComment(meta?.comment || "", tagsFile.tags),
    [meta?.comment, tagsFile.tags]
  );

  const fileBank = React.useMemo(
    () => getBankFromComment(meta?.comment || ""),
    [meta?.comment]
  );

  const tokensExcludingBank = React.useMemo(
    () =>
      splitTokens(meta?.comment || "").filter((t) => !t.startsWith("TagB:")),
    [meta?.comment]
  );

  const hasAnyFileTags = tokensExcludingBank.length > 0;

  const bankDiffAndHasTags = !!fileBank && fileBank !== bank && hasAnyFileTags;

  // ---- Render (single return; no early-return that could skip hooks) ----
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "280px 1fr",
        height: "100%",
      }}
    >
      {/* Sidebar */}
      <div className="sidebar">
        <div
          className="row"
          style={{ justifyContent: "space-between", marginBottom: 8 }}
        >
          <button className="btn" onClick={onBack}>
            ← Back
          </button>
          <button className="btn" onClick={toggleSort}>
            Sort {sortAsc ? "▲" : "▼"}
          </button>
        </div>
        {loading ? (
          <div className="panel">Loading…</div>
        ) : files.length === 0 ? (
          <div className="panel">No supported audio files found.</div>
        ) : (
          files.map((f, i) => (
            <div
              key={f.path}
              className={`sidebar-item ${i === currentIndex ? "active" : ""}`}
              onClick={() => selectIndex(i)}
            >
              {f.fileName}
            </div>
          ))
        )}
      </div>

      {/* Main */}
      <div className="col" style={{ padding: 12 }}>
        <div className="toolbar">
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setPlaying((p) => !p)}>
              Play/Pause <span className="kbd">Space</span>
            </button>
            <button
              className="btn"
              onClick={() => selectIndex(currentIndex - 1)}
            >
              Prev <span className="kbd">A</span>
            </button>
            <button
              className="btn"
              onClick={() => selectIndex(currentIndex + 1)}
            >
              Next <span className="kbd">D</span>
            </button>
            <label
              className="row"
              style={{ gap: 6, alignItems: "center", marginLeft: 8 }}
            >
              <span style={{ fontSize: 12, color: "#555" }}>Vol</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(volume * 100)}
                onChange={(e) => setVolume(Number(e.currentTarget.value) / 100)}
                style={{ width: 140 }}
              />
              <span className="kbd">{Math.round(volume * 100)}%</span>
            </label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setShowManager(true)}>
              Manage Tags <span className="kbd">+</span>
            </button>

            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#555" }}>Tag bank</span>
              <select
                value={bank}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  if (val === "__new__") {
                    e.currentTarget.value = bank; // revert visual selection
                    onCreateBank(); // <-- open modal
                  } else {
                    onSelectBank(val);
                  }
                }}
                style={{ padding: 6 }}
              >
                {banks.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
                <option value="__new__">➕ New bank…</option>
              </select>
            </label>

            <button className="btn" onClick={onOpenSettings}>
              Settings ⚙️
            </button>
          </div>
        </div>

        {meta && (
          <div className="row" style={{ alignItems: "flex-start" }}>
            {bankDiffAndHasTags && (
              <div
                className="panel"
                style={{ borderColor: "#f80", color: "#a50", marginBottom: 8 }}
              >
                This file was tagged with a different tag bank:{" "}
                <b>{fileBank}</b>. You currently selected <b>{bank}</b>.
              </div>
            )}

            <div className="panel" style={{ flex: 1 }}>
              <Waveform
                url={mediaUrl}
                playing={playing}
                volume={volume}
                onAudioLoading={setAudioLoading}
                onWaveLoading={setWaveLoading}
              />
              {audioLoading && (
                <div style={{ marginTop: 6, color: "#666" }}>
                  Audio is loading…
                </div>
              )}
              {waveLoading && (
                <div style={{ marginTop: 2, color: "#888" }}>
                  Waveform is loading…
                </div>
              )}
            </div>

            <div className="col" style={{ width: 180, gap: 8 }}>
              {meta.pictureDataUrl ? (
                <img className="img" src={meta.pictureDataUrl} alt="cover" />
              ) : (
                <div
                  className="img"
                  style={{
                    display: "grid",
                    placeItems: "center",
                    color: "#999",
                  }}
                >
                  No Art
                </div>
              )}
              <div className="panel">
                <div className="col" style={{ gap: 4 }}>
                  {settings.showTitle && (
                    <div>
                      <b>Title:</b> {meta.title || "—"}
                    </div>
                  )}
                  {settings.showAuthors && (
                    <div>
                      <b>Authors:</b> {(meta.artists || []).join(", ") || "—"}
                    </div>
                  )}
                  {settings.showGenre && (
                    <div>
                      <b>Genre:</b> {meta.genre || "—"}
                    </div>
                  )}
                  {settings.showComment && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        Comment
                      </div>
                      <textarea
                        readOnly
                        value={meta.comment || ""}
                        style={{
                          width: "100%",
                          minHeight: 72,
                          resize: "vertical",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                          fontSize: 12,
                          lineHeight: 1.35,
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #ddd",
                          background: "#fafafa",
                          color: "#333",
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="panel">
          <div
            className="row"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 6,
            }}
          >
            <div style={{ fontWeight: 600 }}>Selected tags for this song</div>
            <button
              className="btn"
              onClick={() => setClearConfirmOpen(true)}
              disabled={!meta || !(meta.comment && meta.comment.trim().length)}
              title="Erase the entire comment field (removes all tags, including TagB)."
            >
              Clear Tags
            </button>
          </div>

          <div>
            {parseCommentToTags(meta?.comment || "", tagsFile.tags).map(
              ({ tag, amount }) => (
                <span
                  className="chip active"
                  key={tag.id}
                  onClick={() => toggleTag(tag)}
                  title="Click to remove"
                >
                  {tag.name}
                  {tag.amountRange ? amount ?? 0 : ""}
                </span>
              )
            )}

            {unknown.length > 0 && (
              <div className="panel" style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Unknown tags in file
                  {fileBank ? (
                    <span style={{ fontWeight: 400 }}>
                      {" "}
                      (tagged from this tagbank: <b>{fileBank}</b>)
                    </span>
                  ) : null}
                </div>
                <div>
                  {unknown.map((u: string) => (
                    <span
                      key={u}
                      className="chip warning"
                      title="This tag is not in the current tag bank"
                    >
                      {u}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div style={{ fontWeight: 600 }}>All tags</div>
            <div className="row" style={{ gap: 12, color: "#666" }}>
              <div>
                <span className="kbd">1..0</span> first 10
              </div>
              <div>
                <span className="kbd">Shift+1..9</span> next 10
              </div>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            {tagsFile.tags.map((t, i) => {
              const selected = parseCommentToTags(
                meta?.comment || "",
                tagsFile.tags
              ).some((x) => x.tag.id === t.id);
              const keyCap =
                i < 10 ? String((i + 1) % 10) : i < 20 ? `S+${i - 9}` : "";
              return (
                <span
                  key={t.id}
                  className={`chip ${selected ? "active" : ""}`}
                  onClick={() => toggleTag(t)}
                >
                  {t.name}
                  {t.amountRange && (
                    <input
                      type="number"
                      min={t.amountRange.min}
                      max={t.amountRange.max}
                      style={{ width: 54, marginLeft: 6 }}
                      value={
                        parseCommentToTags(
                          meta?.comment || "",
                          tagsFile.tags
                        ).find((x) => x.tag.id === t.id)?.amount ?? 0
                      }
                      onChange={(e) => setAmount(t, Number(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                  {keyCap && <span className="kbd">{keyCap}</span>}
                </span>
              );
            })}
          </div>
        </div>

        {showManager && (
          <TagManager
            tags={tagsFile}
            setTags={async (tf) => {
              setTagsFile(tf);
              await writeTagsFileBank(bank, JSON.stringify(tf));
              await logEvent("write_tags_file");
            }}
            onClose={() => setShowManager(false)}
          />
        )}
        {confirmSwitchOpen && pendingAdd && (
          <ConfirmSwitchBankModal
            currentBank={bank}
            fileBank={fileBank || "(unknown)"}
            unknown={unknown}
            onCancel={() => {
              setConfirmSwitchOpen(false);
              setPendingAdd(null);
            }}
            onSwitchKeepUnknowns={async () => {
              setConfirmSwitchOpen(false);
              if (!pendingAdd) return;
              const list = [...tokenList()];
              const has = list.some((x) => x.tag.id === pendingAdd.tag.id);
              if (!has) list.push(pendingAdd);
              await persistTagsWithBankDecision(
                list,
                /*removeUnknowns*/ false,
                /*keepUnknowns*/ true
              );
              setPendingAdd(null);
            }}
            onSwitchRemoveUnknowns={async () => {
              setConfirmSwitchOpen(false);
              if (!pendingAdd) return;
              const list = [...tokenList()];
              const has = list.some((x) => x.tag.id === pendingAdd.tag.id);
              if (!has) list.push(pendingAdd);
              await persistTagsWithBankDecision(
                list,
                /*removeUnknowns*/ true,
                /*keepUnknowns*/ false
              );
              setPendingAdd(null);
            }}
          />
        )}
        {clearConfirmOpen && (
          <ClearTagsModal
            onCancel={() => setClearConfirmOpen(false)}
            onConfirm={async () => {
              setClearConfirmOpen(false);
              await doClearTags();
            }}
          />
        )}
      </div>
    </div>
  );
}

function ClearTagsModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("keydown", onKey, opts);
    return () => window.removeEventListener("keydown", onKey, opts);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onConfirm();
          }
        }}
        style={{ maxWidth: 520 }}
      >
        <h3 style={{ marginTop: 0 }}>Clear all tags?</h3>
        <div className="panel" style={{ marginBottom: 12 }}>
          This will erase the entire comment field for this file, removing all
          tags (including the <code>TagB:&lt;bank&gt;</code> token).
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={onConfirm}>
            Yes, clear <span className="kbd">Enter</span>
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel <span className="kbd">Esc</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmSwitchBankModal({
  currentBank,
  fileBank,
  unknown,
  onCancel,
  onSwitchKeepUnknowns,
  onSwitchRemoveUnknowns,
}: {
  currentBank: string;
  fileBank: string;
  unknown: string[];
  onCancel: () => void;
  onSwitchKeepUnknowns: () => void;
  onSwitchRemoveUnknowns: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("keydown", onKey, opts);
    return () => window.removeEventListener("keydown", onKey, opts);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        tabIndex={0}
        style={{ maxWidth: 560 }}
      >
        <h3 style={{ marginTop: 0 }}>Switch tag bank?</h3>
        <div className="panel" style={{ marginBottom: 12 }}>
          This file appears to be tagged with <b>{fileBank}</b>. You are using{" "}
          <b>{currentBank}</b>.
          <br />
          Adding a tag will change the file’s tag bank to <b>{currentBank}</b>.
        </div>

        {unknown.length > 0 && (
          <div className="panel" style={{ marginBottom: 12 }}>
            Unknown tags present:{" "}
            {unknown.map((u) => (
              <span key={u} className="chip warning" style={{ marginRight: 4 }}>
                {u}
              </span>
            ))}
          </div>
        )}

        <div className="col" style={{ gap: 8 }}>
          <button className="btn primary" onClick={onSwitchRemoveUnknowns}>
            Switch & Remove Unknowns
          </button>
          <button className="btn" onClick={onSwitchKeepUnknowns}>
            Switch & Keep Unknowns
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function GlobalSettingsModal({
  settings,
  setSettings,
  onClose,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        (e as any).stopImmediatePropagation?.();
        onClose();
      }
    };
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("keydown", onKey, opts);
    return () => window.removeEventListener("keydown", onKey, opts);
  }, [onClose]);

  const shortcuts: { label: string; keys: string }[] = [
    { label: "Open folder", keys: "o" },
    { label: "Play/Pause", keys: "Space" },
    { label: "Previous song", keys: "a" },
    { label: "Next song", keys: "d" },
    { label: "Seek -10s / -30s", keys: "← / Shift+←" },
    { label: "Seek +10s / +30s", keys: "→ / Shift+→" },
    { label: "Toggle instant playback", keys: "⌘⇧P" },
    { label: "Open/Close Settings", keys: "⌘," },
    { label: "Manage tags", keys: "+" },
    { label: "Save in tag editor", keys: "Enter" },
    { label: "Apply tags 1–10", keys: "1..0" },
    { label: "Apply tags 11–20", keys: "Shift+1..9" },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "80vw",
          height: "80vh",
          maxWidth: 1100,
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: 16,
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="col" style={{ gap: 12, overflow: "auto" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Settings</h3>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>

          <div className="panel">
            <h4>Display</h4>
            <label>
              <input
                type="checkbox"
                checked={settings.showTitle}
                onChange={(e) =>
                  setSettings({ ...settings, showTitle: e.target.checked })
                }
              />{" "}
              Show title
            </label>
            <br />
            <label>
              <input
                type="checkbox"
                checked={settings.showAuthors}
                onChange={(e) =>
                  setSettings({ ...settings, showAuthors: e.target.checked })
                }
              />{" "}
              Show authors
            </label>
            <br />
            <label>
              <input
                type="checkbox"
                checked={settings.showGenre}
                onChange={(e) =>
                  setSettings({ ...settings, showGenre: e.target.checked })
                }
              />{" "}
              Show genre
            </label>
            <br />
            <label>
              <input
                type="checkbox"
                checked={settings.showComment ?? true}
                onChange={(e) =>
                  setSettings({ ...settings, showComment: e.target.checked })
                }
              />{" "}
              Show comments
            </label>
          </div>

          <div className="panel">
            <h4>Playback</h4>
            <label title="When enabled, selecting a song starts playback immediately (except the first auto-loaded song)">
              <input
                type="checkbox"
                checked={settings.instantPlayback}
                onChange={(e) => {
                  const next = e.target.checked;
                  setSettings({ ...settings, instantPlayback: next });
                  pushStatus(
                    <span>
                      Instant Playback toggled <b>{next ? "on" : "off"}</b>
                    </span>
                  );
                }}
              />{" "}
              Instant playback on selection
            </label>
            <div style={{ color: "#666", marginTop: 6, fontSize: 13 }}>
              Shortcut: ⌘⇧P
            </div>
          </div>
        </div>

        {/* Right sidebar: keyboard shortcuts */}
        <div className="panel" style={{ overflow: "auto" }}>
          <h4>Keyboard shortcuts</h4>
          <div className="col" style={{ gap: 6 }}>
            {shortcuts.map((s) => (
              <div
                key={s.label}
                className="row"
                style={{ justifyContent: "space-between" }}
              >
                <div>{s.label}</div>
                <div style={{ opacity: 0.8 }}>{s.keys}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: any }
> {
  constructor(props: any) {
    super(props);
    this.state = { error: undefined };
  }
  componentDidCatch(error: any, info: any) {
    console.error("[ErrorBoundary] caught", error, info);
    this.setState({ error });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="col" style={{ padding: 24, gap: 12 }}>
          <div className="panel">
            <b>App error</b>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {String(this.state.error)}
            </pre>
          </div>
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children as any;
  }
}

export default function App() {
  const [screen, setScreen] = useState<"start" | "tag">("start");
  const [folder, setFolder] = useState<string | null>(null);
  const [tagsFile, setTagsFile] = useState<TagsFile>(emptyTags());
  const [showManager, setShowManager] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const defaultSettings: Settings = {
    showTitle: true,
    showAuthors: true,
    showGenre: true,
    showComment: true, // <— NEW default
    instantPlayback: false,
  };
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  const [banks, setBanks] = useState<string[]>(["default"]);
  const [bank, setBank] = useState<string>("default");
  const [showNewBank, setShowNewBank] = useState(false);
  const [pendingBankName, setPendingBankName] = useState("");

  useEffect(() => {
    initSession();
    (async () => {
      // 1) Load settings first (fallback to defaults if error)
      try {
        const s = await readSettings();
        setSettings({ ...defaultSettings, ...s });
      } catch {
        /* use defaults */
      }
      // 2) Load banks + last used bank + tags
      const list = await listTagBanks().catch(() => ["default"]);
      setBanks(list.length ? list : ["default"]);
      const last = (await getLastUsedBank()) || "default";
      const chosen = list.includes(last) ? last : "default";
      setBank(chosen);

      // load tags for chosen bank
      const raw = await readTagsFileBank(chosen);
      setTagsFile(coerceTagsFile(JSON.parse(raw)));
    })();
  }, []);

  useEffect(() => {
    (async () => {
      await setLastUsedBank(bank);
      const raw = await readTagsFileBank(bank);
      setTagsFile(coerceTagsFile(JSON.parse(raw)));
    })();
  }, [bank]);

  useEffect(() => {
    const t = setTimeout(() => {
      writeSettings(settings).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [settings]);

  // Global shortcuts: ⌘+, opens settings; ⌘⇧P toggles instant playback
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.metaKey && !e.shiftKey && k === ",") {
        e.preventDefault();
        setShowSettings((open) => !open);
      } else if (e.metaKey && e.shiftKey && k === "p") {
        e.preventDefault();
        setSettings((s) => {
          const next = !s.instantPlayback;
          pushStatus(
            <span>
              Instant Playback toggled <b>{next ? "on" : "off"}</b>
            </span>
          );
          return { ...s, instantPlayback: next };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleOpenFolder() {
    try {
      const path = await chooseFolder();
      if (!path) return;
      console.info("[handleOpenFolder] opening:", path);
      setFolder(path);
      setScreen("tag");
    } catch (e) {
      console.error("[handleOpenFolder] failed:", e);
      alert("Failed to open folder: " + e);
    }
  }

  function handleSelectBank(next: string) {
    if (!next) return;
    setBank(next);
  }

  function handleCreateBank() {
    setPendingBankName("");
    setShowNewBank(true);
  }

  async function finalizeCreateBank(rawName: string) {
    const name = sanitizeBank(rawName);
    if (!name) return;

    // re-fetch to avoid race conditions (another create could have happened)
    const current = await listTagBanks().catch(() => []);
    const exists = current.some((b) => b.toLowerCase() === name.toLowerCase());
    if (exists) {
      // leave modal open; let the user change the name
      pushStatus(
        <span>
          Tag bank <b>{name}</b> already exists.
        </span>
      );
      return;
    }

    await writeTagsFileBank(name, JSON.stringify(emptyTags()));

    const list = await listTagBanks().catch(() => []);
    setBanks(list.length ? list : ["default"]);
    setBank(name);
    await setLastUsedBank(name);
    setShowNewBank(false);
  }

  return (
    <AppErrorBoundary>
      {screen === "start" ? (
        <StartScreen
          onOpenFolder={handleOpenFolder}
          onManageTags={() => setShowManager(true)}
          onOpenSettings={() => setShowSettings(true)}
          banks={banks}
          bank={bank}
          onSelectBank={handleSelectBank}
          onCreateBank={handleCreateBank}
        />
      ) : (
        <SongTagging
          folder={folder!}
          onBack={() => setScreen("start")}
          tagsFile={tagsFile}
          setTagsFile={setTagsFile}
          bank={bank}
          banks={banks}
          onSelectBank={handleSelectBank}
          onCreateBank={handleCreateBank}
          settings={settings}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
      {showSettings && (
        <GlobalSettingsModal
          settings={settings}
          setSettings={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showManager && (
        <TagManager
          tags={tagsFile}
          setTags={async (tf) => {
            setTagsFile(tf);
            await writeTagsFileBank(bank, JSON.stringify(tf));
            await logEvent("write_tags_file");
          }}
          onClose={() => setShowManager(false)}
        />
      )}
      {showNewBank && (
        <NewBankModal
          value={pendingBankName}
          setValue={setPendingBankName}
          existing={banks}
          onCancel={() => setShowNewBank(false)}
          onCreate={() => finalizeCreateBank(pendingBankName)}
        />
      )}
      <StatusViewport />
    </AppErrorBoundary>
  );
}

function NewBankModal({
  value,
  setValue,
  onCancel,
  onCreate,
  existing,
}: {
  value: string;
  setValue: (s: string) => void;
  onCancel: () => void;
  onCreate: () => void;
  existing: string[]; // 👈 new prop
}) {
  const [err, setErr] = React.useState<string>("");

  function tryCreate() {
    const sanitized = sanitizeBank(value);
    if (!sanitized) {
      setErr("Please enter a name.");
      return;
    }
    // case-insensitive check (sanitizeBank already lowercases, but keep it robust)
    const exists = existing.some(
      (b) => b.toLowerCase() === sanitized.toLowerCase()
    );
    if (exists) {
      setErr(`A tag bank named “${sanitized}” already exists.`);
      return;
    }
    setErr("");
    onCreate(); // App will do the actual creation
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        tryCreate();
      }
    };
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("keydown", onKey, opts);
    return () => window.removeEventListener("keydown", onKey, opts);
  }, [onCancel]);

  const preview = sanitizeBank(value || "default");

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            tryCreate();
          }
        }}
        style={{ maxWidth: 520 }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>New Tag Bank</h3>
          <button className="btn" onClick={onCancel}>
            Close
          </button>
        </div>

        {err && (
          <div className="panel" style={{ borderColor: "#f00", color: "#900" }}>
            {err}
          </div>
        )}

        <div className="panel">
          <label className="col">
            Name (letters, numbers, - and _)
            <input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.currentTarget.value);
                if (err) setErr(""); // clear error while typing
              }}
              placeholder="e.g., edm-bank-01"
            />
          </label>
          <div style={{ marginTop: 8, color: "#666", fontSize: 13 }}>
            Will be saved as <code>tags.{preview}.json</code> in
            <br />
            <code>~/Documents/AudioTagger/Banks</code>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={tryCreate}>
            Create <span className="kbd">Enter</span>
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel <span className="kbd">Esc</span>
          </button>
        </div>
      </div>
    </div>
  );
}

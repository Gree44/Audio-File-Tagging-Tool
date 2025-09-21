import React, { useEffect, useMemo, useState } from 'react'
import { initSession, chooseFolder, scanFolder, readMetadata, writeComment, readTagsFile, writeTagsFile, logEvent, fileUrl } from './tauri'
import Waveform from './components/Waveform'
import { TagDef, TagsFile, TrackMeta, Settings } from './types'
import { emptyTags, idFromName, parseCommentToTags, enforceParentAndMandatory, stringifyTagsForComment, validateTagName, ensureAtLeastOneMain, dedupeById } from './lib/tags'

function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = [e.shiftKey ? 'Shift+' : '', e.key].join('')
      const simple = e.key
      if (bindings[key]) { e.preventDefault(); bindings[key](e) }
      else if (bindings[simple]) { e.preventDefault(); bindings[simple](e) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindings])
}

function StartScreen({ onOpenFolder, onManageTags }: { onOpenFolder: () => void; onManageTags: () => void }) {
  useHotkeys({ 'o': () => onOpenFolder(), '+': () => onManageTags() })
  return (
    <div className="col" style={{ padding: 24, gap: 16 }}>
      <div className="toolbar">
        <div style={{ fontWeight: 700 }}>Audio Tagger</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onManageTags}>Manage Tags <span className="kbd">+</span></button>
          <button className="btn primary" onClick={onOpenFolder}>Open Folder <span className="kbd">o</span></button>
        </div>
      </div>
      <div className="panel">
        <h3>Tag Collections</h3>
        <p>Define your tags (main, mandatory, optional). Parent relationships auto-apply. Amount tags append a number (e.g., <code>energy5</code>).</p>
        <p>Tags are saved locally to <code>tags.json</code>.</p>
      </div>
    </div>
  )
}

function TagManager({ tags, setTags, onClose }: { tags: TagsFile; setTags: (t: TagsFile) => void; onClose: () => void }) {
  const [form, setForm] = useState<{ id?: string; name: string; type: 'main'|'mandatory'|'optional'; parent: string|''; hasAmount: boolean; min: number; max: number }>({ name: '', type: 'optional', parent: '', hasAmount: false, min: 0, max: 5 })
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() { setForm({ name: '', type: 'optional', parent: '', hasAmount: false, min: 0, max: 5 }); setEditing(null); setError(null) }

  function save() {
    try {
      validateTagName(form.name)
      const id = editing ?? idFromName(form.name)
      const def: TagDef = {
        id,
        name: form.name,
        type: form.type,
        parent: form.parent || null,
        amountRange: form.hasAmount ? { min: form.min, max: form.max } : null,
      }
      let next = { ...tags, tags: [...tags.tags] }
      const ix = next.tags.findIndex(t => t.id === id)
      if (ix >= 0) next.tags[ix] = def; else next.tags.push(def)
      setTags(next)
      reset()
    } catch (e: any) { setError(String(e.message || e)) }
  }

  function del(id: string) {
    const next = { ...tags, tags: tags.tags.filter(t => t.id !== id) }
    setTags(next)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') save() }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Manage Tags</h3>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {error && <div className="panel" style={{ borderColor: '#f00', color: '#900' }}>{error}</div>}

        <div className="grid">
          <label className="col">Name<input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}/></label>
          <label className="col">Type
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}>
              <option value="main">main</option>
              <option value="mandatory">mandatory</option>
              <option value="optional">optional</option>
            </select>
          </label>
          <label className="col">Parent
            <select value={form.parent} onChange={e => setForm(f => ({ ...f, parent: e.target.value }))}>
              <option value="">(none)</option>
              {tags.tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="col">Amount tag?
            <input type="checkbox" checked={form.hasAmount} onChange={e => setForm(f => ({ ...f, hasAmount: e.target.checked }))} />
          </label>
          {form.hasAmount && <>
            <label className="col">Min<input type="number" value={form.min} onChange={e => setForm(f => ({ ...f, min: Number(e.target.value) }))}/></label>
            <label className="col">Max<input type="number" value={form.max} onChange={e => setForm(f => ({ ...f, max: Number(e.target.value) }))}/></label>
          </>}
        </div>
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <button className="btn primary" onClick={save}>Save <span className="kbd">Enter</span></button>
          <button className="btn" onClick={reset}>Reset</button>
        </div>

        <div className="panel" style={{ marginTop: 12 }}>
          <div className="row" style={{ fontWeight: 600, marginBottom: 6 }}>
            <div style={{ width: 160 }}>Name</div>
            <div style={{ width: 100 }}>Type</div>
            <div style={{ width: 140 }}>Parent</div>
            <div>Amount</div>
          </div>
          {tags.tags.map(t => (
            <div key={t.id} className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
              <div style={{ width: 160 }}>{t.name}</div>
              <div style={{ width: 100 }}><span className="tag-type">{t.type}</span></div>
              <div style={{ width: 140 }}>{t.parent ? tags.tags.find(x => x.id === t.parent)?.name : '—'}</div>
              <div>{t.amountRange ? `${t.amountRange.min}..${t.amountRange.max}` : '—'}</div>
              <div style={{ marginLeft: 'auto' }} className="row">
                <button className="btn ghost" onClick={() => { setEditing(t.id); setForm({ name: t.name, type: t.type, parent: t.parent || '', hasAmount: !!t.amountRange, min: t.amountRange?.min ?? 0, max: t.amountRange?.max ?? 5 }) }}>Edit</button>
                <button className="btn ghost" onClick={() => del(t.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SongTagging({ folder, onBack, tagsFile, setTagsFile }: { folder: string; onBack: () => void; tagsFile: TagsFile; setTagsFile: (t: TagsFile) => void }) {
  const [files, setFiles] = useState<{ path: string; fileName: string }[]>([])
  const [sortAsc, setSortAsc] = useState(true)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [meta, setMeta] = useState<TrackMeta | null>(null)
  const [playing, setPlaying] = useState(false)
  const [settings, setSettings] = useState<Settings>(() => ({ showTitle: true, showAuthors: true, showGenre: true }))
  const [showManager, setShowManager] = useState(false)

  const audioUrl = useMemo(() => meta ? fileUrl(meta.path) : '', [meta])

  useEffect(() => { (async () => {
    const list = await scanFolder(folder)
    list.sort((a,b) => a.fileName.localeCompare(b.fileName))
    setFiles(list)
    setCurrentIndex(0)
  })() }, [folder])

  useEffect(() => { if (!files.length) return; selectIndex(0) }, [files])

  async function selectIndex(ix: number) {
    if (!files.length) return
    const bounded = (ix + files.length) % files.length
    setCurrentIndex(bounded)
    const f = files[bounded]
    const m: TrackMeta = await readMetadata(f.path)

    const parsed = parseCommentToTags(m.comment || '', tagsFile.tags)
    const enforced = enforceParentAndMandatory([...parsed], tagsFile.tags)
    const commentNormalized = stringifyTagsForComment(enforced)
    if (commentNormalized !== (m.comment || '')) {
      try {
        await writeComment(f.path, commentNormalized)
        await logEvent(`normalize_on_load path="${f.path}" -> "${commentNormalized}"`)
        m.comment = commentNormalized
      } catch (e: any) {
        alert('Failed to normalize tags on load: ' + e)
      }
    }
    setMeta(m)
    setPlaying(false)
  }

  function toggleSort() {
    const next = !sortAsc; setSortAsc(next)
    const sorted = [...files].sort((a,b) => next ? a.fileName.localeCompare(b.fileName) : b.fileName.localeCompare(a.fileName))
    const currentPath = files[currentIndex]?.path
    setFiles(sorted)
    const newIx = sorted.findIndex(s => s.path === currentPath)
    if (newIx >= 0) setCurrentIndex(newIx)
  }

  useHotkeys({
    ' ': () => setPlaying(p => !p),
    'ArrowLeft': () => window.dispatchEvent(new CustomEvent('seekrel', { detail: -10 } as any)),
    'Shift+ArrowLeft': () => window.dispatchEvent(new CustomEvent('seekrel', { detail: -30 } as any)),
    'ArrowRight': () => window.dispatchEvent(new CustomEvent('seekrel', { detail: 10 } as any)),
    'Shift+ArrowRight': () => window.dispatchEvent(new CustomEvent('seekrel', { detail: 30 } as any)),
    'd': () => selectIndex(currentIndex + 1),
    'a': () => selectIndex(currentIndex - 1),
    '+': () => setShowManager(true)
  })

  const flatTags = tagsFile.tags
  useHotkeys(Object.fromEntries([
    ...Array.from({ length: Math.min(10, flatTags.length) }, (_, i) => [String((i+1)%10), () => toggleTag(flatTags[i])]),
    ...Array.from({ length: Math.max(0, Math.min(20, flatTags.length) - 10) }, (_, i) => [`Shift+${i+1}`, () => toggleTag(flatTags[i+10])])
  ] as [string, (e: KeyboardEvent) => void][]))

  async function persistTags(chosen: { tag: TagDef; amount: number | null }[]) {
    if (!meta) return
    const final = enforceParentAndMandatory(dedupeById(chosen), tagsFile.tags)
    if (!ensureAtLeastOneMain(final, tagsFile.tags)) { alert('At least one MAIN tag is required'); return }
    const str = stringifyTagsForComment(final)
    try {
      await writeComment(meta.path, str)
      await logEvent(`write_comment path="${meta.path}" -> "${str}"`)
      setMeta({ ...meta, comment: str })
    } catch (e: any) {
      alert('Write failed: ' + e)
    }
  }

  function tokenList() {
    return parseCommentToTags(meta?.comment || '', tagsFile.tags)
  }

  async function toggleTag(t: TagDef) {
    if (!meta) return
    let list = tokenList()
    const has = list.some(x => x.tag.id === t.id)
    if (t.type === 'mandatory' && has) { alert('Mandatory tags cannot be removed'); return }
    if (has) list = list.filter(x => x.tag.id !== t.id)
    else list.push({ tag: t, amount: t.amountRange ? 0 : null })
    await persistTags(list)
  }

  async function setAmount(t: TagDef, n: number) {
    let list = tokenList()
    const ix = list.findIndex(x => x.tag.id === t.id)
    if (ix >= 0) list[ix] = { tag: t, amount: n }
    else list.push({ tag: t, amount: n })
    await persistTags(list)
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', height: '100%' }}>
      <div className="sidebar">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <button className="btn" onClick={onBack}>← Back</button>
          <button className="btn" onClick={toggleSort}>Sort {sortAsc ? '▲' : '▼'}</button>
        </div>
        {files.map((f, i) => (
          <div key={f.path} className={`sidebar-item ${i===currentIndex?'active':''}`} onClick={() => selectIndex(i)}>
            {f.fileName}
          </div>
        ))}
      </div>

      <div className="col" style={{ padding: 12 }}>
        <div className="toolbar">
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setPlaying(p => !p)}>Play/Pause <span className="kbd">Space</span></button>
            <button className="btn" onClick={() => selectIndex(currentIndex - 1)}>Prev <span className="kbd">A</span></button>
            <button className="btn" onClick={() => selectIndex(currentIndex + 1)}>Next <span className="kbd">D</span></button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setShowManager(true)}>Manage Tags <span className="kbd">+</span></button>
            <SettingsButton settings={settings} setSettings={setSettings} />
          </div>
        </div>

        {meta && (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="panel" style={{ flex: 1 }}>
              <Waveform url={audioUrl} playing={playing} />
            </div>
            <div className="col" style={{ width: 180, gap: 8 }}>
              {meta.pictureDataUrl ? <img className="img" src={meta.pictureDataUrl} alt="cover"/> : <div className="img" style={{ display: 'grid', placeItems: 'center', color: '#999' }}>No Art</div>}
              <div className="panel">
                <div className="col" style={{ gap: 4 }}>
                  {settings.showTitle && <div><b>Title:</b> {meta.title || '—'}</div>}
                  {settings.showAuthors && <div><b>Authors:</b> {(meta.artists||[]).join(', ') || '—'}</div>}
                  {settings.showGenre && <div><b>Genre:</b> {meta.genre || '—'}</div>}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="panel">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Selected tags for this song</div>
          <div>
            {parseCommentToTags(meta?.comment || '', tagsFile.tags).map(({ tag, amount }) => (
              <span className="chip active" key={tag.id} onClick={() => toggleTag(tag)} title="Click to remove">
                {tag.name}{tag.amountRange ? amount ?? 0 : ''}
              </span>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600 }}>All tags</div>
            <div className="row" style={{ gap: 12, color: '#666' }}>
              <div><span className="kbd">1..0</span> first 10</div>
              <div><span className="kbd">Shift+1..9</span> next 10</div>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            {tagsFile.tags.map((t, i) => {
              const selected = parseCommentToTags(meta?.comment || '', tagsFile.tags).some(x => x.tag.id === t.id)
              const keyCap = i < 10 ? String((i+1)%10) : (i < 20 ? `S+${i-9}` : '')
              return (
                <span key={t.id} className={`chip ${selected? 'active':''}`} onClick={() => toggleTag(t)}>
                  {t.name}
                  {t.amountRange && (
                    <input type="number" min={t.amountRange.min} max={t.amountRange.max}
                      style={{ width: 54, marginLeft: 6 }}
                      value={parseCommentToTags(meta?.comment || '', tagsFile.tags).find(x => x.tag.id===t.id)?.amount ?? 0}
                      onChange={e => setAmount(t, Number(e.target.value))}
                      onClick={e => e.stopPropagation()}
                    />
                  )}
                  {keyCap && <span className="kbd">{keyCap}</span>}
                </span>
              )
            })}
          </div>
        </div>

        {showManager && <TagManager tags={tagsFile} setTags={async (tf) => { setTagsFile(tf); await writeTagsFile(JSON.stringify(tf)); await logEvent('write_tags_file') }} onClose={() => setShowManager(false)} />}
      </div>
    </div>
  )
}

function SettingsButton({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen(o => !o)}>Settings ⚙️</button>
      {open && (
        <div className="panel" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 50 }}>
          <label><input type="checkbox" checked={settings.showTitle} onChange={e => setSettings({ ...settings, showTitle: e.target.checked })}/> Show title</label><br/>
          <label><input type="checkbox" checked={settings.showAuthors} onChange={e => setSettings({ ...settings, showAuthors: e.target.checked })}/> Show authors</label><br/>
          <label><input type="checkbox" checked={settings.showGenre} onChange={e => setSettings({ ...settings, showGenre: e.target.checked })}/> Show genre</label>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<'start'|'tag'>('start')
  const [folder, setFolder] = useState<string | null>(null)
  const [tagsFile, setTagsFile] = useState<TagsFile>(emptyTags())
  const [showManager, setShowManager] = useState(false)

  useEffect(() => { initSession(); (async () => { const raw = await readTagsFile(); setTagsFile(JSON.parse(raw)) })() }, [])

  async function handleOpenFolder() {
    const path = await chooseFolder()
    if (path) { setFolder(path); setScreen('tag') }
  }

  return (
    <>
      {screen === 'start' ? (
        <StartScreen onOpenFolder={handleOpenFolder} onManageTags={() => setShowManager(true)} />
      ) : (
        <SongTagging folder={folder!} onBack={() => setScreen('start')} tagsFile={tagsFile} setTagsFile={setTagsFile} />
      )}
      {showManager && <TagManager tags={tagsFile} setTags={async (tf) => { setTagsFile(tf); await writeTagsFile(JSON.stringify(tf)); await logEvent('write_tags_file') }} onClose={() => setShowManager(false)} />}
    </>
  )
}

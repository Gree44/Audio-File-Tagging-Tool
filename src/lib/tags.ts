import { TagDef, TagsFile } from '../types'

export function emptyTags(): TagsFile {
  return { version: 1, tags: [] }
}

export function validateTagName(name: string) {
  if (!name) throw new Error('Tag name required')
  if (/\s/.test(name)) throw new Error('No spaces allowed in tag names (use CamelCase or underscores)')
  if (name.includes(';')) throw new Error('Semicolons are reserved as separators')
}

export function idFromName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function topoParents(all: TagDef[], id: string, acc: Set<string> = new Set()): Set<string> {
  const tag = all.find(t => t.id === id)
  if (!tag) return acc
  if (tag.parent) {
    acc.add(tag.parent)
    topoParents(all, tag.parent, acc)
  }
  return acc
}

export function tokenToTagMatch(token: string, all: TagDef[]): { tag: TagDef | null; amount: number | null } {
  for (const t of all) {
    if (t.amountRange) {
      if (token.startsWith(t.name)) {
        const num = token.slice(t.name.length)
        if (/^\d+$/.test(num)) return { tag: t, amount: parseInt(num, 10) }
      }
    }
    if (token === t.name) return { tag: t, amount: null }
  }
  return { tag: null, amount: null }
}

export function stringifyTagsForComment(tags: { tag: TagDef; amount: number | null }[]): string {
  const items = tags.map(({ tag, amount }) => (tag.amountRange ? `${tag.name}${amount ?? 0}` : tag.name))
  return items.join(';')
}

export function parseCommentToTags(comment: string, all: TagDef[]) {
  const tokens = comment.split(';').map(s => s.trim()).filter(Boolean)
  const result: { tag: TagDef; amount: number | null }[] = []
  for (const tok of tokens) {
    const m = tokenToTagMatch(tok, all)
    if (m.tag) result.push({ tag: m.tag, amount: m.amount })
  }
  return result
}

export function enforceParentAndMandatory(
  selected: { tag: TagDef; amount: number | null }[],
  all: TagDef[]
) {
  const selectedIds = new Set(selected.map(s => s.tag.id))
  const toAddParents: string[] = []
  for (const s of selected) {
    for (const pid of topoParents(all, s.tag.id)) if (!selectedIds.has(pid)) toAddParents.push(pid)
  }
  for (const pid of toAddParents) {
    const pt = all.find(t => t.id === pid)
    if (pt && !selectedIds.has(pid)) selected.push({ tag: pt, amount: pt.amountRange ? 0 : null })
  }
  for (const t of all.filter(t => t.type === 'mandatory')) {
    if (!selectedIds.has(t.id)) selected.push({ tag: t, amount: t.amountRange ? 0 : null })
  }
  return dedupeById(selected)
}

export function dedupeById(list: { tag: TagDef; amount: number | null }[]) {
  const map = new Map<string, { tag: TagDef; amount: number | null }>()
  for (const item of list) map.set(item.tag.id, item)
  return Array.from(map.values())
}

export function ensureAtLeastOneMain(list: { tag: TagDef; amount: number | null }[], all: TagDef[]) {
  return list.some(x => x.tag.type === 'main') || all.filter(t => t.type === 'main').length === 0
}

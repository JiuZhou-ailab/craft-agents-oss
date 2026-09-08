// input: Source-line Search Hit, current source, and the editor's own Markdown parser
// output: Verified ProseMirror selection or an explicit stale/non-visible result
// pos: Translates source coordinates at the document representation boundary

import type { Node } from '@tiptap/pm/model'
import { ChangeSet } from '@tiptap/pm/changeset'
import { Transform } from '@tiptap/pm/transform'

export interface DocumentSearchTarget {
  requestId: string
  lineNumber: number
  query: string
  snippet: string
}

export interface DocumentSearchLocation {
  status: 'located' | 'relocated' | 'missing' | 'not-visible'
  from?: number
  to?: number
}

export function locateSourceSearch(source: string, target: DocumentSearchTarget): DocumentSearchLocation {
  const query = target.query.trim().replace(/\s+/g, ' ')
  if (!query) return { status: 'missing' }
  // RegExp keeps offsets in the original string even for Unicode case folding.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches = [...source.matchAll(pattern)]
  if (!matches.length) return { status: 'missing' }
  const lines = source.split('\n')
  const line = lines[target.lineNumber - 1]
  const start = lines.slice(0, target.lineNumber - 1).reduce((sum, value) => sum + value.length + 1, 0)
  const snippet = target.snippet.replace(/^\.\.\.|\.\.\.$/g, '').replace(/\s+/g, ' ').trim()
  const original = Number.isInteger(target.lineNumber) && target.lineNumber > 0 && line !== undefined
    && (!snippet || line.replace(/\s+/g, ' ').includes(snippet))
    ? matches.find(match => match.index! >= start && match.index! + match[0].length <= start + line.length)
    : undefined
  const match = original ?? matches[0]!
  return { status: original ? 'located' : 'relocated', from: match.index!, to: match.index! + match[0].length }

}

export function locateDocumentSearch(
  source: string,
  target: DocumentSearchTarget,
  doc: Node,
  parse: (source: string) => Node,
): DocumentSearchLocation {
  const location = locateSourceSearch(source, target)
  if (location.from === undefined || location.to === undefined) return location
  const fromSource = location.from
  const toSource = location.to
  const matchedText = source.slice(fromSource, toSource)

  // Parse ephemeral markers with the SAME parser, then remove them. Accept the
  // mapping only if removing them reconstructs the current document through the match.
  // This handles nested Markdown without guessing source-line → visual-line ratios.
  const marker = `search${crypto.randomUUID().replaceAll('-', '')}`
  const begin = `${marker}a`
  const end = `${marker}b`
  const marked = parse(source.slice(0, fromSource) + begin + source.slice(fromSource, toSource) + end + source.slice(toSource))
  let from: number | undefined
  let to: number | undefined
  marked.descendants((node, pos) => {
    if (!node.isText) return
    const a = node.text!.indexOf(begin)
    const b = node.text!.indexOf(end)
    if (a >= 0) from = pos + a
    if (b >= 0) to = pos + b
  })
  if (from === undefined || to === undefined || from >= to) return { status: 'not-visible' }
  const restored = new Transform(marked).delete(to, to + end.length).delete(from, from + begin.length).doc
  to -= begin.length
  // Editor plugins may add a trailing paragraph after a list. Differences beyond
  // the match cannot change its coordinates; differences before it invalidate them.
  const difference = restored.content.findDiffStart(doc.content)
  if (difference !== null && difference < to) {
    // Markers can turn a shortcut reference into literal brackets or change an
    // autolink's href. Reuse the editor's diff engine to map only unchanged text;
    // never accept a replacement that overlaps the requested range.
    const transform = new Transform(restored).replaceWith(0, restored.content.size, doc.content)
    const changes = ChangeSet.create(restored).addSteps(doc, transform.mapping.maps, null).changes
    if (changes.some(change => change.fromA < to! && change.toA > from!)) return { status: 'not-visible' }
    const offset = changes.filter(change => change.toA <= from!).reduce((sum, change) => sum + (change.toB - change.fromB) - (change.toA - change.fromA), 0)
    from += offset
    to += offset
  }
  if (to > doc.content.size || doc.textBetween(from, to) !== matchedText) return { status: 'not-visible' }
  return { ...location, from, to }
}

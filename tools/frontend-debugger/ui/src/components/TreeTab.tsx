import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { ipc } from '../ipc'
import type { TreeNode } from '../protocol'

function matchTree(node: TreeNode, q: string): boolean {
  if (!q) return true
  if (node.name.toLowerCase().includes(q)) return true
  return (node.children || []).some((c) => matchTree(c, q))
}

export function TreeTab() {
  const tree = useStore((s) => s.tree)
  const filter = useStore((s) => s.treeFilter)
  const setFilter = useStore((s) => s.setTreeFilter)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({})
  const selRef = useRef<HTMLDivElement>(null)

  // Auto-expand ancestors of the current selection.
  useEffect(() => {
    if (!selection) return
    setOpenMap((m) => {
      const next = { ...m }
      ;(selection.path || []).forEach((p) => (next[p.id] = true))
      return next
    })
    // Scroll selected row into view.
    setTimeout(() => selRef.current?.scrollIntoView({ block: 'nearest' }), 30)
  }, [selection?.id])

  const q = filter.trim().toLowerCase()

  const isOpen = (id: string, depth: number, isAncestor: boolean) => {
    if (q) return true // filter mode expands everything visible
    if (id in openMap) return openMap[id]
    return depth < 2 || isAncestor
  }

  const renderNode = (node: TreeNode, depth: number) => {
    if (q && !matchTree(node, q)) return null
    const hasKids = node.children && node.children.length > 0
    const selected = selection?.id === node.id
    const isAncestor = !!selection && selection.id.startsWith(node.id + '.')
    const open = isOpen(node.id, depth, isAncestor)
    const nameMatch = q && node.name.toLowerCase().includes(q)
    return (
      <div className="tnode" key={node.id}>
        <div
          ref={selected ? selRef : undefined}
          className={'trow' + (selected ? ' sel' : '') + (nameMatch ? ' match' : '')}
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => ipc.send('select', { id: node.id })}
          onMouseEnter={() => mode !== 'theater' && ipc.send('highlight', { id: node.id })}
          onMouseLeave={() => mode !== 'theater' && useStore.getState().setHover(null)}
        >
          <span
            className={'twisty' + (hasKids ? '' : ' empty')}
            onClick={(e) => {
              e.stopPropagation()
              setOpenMap((m) => ({ ...m, [node.id]: !open }))
            }}
          >
            {hasKids ? (open ? '▾' : '▸') : '·'}
          </span>
          <span className="tname">{node.name}</span>
          {hasKids && <span className="tcount">{node.children.length}</span>}
        </div>
        {open && hasKids && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const body = useMemo(() => tree.map((n) => renderNode(n, 0)), [tree, openMap, selection?.id, q, mode])

  return (
    <div className="tree-wrap">
      <div className="tree-toolbar">
        <input
          className="tree-search"
          placeholder="filter components…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="mini" onClick={() => setFilter('')}>
            ✕
          </button>
        )}
        <button className="mini" title="refresh" onClick={() => ipc.send('getTree', { max: 6000 })}>
          ⟳
        </button>
      </div>
      {!tree.length ? (
        <div className="empty-tab">No tree yet. Click ⟳, or wait for the app to mount.</div>
      ) : (
        <div className="tree">{body}</div>
      )}
    </div>
  )
}

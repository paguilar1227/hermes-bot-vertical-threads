import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { Thread, ThreadOwner } from './contracts'
import { orderedThreads, ThreadPreferences } from './preferences'
import './threads.css'

const DRAG_TYPE = 'application/x-hermes-vertical-thread'

interface Props { owner: ThreadOwner; preferences: ThreadPreferences }

export function ThreadList({ owner, preferences }: Props) {
  const prefs = useSyncExternalStore(
    listener => preferences.subscribe(owner.id, listener),
    () => preferences.get(owner.id),
  )
  const [editing, setEditing] = useState<Thread | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const rows = orderedThreads(owner.threads, prefs)
  const editingButton = useRef<HTMLButtonElement | null>(null)
  const requestBusy = useRef(false)
  const run = async (action: () => unknown | Promise<unknown>) => {
    if (requestBusy.current) return
    requestBusy.current = true
    setBusy(true)
    setError('')
    try { await action() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { requestBusy.current = false; setBusy(false) }
  }
  const title = (thread: Thread) => Object.hasOwn(prefs.names, thread.id) ? prefs.names[thread.id] : thread.title
  const closeEditor = useCallback((restoreFocus: boolean) => {
    setEditing(null)
    if (restoreFocus) editingButton.current?.focus()
  }, [])

  return <section className="hvt" aria-label={`${owner.title} threads`}>
    <header className="hvt-header">
      <button type="button" className="hvt-toggle" aria-expanded={prefs.expanded}
        onClick={() => void run(() => preferences.update(owner.id, { expanded: !prefs.expanded }))}>
        <span aria-hidden="true">{prefs.expanded ? '⌄' : '›'}</span> Threads <span className="hvt-count">{rows.length}</span>
      </button>
      {prefs.expanded && <select className="hvt-sort" aria-label={`Sort ${owner.title} threads`} value={prefs.sort}
        onChange={event => void run(() => preferences.update(owner.id, { sort: event.target.value === 'activity' ? 'activity' : 'manual' }))}>
        <option value="manual">Manual order</option>
        <option value="activity">Recent activity</option>
      </select>}
    </header>
    {prefs.expanded && <div className="hvt-branch">
      <ul aria-label={`${owner.title} thread list`}>
        {rows.map((thread, index) => <li key={thread.id} className={`hvt-row${owner.activeThreadId === thread.id ? ' is-active' : ''}${dragging === thread.id ? ' is-dragging' : ''}`}
          onDragOver={event => {
            if (prefs.sort === 'manual' && dragging && dragging !== thread.id) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }
          }}
          onDrop={event => {
            event.preventDefault()
            if (prefs.sort !== 'manual') return
            try {
              const source = JSON.parse(event.dataTransfer.getData(DRAG_TYPE))
              if (source.ownerId === owner.id && typeof source.threadId === 'string') {
                void run(() => preferences.move(owner.id, owner.threads, source.threadId, thread.id))
              }
            } catch { /* A foreign drag is not a thread reorder. */ }
            setDragging(null)
          }}>
          <button type="button" className="hvt-grip" aria-label={`Move ${title(thread)}`}
            disabled={prefs.sort !== 'manual' || busy}
            title={prefs.sort === 'manual' ? 'Drag to reorder; Alt + ↑ / ↓ to move' : 'Choose Manual order to rearrange'}
            draggable={prefs.sort === 'manual' && !busy}
            onDragStart={event => {
              if (prefs.sort !== 'manual') { event.preventDefault(); return }
              event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ownerId: owner.id, threadId: thread.id }))
              event.dataTransfer.effectAllowed = 'move'
              setDragging(thread.id)
            }}
            onDragEnd={() => setDragging(null)}
            onKeyDown={event => {
              if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
              event.preventDefault()
              const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (target) void run(() => preferences.move(owner.id, owner.threads, thread.id, target.id))
            }}>⠿</button>
          <button type="button" className="hvt-name" aria-current={owner.activeThreadId === thread.id ? 'page' : undefined}
            title={title(thread)} disabled={busy} onClick={() => void run(() => owner.openThread(thread.id))}>{title(thread)}</button>
          <button type="button" className="hvt-edit" aria-label={`Rename ${title(thread)}`} title="Rename thread" disabled={busy}
            onClick={event => { editingButton.current = event.currentTarget; setEditing(thread) }}>···</button>
        </li>)}
      </ul>
      <button type="button" className="hvt-new" disabled={busy} onClick={() => void run(() => owner.createThread())}>+ New thread</button>
    </div>}
    {error && <p className="hvt-error" role="alert">{error}</p>}
    {editing && <RenameDialog title={title(editing)} onCancel={closeEditor} onSave={value => {
      preferences.rename(owner.id, editing.id, value)
      closeEditor(true)
    }} />}
  </section>
}

function RenameDialog({ title, onCancel, onSave }: {
  title: string; onCancel: (restoreFocus: boolean) => void; onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(title)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const labelId = useId()
  const inputId = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) onCancel(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onCancel])
  return <div className="hvt-backdrop">
    <div className="hvt-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={labelId}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel(true) }
        if (event.key === 'Tab') { event.preventDefault(); input.current?.focus() }
      }}>
      <label id={labelId} htmlFor={inputId}>Rename thread</label>
      <input ref={input} id={inputId} value={draft} autoComplete="off"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          try { onSave(draft) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        }} />
      <p>Enter to save · Click outside or Esc to cancel</p>
      {error && <p className="hvt-error" role="alert">{error}</p>}
    </div>
  </div>
}

import type { Preferences, Storage, Thread } from './contracts'

const initial = (): Preferences => ({ order: [], names: {}, sort: 'manual', expanded: true })

export class ThreadPreferences {
  private records = new Map<string, Preferences>()
  private listeners = new Map<string, Set<() => void>>()

  constructor(private storage: Storage) {}

  get = (ownerId: string): Preferences => {
    let value = this.records.get(ownerId)
    if (!value) {
      const saved = this.storage.get<Partial<Preferences> | null>(this.key(ownerId), null)
      value = {
        ...initial(),
        order: Array.isArray(saved?.order) ? saved.order.filter(id => typeof id === 'string') : [],
        names: saved?.names && typeof saved.names === 'object'
          ? Object.fromEntries(Object.entries(saved.names).filter(([, name]) => typeof name === 'string'))
          : {},
        sort: saved?.sort === 'activity' ? 'activity' : 'manual',
        expanded: saved?.expanded !== false,
      }
      this.records.set(ownerId, value)
    }
    return value
  }

  subscribe = (ownerId: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(ownerId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(ownerId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(ownerId)
    }
  }

  update(ownerId: string, change: Partial<Preferences>): void {
    const next = { ...this.get(ownerId), ...change }
    // Do not paint a successful save if persistence failed.
    this.storage.set(this.key(ownerId), next)
    this.records.set(ownerId, next)
    this.listeners.get(ownerId)?.forEach(listener => listener())
  }

  rename(ownerId: string, threadId: string, input: string): void {
    const title = input.trim()
    if (!title) throw new Error('Enter a thread name.')
    this.update(ownerId, { names: { ...this.get(ownerId).names, [threadId]: title } })
  }

  move(ownerId: string, threads: readonly Thread[], from: string, target: string): void {
    const ids = orderedThreads(threads, { ...this.get(ownerId), sort: 'manual' }).map(t => t.id)
    const fromIndex = ids.indexOf(from)
    const targetIndex = ids.indexOf(target)
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return
    ids.splice(fromIndex, 1)
    ids.splice(targetIndex, 0, from)
    this.update(ownerId, { order: ids })
  }

  private key(ownerId: string): string {
    return `threads.v1.${encodeURIComponent(ownerId)}`
  }
}

export function orderedThreads(threads: readonly Thread[], preferences: Preferences): Thread[] {
  const rank = new Map(preferences.order.map((id, index) => [id, index]))
  const indexed = threads.map((thread, index) => ({ thread, index }))
  return indexed.sort((a, b) => {
    if (preferences.sort === 'activity') {
      const delta = b.thread.activityAt - a.thread.activityAt
      if (Number.isFinite(delta) && delta !== 0) return delta
    }
    return (rank.get(a.thread.id) ?? preferences.order.length + a.index)
      - (rank.get(b.thread.id) ?? preferences.order.length + b.index)
  }).map(({ thread }) => thread)
}

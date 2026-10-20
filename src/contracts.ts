/** The narrow bridge between the plugin UI and the host's conversations. */
export interface Thread {
  id: string
  title: string
  /** Unix milliseconds of actual conversation activity, never navigation. */
  activityAt: number
}

export interface ThreadOwner {
  /** Stable, connection-qualified identity, unaffected by display-name edits. */
  id: string
  title: string
  kind: 'bot' | 'team'
  threads: readonly Thread[]
  activeThreadId?: string | null
  openThread(id: string): void | Promise<void>
  createThread(): void | Promise<void>
}

export interface Storage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

export type SortMode = 'manual' | 'activity'

export interface Preferences {
  order: string[]
  names: Record<string, string>
  sort: SortMode
  expanded: boolean
}

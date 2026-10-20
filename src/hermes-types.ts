import type { ReactNode } from 'react'
import type { Storage, Thread } from './contracts'

export const PLUGIN_ID = 'hermes-bot-vertical-threads'
/** Same refresh cadence as Hermes Bot Mode's roster query. */
export const LIVE_REFRESH_MS = 5_000

export interface Route {
  connectionId: string
  profile: string
  targetProfile: string
  mode: 'local' | 'remote'
  primary?: true
}
export interface Agent {
  connectionId: string
  connectionLabel: string
  connectionKind: string
  profile: string
  targetProfile?: string
  handle: string
  profileMetadata?: { display_name?: string; ui_meta?: { 'hermes-bots'?: { title?: string } } }
}
export interface Session {
  id: string
  _lineage_root_id?: string | null
  title?: string
  last_active?: number
  source?: string
  profile?: string
  message_count?: number
}
export interface Room {
  room_id: string
  name: string
  members: { member_id: string; profile: string; handle: string; display_name?: string }[]
}
export interface RoomEvent {
  seq: number
  event_id: string
  kind: string
  created_at: number
  actor?: { id?: string; display_name?: string; kind?: string }
  payload: { thread_id?: string; text?: string; content?: string; error?: string; reason?: string; member_id?: string; [key: string]: unknown }
}
export interface PendingAction {
  kind: string
  task_id: string
  member_id: string
  execution_generation: number
  request_id?: string
  thread_id?: string
  [key: string]: unknown
}
export interface RoomSnapshot {
  room: Room
  events: RoomEvent[]
  driver_status?: { pending_actions?: PendingAction[]; [key: string]: unknown }
}
export interface BotThreads {
  threads: Thread[]
  sessions: Record<string, Session>
  total: number
  truncated: boolean
}
export interface Readable<T> { get(): T; subscribe(listener: (value: T) => void): () => void }

/** Only public SDK members used by this plugin, checked against the linked upstream source. */
export interface HermesHost {
  state: {
    gateway: Readable<string>
    focusedStoredSessionId: Readable<string | null>
  }
  agents(): Promise<{ agents: Agent[]; sources: { connectionId: string; label: string; error?: string }[] }>
  profileRoutes(): Promise<Route[]>
  paneVisibility(id: string): Readable<boolean>
  retainProfile(route: Route, options?: { spawnPriority?: 'foreground' | 'background' }): Promise<() => void>
  listPersistedSessions(route: Route, options: { profile: string; limit: number }): Promise<{
    sessions: Session[]; total: number; errors?: { profile: string; error: string }[]
  }>
  requestProfile<T>(route: Route, method: string, params?: Record<string, unknown>, timeout?: number,
    options?: { spawnPriority?: 'foreground' | 'background' }): Promise<T>
  openSession(id: string, options: { route: Route; profile: string; intent: 'tab'; tabTitle?: string }): Promise<void>
  openWorkspace(id: string, options: { title: string; render(): ReactNode; onClose(): void }): () => void
}
export interface PluginContext {
  storage: Storage
  register(contribution: { id: string; area: string; title: string; data: Record<string, unknown>; render(): ReactNode }): () => void
  onDispose(callback: () => void): void
}

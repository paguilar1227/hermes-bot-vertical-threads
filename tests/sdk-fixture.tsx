import React, { useSyncExternalStore } from 'react'
export { useQuery, useQueryClient } from '@tanstack/react-query'
import type { HermesHost, Readable, RoomEvent, Route, Session } from '../src/hermes-types'

function atom<T>(initial: T) {
  let value = initial
  const listeners = new Set<(value: T) => void>()
  return { get: () => value, subscribe: (listener: (value: T) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, set: (next: T) => { value = next; listeners.forEach(listener => listener(value)) } }
}
export function useValue<T>(store: Readable<T>): T { return useSyncExternalStore(listener => store.subscribe(listener), store.get) }
export const workspaces = atom(new Map<string, { title: string; render(): React.ReactNode; close(): void }>())
export const lastOpened = atom('')
export const lastSend = atom('')
export const disabled = atom(false)
let delayCreate = false
let finishCreate: (() => void) | undefined
export const createStatus = atom('idle')
export function delayNextCreate() { delayCreate = true; lastOpened.set('') }
export function releaseCreate() { finishCreate?.(); createStatus.set('released') }
const focused = atom<string | null>(null)
const routes: Route[] = ['local', 'remote'].map(connectionId => ({ connectionId, profile: 'assistant', targetProfile: 'assistant', mode: connectionId === 'local' ? 'local' : 'remote' }))
const teamOnlyRoute: Route = { connectionId: 'local', profile: 'reviewer', targetProfile: 'reviewer', mode: 'local' }
const sessions: Record<string, Session[]> = {
  local: [{ id: 'local-session', title: 'Release plan', last_active: 10 }],
  remote: [{ id: 'remote-session', title: 'Remote plan', last_active: 20 }],
}
const events: Record<string, RoomEvent[]> = {
  'local/assistant': [{ seq: 1, event_id: 'event-1', kind: 'message.user', created_at: 100, actor: { id: 'user' }, payload: { thread_id: 'existing-team-thread', text: 'Monday release' } }],
  'local/reviewer': [{ seq: 1, event_id: 'event-1', kind: 'message.user', created_at: 100, actor: { id: 'user' }, payload: { thread_id: 'existing-team-thread', text: 'QA checklist' } }],
  'remote/assistant': [],
}
const room = { room_id: 'team', name: 'Release Team', members: [{ member_id: 'assistant', profile: 'assistant', handle: 'assistant' }, { member_id: 'reviewer', profile: 'reviewer', handle: 'reviewer' }] }

export const host: HermesHost = {
  state: { gateway: atom('open'), focusedStoredSessionId: focused },
  paneVisibility: () => atom(true),
  agents: async () => ({ agents: routes.map(route => ({ connectionId: route.connectionId, connectionKind: route.mode, connectionLabel: route.connectionId === 'local' ? 'This device' : 'Remote host', profile: route.profile, handle: `assistant-${route.connectionId}` })), sources: [] }),
  profileRoutes: async () => [...routes, teamOnlyRoute],
  retainProfile: async () => () => {},
  listPersistedSessions: async route => ({ sessions: sessions[route.connectionId], total: sessions[route.connectionId].length }),
  openSession: async (id, options) => { lastOpened.set(`${options.route.connectionId}:${id}`); focused.set(id) },
  openWorkspace: (id, options) => {
    const close = () => { const next = new Map(workspaces.get()); next.delete(id); workspaces.set(next); options.onClose() }
    workspaces.set(new Map(workspaces.get()).set(id, { ...options, close }))
    return close
  },
  requestProfile: async <T,>(route: Route, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (params.profile !== route.targetProfile) throw new Error('Wrong profile scope')
    const key = `${route.connectionId}/${route.targetProfile}`
    const scopedRoom = route.targetProfile === 'reviewer' ? { ...room, name: 'Review Team' } : room
    let result: unknown
    if (method === 'groups.capabilities') result = { driver: true }
    else if (method === 'groups.list') result = { rooms: route.connectionId === 'local' ? [scopedRoom] : [], next_offset: null }
    else if (method === 'groups.state') result = { room: scopedRoom, driver_status: { pending_actions: [] } }
    else if (method === 'groups.log') result = { events: events[key], cursor: events[key].length, has_more: false }
    else if (method === 'groups.send') {
      const payload = params.payload as { text: string; thread_id: string }
      events[key].push({ seq: events[key].length + 1, event_id: String(params.event_id), kind: 'message.user', created_at: 200, actor: { id: 'user' }, payload })
      lastSend.set(`${key}:${params.room_id}:${payload.thread_id}:${payload.text}`)
      result = { accepted: true }
    } else if (method === 'session.create') {
      if (delayCreate) { delayCreate = false; createStatus.set('waiting'); await new Promise<void>(resolve => { finishCreate = resolve }) }
      result = { session_id: 'new-runtime', stored_session_id: 'new-stored' }
    }
    else if (method === 'session.title') { sessions[route.connectionId].push({ id: 'new-stored', title: String(params.title), last_active: 0 }); result = { ok: true } }
    else throw new Error(`Unknown RPC ${method}`)
    return result as T
  },
}

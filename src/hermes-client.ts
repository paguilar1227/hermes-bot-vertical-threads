import type { Thread, Storage } from './contracts'
import type { Agent, BotThreads, HermesHost, PendingAction, Room, RoomEvent, RoomSnapshot, Route, Session } from './hermes-types'

export const ownerKey = (kind: 'bot' | 'team', route: Route, identity: string) =>
  JSON.stringify([kind, route.connectionId, route.targetProfile, identity])

export function routeForAgent(agent: Agent, routes: Route[]): Route {
  const route = routes.find(r => r.connectionId === agent.connectionId && r.profile === agent.profile)
  if (!route) throw new Error(`No route for ${agent.handle}. Refresh the connections in Hermes.`)
  return { ...route }
}

export function threadsFromEvents(events: RoomEvent[]): Thread[] {
  const threads = new Map<string, Thread>()
  for (const event of events) {
    const id = event.payload.thread_id
    if (!id || !['message.user', 'message.member'].includes(event.kind)) continue
    const old = threads.get(id)
    const text = (event.payload.text || event.payload.content || '').trim()
    const at = Number.isFinite(event.created_at) ? event.created_at * 1000 : 0
    threads.set(id, {
      id, title: old?.title || text.split('\n')[0] || 'Untitled thread',
      activityAt: Math.max(old?.activityAt || 0, at),
    })
  }
  return [...threads.values()]
}

interface PendingSend { event_id: string; room_id: string; payload: { text: string; thread_id: string } }

export class HermesClient {
  private created = new Map<string, Session[]>()
  private disposed = false
  constructor(readonly host: HermesHost, readonly storage: Storage) {}
  dispose() { this.disposed = true }
  assertActive() { if (this.disposed) throw new Error('Vertical Threads is disabled.') }

  async botThreads(route: Route): Promise<BotThreads> {
    this.assertActive()
    // The public SDK enforces a 500-row ceiling. Surface truncation explicitly.
    const result = await this.host.listPersistedSessions(route, { profile: route.targetProfile, limit: 500 })
    const error = result.errors?.find(e => e.profile === route.targetProfile)
    if (error) throw new Error(error.error)
    const key = ownerKey('bot', route, route.targetProfile)
    const sessions: Record<string, Session> = {}
    for (const row of [...(this.created.get(key) || []), ...result.sessions]) {
      sessions[row._lineage_root_id || row.id] = row
    }
    return {
      sessions, total: result.total, truncated: result.total > result.sessions.length,
      threads: Object.entries(sessions).map(([id, row]) => ({
        id, title: row.title || 'Untitled thread',
        activityAt: Number.isFinite(row.last_active) ? row.last_active! * 1000 : 0,
      })),
    }
  }

  async createBotThread(route: Route): Promise<Session> {
    this.assertActive()
    const title = `Thread ${crypto.randomUUID()}`
    const release = await this.host.retainProfile(route, { spawnPriority: 'foreground' })
    try {
      const result = await this.request<{ session_id: string; stored_session_id?: string }>(route, 'session.create', {
        title, hidden: false, follow_profile_config: true,
      }, true)
      if (!result.session_id || !result.stored_session_id) throw new Error('Hermes did not return a stored conversation ID. Update Hermes Desktop.')
      // Creation is lazy. Hold its socket until the row exists; never send an invented prompt.
      await this.request(route, 'session.title', { session_id: result.session_id, title }, true)
      this.assertActive()
      const row: Session = { id: result.stored_session_id, title, last_active: 0 }
      const key = ownerKey('bot', route, route.targetProfile)
      this.created.set(key, [...(this.created.get(key) || []), row])
      return row
    } finally { release() }
  }

  async openBotThread(route: Route, session: Session, title: string) {
    this.assertActive()
    return this.host.openSession(session.id, { route, profile: route.targetProfile, intent: 'tab', tabTitle: title })
  }

  async teams(route: Route): Promise<Room[]> {
    const capabilities = await this.request<{ driver: boolean }>(route, 'groups.capabilities')
    if (!capabilities.driver) throw new Error('The Hermes team driver is unavailable on this connection. Start its gateway and refresh.')
    const rooms: Room[] = []
    let offset = 0
    for (;;) {
      const page = await this.request<{ rooms: Room[]; next_offset: number | null }>(route, 'groups.list', { offset })
      rooms.push(...page.rooms)
      if (page.next_offset === null) break
      if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error('Hermes returned an invalid team-list cursor.')
      offset = page.next_offset
    }
    return rooms
  }

  async room(route: Route, roomId: string): Promise<RoomSnapshot> {
    const snapshot = await this.request<Omit<RoomSnapshot, 'events'>>(route, 'groups.state', { room_id: roomId })
    const events: RoomEvent[] = []
    let cursor = 0
    for (;;) {
      const page = await this.request<{ events: RoomEvent[]; has_more: boolean; cursor: number }>(route, 'groups.log', { room_id: roomId, since_seq: cursor })
      events.push(...page.events)
      if (!page.has_more) break
      if (!Number.isSafeInteger(page.cursor) || page.cursor <= cursor) throw new Error('Hermes returned an invalid team-history cursor.')
      cursor = page.cursor
    }
    return { ...snapshot, events }
  }

  teamThreads(route: Route, roomId: string, events: RoomEvent[]): Thread[] {
    const drafts = this.storage.get<Thread[]>(this.draftKey(route, roomId), [])
    const threads = new Map(drafts.map(t => [t.id, t]))
    for (const thread of threadsFromEvents(events)) threads.set(thread.id, thread)
    return [...threads.values()]
  }

  createTeamThread(route: Route, roomId: string): Thread {
    this.assertActive()
    const thread = { id: crypto.randomUUID(), title: 'New thread', activityAt: 0 }
    const key = this.draftKey(route, roomId)
    this.storage.set(key, [...this.storage.get<Thread[]>(key, []), thread])
    return thread
  }

  pending(route: Route, roomId: string, threadId: string): PendingSend | null {
    return this.storage.get<PendingSend | null>(this.sendKey(route, roomId, threadId), null)
  }

  async send(route: Route, roomId: string, threadId: string, text: string): Promise<void> {
    const key = this.sendKey(route, roomId, threadId)
    const pending = this.pending(route, roomId, threadId) ?? {
      event_id: crypto.randomUUID(), room_id: roomId, payload: { text: text.trim(), thread_id: threadId },
    }
    if (!pending.payload.text) throw new Error('Enter a message.')
    this.storage.set(key, pending)
    const result = await this.request<{ accepted: boolean }>(route, 'groups.send', { ...pending }, true)
    if (result.accepted !== true) throw new Error('Hermes did not acknowledge this message. Retry to check the same send.')
    this.storage.set(key, null)
  }

  async resolveAction(route: Route, roomId: string, action: PendingAction, choice?: 'once' | 'deny') {
    if (!action.task_id || !action.member_id || !Number.isSafeInteger(action.execution_generation)) throw new Error('Invalid Hermes team action.')
    if (action.kind === 'approval' && (!action.request_id || !choice)) throw new Error('Approval needs an explicit choice and request ID.')
    if (!['approval', 'retry'].includes(action.kind)) throw new Error('Resolve this action in Hermes Bot Mode.')
    return this.request(route, action.kind === 'approval' ? 'groups.approve' : 'groups.retry', {
      room_id: roomId, task_id: action.task_id, member_id: action.member_id,
      execution_generation: action.execution_generation,
      ...(action.kind === 'approval' ? { request_id: action.request_id, choice } : {}),
    }, true)
  }

  private request<T>(route: Route, method: string, params: Record<string, unknown> = {}, interactive = false) {
    this.assertActive()
    return this.host.requestProfile<T>(route, method, { ...params, profile: route.targetProfile }, undefined,
      interactive ? { spawnPriority: 'foreground' } : undefined)
  }
  private draftKey(route: Route, roomId: string) { return `drafts.${ownerKey('team', route, roomId)}` }
  private sendKey(route: Route, roomId: string, threadId: string) { return `send.${ownerKey('team', route, roomId)}.${threadId}` }
}

import { describe, expect, it, vi } from 'vitest'
import { HermesClient, ownerKey, routeForAgent, threadsFromEvents } from '../src/hermes-client'
import type { HermesHost, RoomEvent, Route } from '../src/hermes-types'
import type { Storage } from '../src/contracts'

const route: Route = { connectionId: 'remote-a', profile: 'agent', targetProfile: 'target-agent', mode: 'remote' }
function setup() {
  const records = new Map<string, unknown>()
  const storage: Storage = { get: (key, fallback) => (records.get(key) ?? fallback) as typeof fallback, set: (key, value) => { records.set(key, value) } }
  const host = { requestProfile: vi.fn(), listPersistedSessions: vi.fn(), openSession: vi.fn(), retainProfile: vi.fn(async () => () => {}) } as unknown as HermesHost
  return { records, storage, host, client: new HermesClient(host, storage) }
}
function event(seq: number, thread: string, at: number, kind = 'message.user'): RoomEvent {
  return { seq, event_id: String(seq), kind, created_at: at, payload: { thread_id: thread, text: `Message ${seq}` } }
}

it('resolves a full source-qualified route and refuses a same-name agent from another connection', () => {
  const agent = { connectionId: 'remote-a', connectionLabel: 'A', connectionKind: 'remote', profile: 'agent', handle: 'agent-a' }
  expect(routeForAgent(agent, [route])).toEqual(route)
  expect(() => routeForAgent({ ...agent, connectionId: 'remote-b' }, [route])).toThrow('No route')
  expect(ownerKey('bot', route, 'agent')).not.toEqual(ownerKey('bot', { ...route, connectionId: 'remote-b' }, 'agent'))
})

it('uses last activity, preserves compression identity, and reports SDK truncation', async () => {
  const { client, host } = setup()
  vi.mocked(host.listPersistedSessions).mockResolvedValue({ total: 501, sessions: [{ id: 'new-tip', _lineage_root_id: 'root', title: 'Plan', last_active: 99 }] })
  const result = await client.botThreads(route)
  expect(host.listPersistedSessions).toHaveBeenCalledWith(route, { profile: 'target-agent', limit: 500 })
  expect(result.threads).toEqual([{ id: 'root', title: 'Plan', activityAt: 99000 }])
  expect(result.truncated).toBe(true)
  await client.openBotThread(route, result.sessions.root, 'My name')
  expect(host.openSession).toHaveBeenCalledWith('new-tip', { route, profile: 'target-agent', intent: 'tab', tabTitle: 'My name' })
})

it('creates and materializes a side thread without sending a model prompt', async () => {
  const { client, host } = setup()
  vi.mocked(host.requestProfile).mockResolvedValueOnce({ session_id: 'runtime', stored_session_id: 'stored' }).mockResolvedValueOnce({ ok: true })
  const row = await client.createBotThread(route)
  expect(row.id).toBe('stored')
  const calls = vi.mocked(host.requestProfile).mock.calls
  expect(calls.map(call => call[1])).toEqual(['session.create', 'session.title'])
  expect(calls[0][0]).toEqual(route)
  expect(calls[0][2]).toMatchObject({ profile: 'target-agent', hidden: false, follow_profile_config: true })
  expect(calls[1][2]).toMatchObject({ profile: 'target-agent', session_id: 'runtime' })
  expect(calls[0][4]).toEqual({ spawnPriority: 'foreground' })
})

it('surfaces a failed eager title write instead of claiming a usable thread was created', async () => {
  const { client, host } = setup()
  vi.mocked(host.requestProfile).mockResolvedValueOnce({ session_id: 'runtime', stored_session_id: 'stored' }).mockRejectedValueOnce(new Error('Disconnected'))
  await expect(client.createBotThread(route)).rejects.toThrow('Disconnected')
  expect(host.openSession).not.toHaveBeenCalled()
})

it('keeps a remote runtime alive until the durable thread is materialized, then releases it', async () => {
  const { client, host } = setup()
  let held = false
  const release = vi.fn(() => { held = false })
  vi.mocked(host.retainProfile).mockImplementation(async () => { held = true; return release })
  vi.mocked(host.requestProfile).mockImplementation(async (_route, method) => {
    if (!held) throw new Error('4001: runtime was reaped when the secondary socket closed')
    return (method === 'session.create' ? { session_id: 'runtime', stored_session_id: 'stored' } : { ok: true }) as never
  })
  await expect(client.createBotThread(route)).resolves.toMatchObject({ id: 'stored' })
  expect(release).toHaveBeenCalledOnce()
  expect(held).toBe(false)
  vi.mocked(host.requestProfile).mockRejectedValueOnce(new Error('Disconnected'))
  await expect(client.createBotThread(route)).rejects.toThrow('Disconnected')
  expect(release).toHaveBeenCalledTimes(2)
})

it('disabling during a delayed create prevents later RPCs and navigation', async () => {
  const { client, host } = setup()
  let finish!: (value: unknown) => void
  vi.mocked(host.requestProfile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const creating = client.createBotThread(route)
  await Promise.resolve()
  client.dispose()
  finish({ session_id: 'runtime', stored_session_id: 'stored' })
  await expect(creating).rejects.toThrow('disabled')
  expect(host.requestProfile).toHaveBeenCalledTimes(1)
  await expect(client.openBotThread(route, { id: 'stored' }, 'Name')).rejects.toThrow('disabled')
  expect(host.openSession).not.toHaveBeenCalled()
})

it('paginates team discovery and history with the server cursors', async () => {
  const { client, host } = setup()
  vi.mocked(host.requestProfile).mockResolvedValueOnce({ driver: true })
    .mockResolvedValueOnce({ rooms: [{ room_id: 'one' }], next_offset: 1 })
    .mockResolvedValueOnce({ rooms: [{ room_id: 'two' }], next_offset: null })
  expect((await client.teams(route)).map(r => r.room_id)).toEqual(['one', 'two'])
  expect(vi.mocked(host.requestProfile).mock.calls[2][2]).toMatchObject({ offset: 1, profile: 'target-agent' })
  vi.mocked(host.requestProfile).mockReset().mockResolvedValueOnce({ room: { room_id: 'one' } })
    .mockResolvedValueOnce({ events: [event(1, 'thread', 1)], has_more: true, cursor: 1 })
    .mockResolvedValueOnce({ events: [event(2, 'thread', 2)], has_more: false, cursor: 2 })
  expect((await client.room(route, 'one')).events).toHaveLength(2)
  expect(vi.mocked(host.requestProfile).mock.calls[2][2]).toMatchObject({ since_seq: 1, room_id: 'one' })
})

it('refuses a non-advancing cursor instead of looping forever', async () => {
  const { client, host } = setup()
  vi.mocked(host.requestProfile).mockResolvedValueOnce({ room: {} }).mockResolvedValue({ events: [], has_more: true, cursor: 0 })
  await expect(client.room(route, 'one')).rejects.toThrow('invalid team-history cursor')
})

it('derives team activity from actual messages, not room renames, creation, or other threads', () => {
  expect(threadsFromEvents([event(1, 'a', 1), event(2, 'b', 5), event(3, 'a', 7, 'message.member'), event(4, 'b', 99, 'room.renamed')]))
    .toEqual([{ id: 'a', title: 'Message 1', activityAt: 7000 }, { id: 'b', title: 'Message 2', activityAt: 5000 }])
})

describe('uncertain sends', () => {
  it('persists the exact payload and retries its event ID across a fresh client', async () => {
    const { client, host, storage } = setup()
    vi.mocked(host.requestProfile).mockRejectedValueOnce(new Error('timeout'))
    await expect(client.send(route, 'room', 'thread', 'Hello')).rejects.toThrow('timeout')
    const original = vi.mocked(host.requestProfile).mock.calls[0]
    expect(client.pending(route, 'room', 'thread')?.payload.text).toBe('Hello')
    const fresh = new HermesClient(host, storage)
    vi.mocked(host.requestProfile).mockResolvedValueOnce({ accepted: true })
    await fresh.send(route, 'room', 'thread', 'This different draft must not replace an uncertain send')
    expect(vi.mocked(host.requestProfile).mock.calls[1]).toEqual(original)
    expect(fresh.pending(route, 'room', 'thread')).toBeNull()
    expect(original[2]).toMatchObject({ profile: 'target-agent', room_id: 'room', payload: { thread_id: 'thread', text: 'Hello' } })
  })
  it('cannot cross a connection or room boundary', async () => {
    const { client, host } = setup()
    vi.mocked(host.requestProfile).mockRejectedValue(new Error('timeout'))
    await expect(client.send(route, 'room', 'thread', 'Hello')).rejects.toThrow()
    expect(client.pending({ ...route, connectionId: 'remote-b' }, 'room', 'thread')).toBeNull()
    expect(client.pending(route, 'other-room', 'thread')).toBeNull()
    expect(client.pending({ ...route, targetProfile: 'other-profile' }, 'room', 'thread')).toBeNull()
  })
})

it('routes explicit approvals to the exact task and request', async () => {
  const { client, host } = setup()
  const action = { kind: 'approval', member_id: 'engineer', task_id: 'task', execution_generation: 2, request_id: 'request' }
  await expect(client.resolveAction(route, 'room', action)).rejects.toThrow('explicit choice')
  await client.resolveAction(route, 'room', action, 'deny')
  expect(host.requestProfile).toHaveBeenCalledWith(route, 'groups.approve', {
    room_id: 'room', member_id: 'engineer', task_id: 'task', execution_generation: 2, request_id: 'request', choice: 'deny', profile: 'target-agent',
  }, undefined, { spawnPriority: 'foreground' })
})

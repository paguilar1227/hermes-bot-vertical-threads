import { useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useId, useRef, useState } from 'react'
import { HermesClient, ownerKey } from './hermes-client'
import { LIVE_REFRESH_MS, PLUGIN_ID } from './hermes-types'
import type { PendingAction, Room, RoomEvent, Route } from './hermes-types'
import { pluginStyles } from './styles'

export const roomQueryKey = (route: Route, roomId: string) => [PLUGIN_ID, 'room', ownerKey('team', route, roomId)]

function ChatHistory({ events, loading }: { events: RoomEvent[]; loading: boolean }) {
  return <div className="hvt-history" role="log" aria-label="Team messages">
    {events.map(event => <article key={event.seq}>
      <strong>{event.actor?.display_name || event.actor?.id || event.kind}</strong>
      <p>{event.payload.text || event.payload.content || event.payload.error || event.payload.reason || event.kind}</p>
    </article>)}
    {!loading && !events.length && <p>Start this thread with a message to the team.</p>}
  </div>
}

function PendingActions({ actions, busy, resolve }: {
  actions: PendingAction[]; busy: boolean; resolve(action: PendingAction, choice?: 'once' | 'deny'): void
}) {
  return <>{actions.map(action => <div className="hvt-action" key={`${action.kind}/${action.task_id}/${action.execution_generation}`}>
    <strong>{action.member_id}: {action.kind}</strong>
    {!action.thread_id && <span>Team-wide action</span>}
    <pre>{JSON.stringify(action, null, 2)}</pre>
    {action.kind === 'approval' ? <>
      <button disabled={busy} onClick={() => resolve(action, 'once')}>Allow once</button>
      <button disabled={busy} onClick={() => resolve(action, 'deny')}>Deny</button>
    </> : action.kind === 'retry'
      ? <button disabled={busy} onClick={() => resolve(action)}>Retry task</button>
      : <p>Resolve this action in Hermes Bot Mode.</p>}
  </div>)}</>
}

export function TeamChat({ client, route, room, threadId, title }: {
  client: HermesClient; route: Route; room: Room; threadId: string; title: string
}) {
  const cache = useQueryClient()
  const messageInputId = useId()
  const query = useQuery({ queryKey: roomQueryKey(route, room.room_id), queryFn: () => client.room(route, room.room_id), refetchInterval: LIVE_REFRESH_MS, retry: false })
  const [draft, setDraft] = useState(() => client.pending(route, room.room_id, threadId)?.payload.text || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const pending = client.pending(route, room.room_id, threadId)
  const events = query.data?.events.filter(event => event.payload.thread_id === threadId) || []
  const actions = query.data?.driver_status?.pending_actions?.filter(action => !action.thread_id || action.thread_id === threadId) || []
  const perform = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      await cache.invalidateQueries({ queryKey: roomQueryKey(route, room.room_id) })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <section className="hvt hvt-chat" aria-label={`${room.name}: ${title}`}>
    <style>{pluginStyles}</style>
    <header><strong>{title}</strong><p>{room.name} · {room.members.map(member => member.display_name || member.handle).join(', ')}</p></header>
    {query.isPending && <p role="status">Loading thread…</p>}
    {query.error && <p className="hvt-error" role="alert">{query.error.message} <button onClick={() => void query.refetch()}>Retry</button></p>}
    <ChatHistory events={events} loading={query.isPending} />
    <PendingActions actions={actions} busy={busy} resolve={(action, choice) => void perform(() => client.resolveAction(route, room.room_id, action, choice))} />
    {error && <p role="alert" className="hvt-error">{error}</p>}
    {pending && <p role="status">The last send is unconfirmed. Retry checks the same message; it will not create a second send.</p>}
    {query.data && !query.data.driver_status && <p role="status">The team driver is unavailable. Reconnect its gateway to send messages.</p>}
    <form onSubmit={event => {
      event.preventDefault()
      void perform(async () => { await client.send(route, room.room_id, threadId, draft); setDraft('') })
    }}>
      <label htmlFor={messageInputId}>Message the team</label>
      <textarea id={messageInputId} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy || !!pending} />
      <button type="submit" disabled={busy || !query.data?.driver_status || (!pending && !draft.trim())}>{pending ? 'Retry send' : 'Send'}</button>
    </form>
  </section>
}

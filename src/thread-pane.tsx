import { useQuery, useQueryClient, useValue } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { HermesClient, ownerKey, routeForAgent } from './hermes-client'
import { LIVE_REFRESH_MS, PLUGIN_ID } from './hermes-types'
import type { Agent, Room, Route } from './hermes-types'
import { ThreadPreferences } from './preferences'
import { ThreadList } from './thread-list'
import { TeamChat, roomQueryKey } from './team-chat'
import { pluginStyles } from './styles'

interface Props {
  client: HermesClient
  preferences: ThreadPreferences
  visible: boolean
  openTeam(route: Route, room: Room, threadId: string, title: string): void
}

export function ThreadPane({ client, preferences, visible, openTeam }: Props) {
  const roster = useQuery({
    queryKey: [PLUGIN_ID, 'roster'], enabled: visible, retry: false,
    queryFn: async () => ({ ...(await client.host.agents()), routes: await client.host.profileRoutes() }),
    refetchInterval: visible ? LIVE_REFRESH_MS : false,
  })
  const routes = roster.data?.routes || []
  const teamRoutes = [...new Map(routes.map(route => [JSON.stringify([route.connectionId, route.targetProfile]), route])).values()]
  return <section className="hvt hvt-pane" aria-label="Vertical Threads">
    <style>{pluginStyles}</style>
    <header className="hvt-pane-heading"><strong>Threads</strong><button disabled={roster.isFetching} onClick={() => void roster.refetch()}>Refresh</button></header>
    {roster.error && <p role="alert" className="hvt-error">{roster.error.message}</p>}
    {roster.isPending && <p role="status">Loading bots and teams…</p>}
    {roster.data?.sources.filter(source => source.error).map(source => <p className="hvt-error" key={source.connectionId} role="status">{source.label}: {source.error}</p>)}
    <h2>Bots</h2>
    {roster.data?.agents.map(agent => {
      const route = routes.find(r => r.connectionId === agent.connectionId && r.profile === agent.profile)
      return route ? <BotThreads key={ownerKey('bot', route, route.targetProfile)} client={client} preferences={preferences} agent={agent} route={routeForAgent(agent, routes)} visible={visible} />
        : <p key={`${agent.connectionId}/${agent.profile}`} role="status">{agent.handle}: connection unavailable</p>
    })}
    {roster.data && !roster.data.agents.length && <p>No bots found. Add a profile or connection in Hermes.</p>}
    <h2>Teams</h2>
    {teamRoutes.map(route => <ConnectionTeams key={ownerKey('team', route, 'rooms')} client={client} preferences={preferences} route={route} visible={visible} openTeam={openTeam}
      label={`${roster.data?.sources.find(s => s.connectionId === route.connectionId)?.label || roster.data?.agents.find(a => a.connectionId === route.connectionId)?.connectionLabel || route.connectionId} · ${route.targetProfile}`} />)}
  </section>
}

function BotThreads({ client, preferences, agent, route, visible }: Omit<Props, 'openTeam'> & { agent: Agent; route: Route }) {
  const [expanded, setExpanded] = useState(false)
  const focused = useValue(client.host.state.focusedStoredSessionId)
  const cache = useQueryClient()
  const ownerId = ownerKey('bot', route, route.targetProfile)
  const key = [PLUGIN_ID, 'bot', ownerId]
  const result = useQuery({ queryKey: key, queryFn: () => client.botThreads(route), enabled: visible && expanded, refetchInterval: visible && expanded ? LIVE_REFRESH_MS : false, retry: false })
  const title = agent.profileMetadata?.ui_meta?.['hermes-bots']?.title || agent.profileMetadata?.display_name || agent.profile
  return <article>
    <button className="hvt-owner" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span><strong>{title}</strong><small>{agent.connectionLabel}</small></button>
    {expanded && <>
      {result.isPending && <p role="status">Loading threads…</p>}
      {result.error && <p role="alert" className="hvt-error">{result.error.message} <button onClick={() => void result.refetch()}>Retry</button></p>}
      {result.data && <ThreadList key={ownerId} preferences={preferences} owner={{
        id: ownerId, title, kind: 'bot', threads: result.data.threads,
        activeThreadId: result.data.threads.find(thread => result.data.sessions[thread.id]?.id === focused)?.id,
        openThread: async id => {
          const session = result.data.sessions[id]
          if (!session) throw new Error('This conversation is no longer available. Refresh the list.')
          await client.openBotThread(route, session, preferences.get(ownerId).names[id] || session.title || 'Thread')
        },
        createThread: async () => {
          const session = await client.createBotThread(route)
          preferences.rename(ownerId, session.id, 'New thread')
          await cache.invalidateQueries({ queryKey: key })
          await client.openBotThread(route, session, 'New thread')
        },
      }} />}
      {result.data?.truncated && <p role="status">Showing {result.data.threads.length} of {result.data.total} conversations. This Hermes SDK limits this list to 500. The main Bot Chat stays in Bot Mode.</p>}
    </>}
  </article>
}

function ConnectionTeams({ client, preferences, route, visible, openTeam, label }: Props & { route: Route; label: string }) {
  const rooms = useQuery({ queryKey: [PLUGIN_ID, 'teams', ownerKey('team', route, 'rooms')], queryFn: () => client.teams(route), enabled: visible, refetchInterval: visible ? LIVE_REFRESH_MS : false, retry: false })
  if (rooms.error) return <p className="hvt-error" role="status">{label}: {rooms.error.message} <button onClick={() => void rooms.refetch()}>Retry</button></p>
  if (rooms.isPending) return <p role="status">Loading teams…</p>
  return <>{rooms.data?.map(room => <TeamThreads key={ownerKey('team', route, room.room_id)} client={client} preferences={preferences} route={route} room={room} visible={visible} openTeam={openTeam} label={label} />)}
    {!rooms.data?.length && <p>No gateway-backed teams on this connection. Create one in Hermes Bot Mode.</p>}</>
}

function TeamThreads({ client, preferences, route, room, visible, openTeam, label }: Props & { route: Route; room: Room; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const ownerId = ownerKey('team', route, room.room_id)
  const result = useQuery({ queryKey: roomQueryKey(route, room.room_id), queryFn: () => client.room(route, room.room_id), enabled: visible && expanded, refetchInterval: visible && expanded ? LIVE_REFRESH_MS : false, retry: false })
  void revision
  const threads = client.teamThreads(route, room.room_id, result.data?.events || [])
  const open = (id: string) => {
    const thread = threads.find(t => t.id === id)
    if (!thread) throw new Error('This thread is unavailable. Refresh the team.')
    openTeam(route, room, id, preferences.get(ownerId).names[id] || thread.title)
    setActive(id)
  }
  return <article>
    <button className="hvt-owner" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span><strong>{room.name}</strong><small>{label} · {room.members.length} members</small></button>
    {expanded && <>
      {result.error && <p role="alert" className="hvt-error">{result.error.message} <button onClick={() => void result.refetch()}>Retry</button></p>}
      {result.isPending ? <p role="status">Loading threads…</p> : <ThreadList key={ownerId} preferences={preferences} owner={{
        id: ownerId, title: room.name, kind: 'team', threads, activeThreadId: active,
        openThread: open,
        createThread: () => {
          const thread = client.createTeamThread(route, room.room_id)
          setRevision(value => value + 1)
          openTeam(route, room, thread.id, thread.title)
          setActive(thread.id)
        },
      }} />}
    </>}
  </article>
}

export function openTeamWorkspace(client: HermesClient, panes: Map<string, () => void>, route: Route, room: Room, threadId: string, title: string) {
  client.assertActive()
  const key = `${PLUGIN_ID}:${ownerKey('team', route, room.room_id)}:${threadId}`
  const close = client.host.openWorkspace(key, {
    title: `${room.name} · ${title}`, onClose: () => panes.delete(key),
    render: () => <TeamChat key={key} client={client} route={route} room={room} threadId={threadId} title={title} />,
  })
  panes.set(key, close)
}

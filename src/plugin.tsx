import { host, useValue } from '@hermes/plugin-sdk'
import { HermesClient } from './hermes-client'
import { PLUGIN_ID } from './hermes-types'
import type { PluginContext } from './hermes-types'
import { ThreadPreferences } from './preferences'
import { openTeamWorkspace, ThreadPane } from './thread-pane'

export default {
  id: PLUGIN_ID,
  name: 'Vertical Threads',
  description: 'Organize bot and team conversations vertically, with names, manual order and activity sorting.',
  defaultEnabled: false,
  register(ctx: PluginContext) {
    const client = new HermesClient(host, ctx.storage)
    const preferences = new ThreadPreferences(ctx.storage)
    const panes = new Map<string, () => void>()
    const supported = ['agents', 'profileRoutes', 'requestProfile', 'retainProfile', 'listPersistedSessions', 'openSession', 'openWorkspace', 'paneVisibility'].every(key => typeof host[key as keyof typeof host] === 'function')
    function Pane() {
      const visible = useValue(host.paneVisibility(`${PLUGIN_ID}:pane`))
      return <ThreadPane client={client} preferences={preferences} visible={visible} openTeam={(...args) => openTeamWorkspace(client, panes, ...args)} />
    }
    ctx.register({
      id: 'pane', area: 'panes', title: 'Threads',
      data: { placement: 'left', width: '300px', collapsible: true, hideOnly: true, dock: { pane: 'sessions', pos: 'center' } },
      render: () => supported ? <Pane /> : <p>Update Hermes Desktop to use Vertical Threads. This build is missing a required public SDK capability.</p>,
    })
    ctx.onDispose(() => { client.dispose(); for (const close of [...panes.values()]) close(); panes.clear() })
  },
}

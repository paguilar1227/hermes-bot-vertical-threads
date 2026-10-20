import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// This loads the actual distributable, with the SDK supplied by the fixture host.
// @ts-expect-error The plain ESM distribution deliberately has no bundled SDK types.
import plugin from '../desktop/plugin.js'
import { createStatus, delayNextCreate, disabled, lastOpened, lastSend, releaseCreate, useValue, workspaces } from './sdk-fixture'

const contributions: { id: string; render(): React.ReactNode }[] = []
const cleanup: (() => void)[] = []
plugin.register({
  storage: { get: (key: string, fallback: unknown) => JSON.parse(localStorage.getItem(`plugin.${key}`) ?? 'null') ?? fallback, set: (key: string, value: unknown) => localStorage.setItem(`plugin.${key}`, JSON.stringify(value)) },
  register: (contribution: { id: string; render(): React.ReactNode }) => { contributions.push(contribution); return () => {} },
  onDispose: (dispose: () => void) => cleanup.push(dispose),
})
function Fixture() {
  const panes = useValue(workspaces)
  const opened = useValue(lastOpened)
  const sent = useValue(lastSend)
  const isDisabled = useValue(disabled)
  const pending = useValue(createStatus)
  return <>
    <aside><strong>SDK integration test host · Sample data</strong><output aria-label="Opened session">{opened}</output><output aria-label="Last send">{sent}</output><output aria-label="Pending create">{pending}</output><button onClick={delayNextCreate}>Delay next create</button><button onClick={releaseCreate}>Finish create</button><button onClick={() => { cleanup.forEach(dispose => dispose()); disabled.set(true) }}>Disable plugin</button></aside>
    <main style={{ display: 'flex', height: '85vh' }}>
      {!isDisabled && <div style={{ width: 350, flexShrink: 0 }}>{contributions.map(c => <React.Fragment key={c.id}>{c.render()}</React.Fragment>)}</div>}
      {[...panes].map(([id, pane]) => <div key={id} style={{ flex: 1, minWidth: 0, height: '100%' }}><button onClick={pane.close}>Close {pane.title}</button>{pane.render()}</div>)}
    </main>
  </>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>)

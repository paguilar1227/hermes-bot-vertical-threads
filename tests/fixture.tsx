import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThreadList } from '../src/thread-list'
import { ThreadPreferences } from '../src/preferences'
import type { Thread, ThreadOwner } from '../src/contracts'

const preferences = new ThreadPreferences({
  get: (key, fallback) => JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback,
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
})
function FixtureOwner({ kind, title }: { kind: 'bot' | 'team'; title: string }) {
  const [threads, setThreads] = useState<Thread[]>([
    { id: 'a', title: 'Release plan', activityAt: 100 },
    { id: 'b', title: 'Monday Release', activityAt: 300 },
    { id: 'c', title: 'Checklist', activityAt: 200 },
  ])
  const [active, setActive] = useState('a')
  const owner: ThreadOwner = {
    id: `fixture/${kind}`, kind, title, threads, activeThreadId: active,
    openThread: setActive,
    createThread: () => setThreads(previous => [...previous, { id: String(previous.length), title: 'New thread', activityAt: 400 }]),
  }
  return <article>
    <header className="owner"><span className={`avatar ${kind}`}>{kind === 'bot' ? '▲' : '◆'}</span><strong>{title}</strong></header>
    <ThreadList owner={owner} preferences={preferences} />
    <button className="activity-event" onClick={() => setThreads(current => current.map(t => t.id === 'a' ? { ...t, activityAt: 500 } : t))}>Simulate reply in Release plan</button>
  </article>
}
createRoot(document.getElementById('root')!).render(<main>
  <p className="fixture-label">UI test fixture · Sample data</p>
  <FixtureOwner kind="bot" title="MeTA Release" />
  <FixtureOwner kind="team" title="Release Team" />
</main>)

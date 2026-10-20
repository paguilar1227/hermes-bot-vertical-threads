import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThreadList } from '../src/thread-list'
import { ThreadPreferences, orderedThreads } from '../src/preferences'
import type { Storage, ThreadOwner } from '../src/contracts'

afterEach(cleanup)
function setup(kind: 'bot' | 'team' = 'bot') {
  const saved = new Map<string, unknown>()
  const storage: Storage = { get: (key, fallback) => (saved.get(key) ?? fallback) as typeof fallback, set: (key, value) => { saved.set(key, value) } }
  const preferences = new ThreadPreferences(storage)
  const owner: ThreadOwner = {
    id: `connection/profile/${kind}`, kind, title: 'MeTA Release', activeThreadId: 'a',
    threads: [{ id: 'a', title: 'Release plan', activityAt: 100 }, { id: 'b', title: 'Monday Release', activityAt: 300 }, { id: 'c', title: 'Checklist', activityAt: 200 }],
    openThread: vi.fn(), createThread: vi.fn(),
  }
  const view = render(<ThreadList owner={owner} preferences={preferences} />)
  const titles = () => within(screen.getByRole('list')).getAllByRole('listitem').map(li => li.querySelector('.hvt-name')?.textContent)
  return { owner, preferences, storage, saved, view, titles, user: userEvent.setup() }
}

describe.each(['bot', 'team'] as const)('%s thread behavior', kind => {
  it('opens an existing thread and creates a new thread through the owning host', async () => {
    const { user, owner } = setup(kind)
    await user.click(screen.getByRole('button', { name: 'Monday Release' }))
    expect(owner.openThread).toHaveBeenCalledWith('b')
    await user.click(screen.getByRole('button', { name: '+ New thread' }))
    expect(owner.createThread).toHaveBeenCalledOnce()
  })

  it('persists a trimmed rename only on Enter, across a fresh store instance', async () => {
    const { user, owner, storage, preferences } = setup(kind)
    await user.click(screen.getByRole('button', { name: 'Rename Monday Release' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '  Deployment  ')
    expect(preferences.get(owner.id).names.b).toBeUndefined()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deployment' })).toBeTruthy()
    expect(new ThreadPreferences(storage).get(owner.id).names.b).toBe('Deployment')
    expect(screen.getByRole('button', { name: 'Rename Deployment' })).toBe(document.activeElement)
  })

  it('clicking away closes the dialog and discards the draft', async () => {
    const { user, owner, preferences } = setup(kind)
    await user.click(screen.getByRole('button', { name: 'Rename Monday Release' }))
    await user.type(screen.getByRole('textbox'), 'discarded')
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(preferences.get(owner.id).names.b).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Monday Release' })).toBeTruthy()
  })

  it('Escape cancels, while IME Enter and blank names never save', async () => {
    const { user, owner, preferences } = setup(kind)
    await user.click(screen.getByRole('button', { name: 'Rename Monday Release' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')
    expect(screen.getByRole('alert').textContent).toContain('Enter a thread name')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(preferences.get(owner.id).names.b).toBeUndefined()
  })

  it('dragging reorders persistently, without navigating or contaminating another owner', () => {
    const { owner, preferences, storage, titles } = setup(kind)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move Checklist' }), { dataTransfer })
    fireEvent.dragOver(screen.getByRole('button', { name: 'Release plan' }).closest('li')!, { dataTransfer })
    fireEvent.drop(screen.getByRole('button', { name: 'Release plan' }).closest('li')!, { dataTransfer })
    expect(titles()).toEqual(['Checklist', 'Release plan', 'Monday Release'])
    expect(new ThreadPreferences(storage).get(owner.id).order).toEqual(['c', 'a', 'b'])
    expect(preferences.get('other-connection/profile/bot').order).toEqual([])
    expect(owner.openThread).not.toHaveBeenCalled()
    data.set('application/x-hermes-vertical-thread', JSON.stringify({ ownerId: 'someone-else', threadId: 'b' }))
    fireEvent.drop(screen.getByRole('button', { name: 'Release plan' }).closest('li')!, { dataTransfer })
    expect(titles()).toEqual(['Checklist', 'Release plan', 'Monday Release'])
  })

  it('sorts by live activity and restores manual order when switching back', async () => {
    const { owner, preferences, view, user, titles } = setup(kind)
    const grip = screen.getByRole('button', { name: 'Move Checklist' })
    fireEvent.keyDown(grip, { key: 'ArrowUp', altKey: true })
    expect(titles()).toEqual(['Release plan', 'Checklist', 'Monday Release'])
    await user.selectOptions(screen.getByRole('combobox'), 'activity')
    expect(titles()).toEqual(['Monday Release', 'Checklist', 'Release plan'])
    expect(screen.getByRole('button', { name: 'Move Checklist' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<ThreadList owner={{ ...owner, threads: owner.threads.map(t => t.id === 'a' ? { ...t, activityAt: 400 } : t) }} preferences={preferences} />)
    expect(titles()).toEqual(['Release plan', 'Monday Release', 'Checklist'])
    await user.selectOptions(screen.getByRole('combobox'), 'manual')
    expect(titles()).toEqual(['Release plan', 'Checklist', 'Monday Release'])
  })
})

it('failed persistence keeps the original name and the editable draft', async () => {
  const { user, storage } = setup()
  storage.set = () => { throw new Error('Storage is full') }
  await user.click(screen.getByRole('button', { name: 'Rename Monday Release' }))
  await user.clear(screen.getByRole('textbox'))
  await user.type(screen.getByRole('textbox'), 'Deployment{Enter}')
  expect(screen.getByRole('alert').textContent).toContain('Storage is full')
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Deployment')
  expect(screen.getByRole('button', { name: 'Monday Release' })).toBeTruthy()
})

it('ties preserve manual order and newly discovered threads remain visible', () => {
  const preferences = { order: ['b', 'gone', 'a'], names: {}, sort: 'activity' as const, expanded: true }
  const threads = [{ id: 'a', title: 'A', activityAt: 10 }, { id: 'b', title: 'B', activityAt: 10 }, { id: 'c', title: 'C', activityAt: 10 }]
  expect(orderedThreads(threads, preferences).map(t => t.id)).toEqual(['b', 'a', 'c'])
})

it('incoming activity preserves the rename draft and caret position', async () => {
  const { user, owner, preferences, view } = setup()
  await user.click(screen.getByRole('button', { name: 'Rename Monday Release' }))
  const input = screen.getByRole('textbox') as HTMLInputElement
  await user.clear(input)
  await user.type(input, 'Deploy')
  expect(input.selectionStart).toBe(6)
  view.rerender(<ThreadList owner={{ ...owner, threads: owner.threads.map(t => ({ ...t, activityAt: t.activityAt + 1 })) }} preferences={preferences} />)
  expect(input.selectionStart).toBe(6)
  await user.type(input, 'ment', { skipClick: true })
  await user.keyboard('{Enter}')
  expect(preferences.get(owner.id).names.b).toBe('Deployment')
})

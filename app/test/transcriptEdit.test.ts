import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, SEGMENT_TEXT_MAX, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { hookTranscriptEdit } from '../src/main/transcriptEditIpc'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import type { Llm } from '../src/main/notes/enhance'
import type { NoteView } from '../src/shared/types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

let dir: string, store: Store
beforeEach(() => {
  handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'yogurt-transcript-edit-'))
  store = openStore(join(dir, 'yogurt.db'))
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const meeting = (state: 'done' | 'stopped' | 'recording' = 'done') =>
  store.createMeeting({ title: 'Pricing', startedAt: 1000, endedAt: 2000, eventId: null, app: null, attendees: [], state })
const lines = (meetingId: string) => {
  store.addSegments([
    { meetingId, track: 'them', startMs: 0, endMs: 900, text: 'Ask the human-sharker about it', speaker: 'Priya Nair' },
    { meetingId, track: 'me', startMs: 1000, endMs: 1900, text: 'Sure, by Friday', speaker: null },
  ])
  return store.segments(meetingId)
}
const found = (q: string) => store.search(q, 10).map((h) => h.meetingId)

describe('correcting a transcript line', () => {
  it('saves the edit, keeps what was heard once, and search finds the new word and not the old', () => {
    const m = meeting(), [line] = lines(m.id)
    expect(found('sharker')).toEqual([m.id])
    expect(store.editSegment(m.id, line.id, '  Ask the   human shaker\nabout it ')).toBe('saved')
    expect(store.segments(m.id)[0]).toMatchObject({ text: 'Ask the human shaker about it', originalText: 'Ask the human-sharker about it' })
    expect(found('sharker')).toEqual([])
    expect(found('shaker')).toEqual([m.id])
    // a second edit keeps the first text heard, not the first edit
    expect(store.editSegment(m.id, line.id, 'Ask the human factors team about it')).toBe('saved')
    expect(store.segments(m.id)[0]).toMatchObject({ text: 'Ask the human factors team about it', originalText: 'Ask the human-sharker about it' })
    expect(found('shaker')).toEqual([])
    expect(found('factors')).toEqual([m.id])
    expect(store.segmentHits(m.id, 'factors team')).toEqual([line.id])
    // lines never edited carry no original
    expect(store.segments(m.id)[1].originalText).toBeUndefined()
    // the FTS index is still sound after the updates
    expect(() => store.db.exec("INSERT INTO segments_fts(segments_fts) VALUES ('integrity-check')")).not.toThrow()
  })

  it('an edit back to what was heard, or a restore, clears the original', () => {
    const m = meeting(), [line] = lines(m.id)
    store.editSegment(m.id, line.id, 'Ask the human shaker about it')
    expect(store.editSegment(m.id, line.id, 'Ask the human-sharker about it')).toBe('saved')
    expect(store.segments(m.id)[0].originalText).toBeUndefined()
    store.editSegment(m.id, line.id, 'Ask the human shaker about it')
    expect(store.restoreSegment(m.id, line.id)).toBe('saved')
    expect(store.segments(m.id)[0]).toMatchObject({ text: 'Ask the human-sharker about it' })
    expect(store.segments(m.id)[0].originalText).toBeUndefined()
    expect(found('sharker')).toEqual([m.id])
    expect(found('shaker')).toEqual([])
    expect(store.restoreSegment(m.id, line.id)).toBe('unchanged')
  })

  it('refuses blank, too long, unchanged, other meetings\' and hidden lines, and any edit while recording', () => {
    const m = meeting(), other = meeting(), [line, mine] = lines(m.id)
    expect(store.editSegment(m.id, line.id, '   ')).toBe('invalid')
    expect(store.editSegment(m.id, line.id, 'x'.repeat(SEGMENT_TEXT_MAX + 1))).toBe('invalid')
    expect(store.editSegment(m.id, line.id, 'Ask the human-sharker about it')).toBe('unchanged')
    expect(store.editSegment(other.id, line.id, 'Hijacked')).toBe('missing')
    expect(store.editSegment(m.id, 999_999, 'Nobody')).toBe('missing')
    store.hideSegments([mine.id])
    expect(store.editSegment(m.id, mine.id, 'Sure, by Monday')).toBe('missing')
    store.updateMeeting(m.id, { state: 'recording' })
    expect(store.editSegment(m.id, line.id, 'Ask the human shaker about it')).toBe('recording')
    expect(store.segments(m.id, { hidden: true }).map((s) => s.text)).toEqual(['Ask the human-sharker about it', 'Sure, by Friday'])
  })

  it('marks the meeting for the library to chunk again, even when the length stays the same', () => {
    const m = meeting(), [line] = lines(m.id), lib = new Library(store.db)
    for (const s of lib.stale()) lib.setChunks(s.meetingId, s.signature, [], [])
    expect(lib.stale()).toEqual([])
    store.editSegment(m.id, line.id, 'Ask the human-shaaker about it')
    expect(store.segments(m.id)[0].text.length).toBe('Ask the human-sharker about it'.length)
    expect(lib.stale().map((s) => s.meetingId)).toEqual([m.id])
  })

  it('keeps its columns when the database is opened again', () => {
    const m = meeting(), [line] = lines(m.id)
    store.editSegment(m.id, line.id, 'Ask the human shaker about it')
    store.close()
    store = openStore(join(dir, 'yogurt.db'))
    expect(store.segments(m.id)[0]).toMatchObject({ text: 'Ask the human shaker about it', originalText: 'Ask the human-sharker about it' })
    expect(store.transcriptEditedAt(m.id)).toBeGreaterThan(0)
  })
})

describe('transcript edit IPC', () => {
  const changed = vi.fn()
  let busy = false
  beforeEach(() => { changed.mockReset(); busy = false; hookTranscriptEdit({ store, busy: () => busy, changed }) })

  it('checks what the page sends before it reaches the store', async () => {
    const m = meeting(), [line] = lines(m.id)
    expect(await call('transcript:edit', '../x', line.id, 'Hi')).toBe('invalid')
    expect(await call('transcript:edit', m.id, String(line.id), 'Hi')).toBe('invalid')
    expect(await call('transcript:edit', m.id, 1.5, 'Hi')).toBe('invalid')
    expect(await call('transcript:edit', m.id, -1, 'Hi')).toBe('invalid')
    expect(await call('transcript:edit', m.id, line.id, 42)).toBe('invalid')
    expect(await call('transcript:edit', m.id, line.id, { text: 'Hi' })).toBe('invalid')
    expect(await call('transcript:edit', m.id, line.id, 'x'.repeat(SEGMENT_TEXT_MAX * 3))).toBe('invalid')
    expect(await call('transcript:restore-line', m.id, 'one')).toBe('invalid')
    expect(changed).not.toHaveBeenCalled()
    expect(store.segments(m.id)[0].text).toBe('Ask the human-sharker about it')
  })

  it('saves, trims and tells the windows; restores; refuses a line of another meeting and a recording or resuming one', async () => {
    const m = meeting(), other = meeting(), [line] = lines(m.id)
    expect(await call('transcript:edit', m.id, line.id, '  Ask the human shaker about it  ')).toBe('saved')
    expect(changed).toHaveBeenCalledWith(m.id)
    expect(store.segments(m.id)[0].text).toBe('Ask the human shaker about it')
    expect(await call('transcript:edit', other.id, line.id, 'Hijacked')).toBe('missing')
    busy = true
    expect(await call('transcript:restore-line', m.id, line.id)).toBe('recording')
    busy = false
    changed.mockReset()
    expect(await call('transcript:restore-line', m.id, line.id)).toBe('saved')
    expect(changed).toHaveBeenCalledWith(m.id)
    expect(store.segments(m.id)[0].text).toBe('Ask the human-sharker about it')
    changed.mockReset()
    expect(await call('transcript:edit', m.id, line.id, 'Ask the human-sharker about it')).toBe('unchanged')
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('notes after a correction', () => {
  it('say they were written from the old words until written again, and are never rewritten on their own', async () => {
    const m = meeting('stopped'), [line] = lines(m.id)
    const sent: NoteView[] = [], prompts: string[] = []
    const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async (prompt, onToken) => { prompts.push(prompt); onToken('## Plan\n- Ask'); return '## Plan\n- Ask' } }
    const notes = hookNotes({
      store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm },
      transcribed: () => Promise.resolve(), language: () => 'english', onStop: () => {}, send: (v) => sent.push(v), changed: () => {},
    })
    await notes.writeAgain(m.id)
    expect(store.notes(m.id).enhanced).toBe('## Plan\n- Ask')
    notes.refresh(m.id)
    expect(sent.at(-1)?.transcriptChanged).toBeUndefined()
    await new Promise((r) => setTimeout(r, 20))
    const asked = prompts.length
    store.editSegment(m.id, line.id, 'Ask the human shaker about it')
    notes.refresh(m.id)
    expect(sent.at(-1)).toMatchObject({ status: 'done', transcriptChanged: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(prompts).toHaveLength(asked)
    await notes.writeAgain(m.id)
    expect(prompts.some((p) => p.includes('human shaker'))).toBe(true)
    notes.refresh(m.id)
    expect(sent.at(-1)?.transcriptChanged).toBeUndefined()
  })
})

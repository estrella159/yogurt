import { ipcMain } from 'electron'
import { isId } from './ipcArgs'
import { SEGMENT_TEXT_MAX, type SegmentEdit, type Store } from './store'

/**
 * Lines of a transcript corrected by hand (speech recognition misheard them), and put back as heard. Only a line of
 * that meeting, only text, and never while it records or is resuming (busy): its lines still change then. A change tells
 * the windows (changed), so the transcript reads its lines again, search and the library follow, and the notes can say
 * they were written from the old words.
 */
export function hookTranscriptEdit(d: { store: Pick<Store, 'editSegment' | 'restoreSegment'>; busy?: (meetingId: string) => boolean; changed: (meetingId: string) => void }) {
  const run = (id: unknown, segmentId: unknown, edit: (id: string, segmentId: number) => SegmentEdit): SegmentEdit => {
    if (!isId(id) || !Number.isSafeInteger(segmentId) || Number(segmentId) < 1) return 'invalid'
    if (d.busy?.(id)) return 'recording'
    const result = edit(id, Number(segmentId))
    if (result === 'saved') d.changed(id)
    return result
  }
  ipcMain.handle('transcript:edit', (_e, id: unknown, segmentId: unknown, text: unknown) =>
    // far more than a line can say is not a correction: refused rather than cut
    typeof text !== 'string' || text.length > SEGMENT_TEXT_MAX * 2 ? 'invalid' : run(id, segmentId, (m, s) => d.store.editSegment(m, s, text)))
  ipcMain.handle('transcript:restore-line', (_e, id: unknown, segmentId: unknown) => run(id, segmentId, (m, s) => d.store.restoreSegment(m, s)))
}

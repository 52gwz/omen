import fs from 'node:fs/promises'
import path from 'node:path'

interface Replacement {
  oldString: string
  newString: string
  replaceAll: boolean
}

interface FileChange {
  filePath: string
  originalContent: string | null
  newContent: string | null
  operation: 'write' | 'replace' | 'delete'
  replacements: Replacement[]
  surgicalOk: boolean
}

export class FileChangeTracker {
  private changes = new Map<string, FileChange>()
  private undone = false

  async recordBefore(filePath: string, operation: FileChange['operation']) {
    const existing = this.changes.get(filePath)
    if (existing) {
      if (operation === 'write' || operation === 'delete') {
        existing.surgicalOk = false
      }
      return
    }

    let originalContent: string | null = null
    try {
      originalContent = await fs.readFile(filePath, 'utf-8')
    } catch {
      // file doesn't exist yet
    }
    this.changes.set(filePath, {
      filePath,
      originalContent,
      newContent: null,
      operation,
      replacements: [],
      surgicalOk: operation === 'replace',
    })
  }

  async recordAfter(filePath: string) {
    const change = this.changes.get(filePath)
    if (!change) return
    try {
      change.newContent = await fs.readFile(filePath, 'utf-8')
    } catch {
      change.newContent = null
    }
  }

  addReplacement(filePath: string, oldString: string, newString: string, replaceAll: boolean) {
    const change = this.changes.get(filePath)
    if (change) {
      change.replacements.push({ oldString, newString, replaceAll })
      if (newString === '') change.surgicalOk = false
    }
  }

  async undoAll(): Promise<{ files: string[] }> {
    const files: string[] = []
    for (const [filePath, change] of this.changes) {
      try {
        if (change.surgicalOk && change.replacements.length > 0) {
          let content = await fs.readFile(filePath, 'utf-8')
          for (let i = change.replacements.length - 1; i >= 0; i--) {
            const r = change.replacements[i]
            if (r.replaceAll) {
              content = content.split(r.newString).join(r.oldString)
            } else {
              const idx = content.indexOf(r.newString)
              if (idx !== -1) {
                content = content.slice(0, idx) + r.oldString + content.slice(idx + r.newString.length)
              }
            }
          }
          await fs.writeFile(filePath, content, 'utf-8')
        } else if (change.originalContent === null) {
          await fs.unlink(filePath)
        } else {
          await fs.writeFile(filePath, change.originalContent, 'utf-8')
        }
        files.push(filePath)
      } catch { /* best effort */ }
    }
    this.undone = true
    return { files }
  }

  async reapplyAll(): Promise<{ files: string[] }> {
    const files: string[] = []
    for (const [filePath, change] of this.changes) {
      try {
        if (change.surgicalOk && change.replacements.length > 0) {
          let content = await fs.readFile(filePath, 'utf-8')
          for (const r of change.replacements) {
            if (r.replaceAll) {
              content = content.split(r.oldString).join(r.newString)
            } else {
              const idx = content.indexOf(r.oldString)
              if (idx !== -1) {
                content = content.slice(0, idx) + r.newString + content.slice(idx + r.oldString.length)
              }
            }
          }
          await fs.writeFile(filePath, content, 'utf-8')
        } else if (change.newContent === null) {
          await fs.unlink(filePath)
        } else {
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, change.newContent, 'utf-8')
        }
        files.push(filePath)
      } catch { /* best effort */ }
    }
    this.undone = false
    return { files }
  }

  isUndone() { return this.undone }
  hasChanges() { return this.changes.size > 0 }
  getChangedFiles() { return [...this.changes.keys()] }

  getChangedFilesInfo(): { filePath: string; deleted: boolean }[] {
    return [...this.changes.entries()].map(([filePath, c]) => ({
      filePath,
      deleted: c.newContent === null,
    }))
  }

  getChangedLineRanges(): FileChangedLines[] {
    const result: FileChangedLines[] = []
    for (const [filePath, change] of this.changes) {
      if (change.newContent === null) {
        result.push({ filePath, ranges: [], deletions: [], fileDeleted: true })
        continue
      }
      const diff = computeDiff(change.originalContent, change.newContent)
      result.push({ filePath, ...diff })
    }
    return result
  }
}

export interface LineRange {
  startLine: number
  endLine: number
}

export interface DeletionMarker {
  afterLine: number
  count: number
  lines: string[]
}

export interface FileChangedLines {
  filePath: string
  ranges: LineRange[]
  deletions: DeletionMarker[]
  fileDeleted?: boolean
}

function computeDiff(original: string | null, newContent: string): { ranges: LineRange[]; deletions: DeletionMarker[] } {
  const newLines = newContent.split('\n')

  if (original === null) {
    return {
      ranges: [{ startLine: 1, endLine: newLines.length }],
      deletions: [],
    }
  }

  const origLines = original.split('\n')

  let prefixLen = 0
  while (
    prefixLen < origLines.length &&
    prefixLen < newLines.length &&
    origLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < origLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    origLines[origLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const origChangedCount = origLines.length - prefixLen - suffixLen
  const newChangedCount = newLines.length - prefixLen - suffixLen

  const ranges: LineRange[] = []
  const deletions: DeletionMarker[] = []

  if (newChangedCount > 0) {
    ranges.push({ startLine: prefixLen + 1, endLine: prefixLen + newChangedCount })
  }

  if (origChangedCount > 0) {
    const deletedLines = origLines.slice(prefixLen, prefixLen + origChangedCount)
    deletions.push({ afterLine: prefixLen, count: origChangedCount, lines: deletedLines })
  }

  return { ranges, deletions }
}

const trackers = new Map<string, FileChangeTracker>()

export function getTracker(requestId: string): FileChangeTracker | undefined {
  return trackers.get(requestId)
}

export function createTracker(requestId: string): FileChangeTracker {
  const tracker = new FileChangeTracker()
  trackers.set(requestId, tracker)
  return tracker
}

export function deleteTracker(requestId: string) {
  trackers.delete(requestId)
}

import fs from 'node:fs/promises'
import path from 'node:path'

export interface PatchHunk {
  scopeLines: string[]
  contextBefore: string[]
  removedLines: string[]
  addedLines: string[]
  contextAfter: string[]
}

export interface FilePatch {
  action: 'update' | 'add' | 'delete'
  path: string
  hunks: PatchHunk[]
  content?: string
}

export function parsePatch(patchText: string): FilePatch[] | string {
  const lines = patchText.split('\n')

  // Find Begin/End markers
  let beginIdx = -1
  let endIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '*** Begin Patch') beginIdx = i
    if (lines[i].trim() === '*** End Patch') { endIdx = i; break }
  }
  if (beginIdx === -1) return '缺少 *** Begin Patch 标记'
  if (endIdx === -1) return '缺少 *** End Patch 标记'

  const body = lines.slice(beginIdx + 1, endIdx)
  const patches: FilePatch[] = []
  let i = 0

  while (i < body.length) {
    const line = body[i].trim()

    if (line.startsWith('*** Update File:')) {
      const filePath = line.slice('*** Update File:'.length).trim()
      i++
      const hunks: PatchHunk[] = []
      // Parse hunks until next *** directive or end
      while (i < body.length && !body[i].trim().startsWith('***')) {
        const hunk = parseHunk(body, i)
        hunks.push(hunk.hunk)
        i = hunk.nextIndex
      }
      patches.push({ action: 'update', path: filePath, hunks })
    } else if (line.startsWith('*** Add File:')) {
      const filePath = line.slice('*** Add File:'.length).trim()
      i++
      const contentLines: string[] = []
      while (i < body.length && !body[i].trim().startsWith('***')) {
        contentLines.push(body[i])
        i++
      }
      patches.push({ action: 'add', path: filePath, hunks: [], content: contentLines.join('\n') })
    } else if (line.startsWith('*** Delete File:')) {
      const filePath = line.slice('*** Delete File:'.length).trim()
      i++
      patches.push({ action: 'delete', path: filePath, hunks: [] })
    } else {
      i++
    }
  }

  if (patches.length === 0) return '补丁内容为空，未找到任何文件操作指令'
  return patches
}

function parseHunk(lines: string[], start: number): { hunk: PatchHunk; nextIndex: number } {
  const scopeLines: string[] = []
  const contextBefore: string[] = []
  const removedLines: string[] = []
  const addedLines: string[] = []
  const contextAfter: string[] = []

  let i = start
  // Collect @@ scope lines
  while (i < lines.length && lines[i].trim().startsWith('@@')) {
    scopeLines.push(lines[i].trim())
    i++
  }

  // Phase: before (context before changes), changes (- and +), after (context after changes)
  let phase: 'before' | 'changes' | 'after' = 'before'

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim().startsWith('***') || line.trim().startsWith('@@')) break

    if (line.startsWith('-')) {
      if (phase === 'after') break // new hunk boundary
      phase = 'changes'
      removedLines.push(line.slice(1))
      i++
    } else if (line.startsWith('+')) {
      if (phase === 'after') break
      phase = 'changes'
      addedLines.push(line.slice(1))
      i++
    } else {
      // Context line (no prefix)
      if (phase === 'before') {
        contextBefore.push(line)
      } else if (phase === 'changes') {
        phase = 'after'
        contextAfter.push(line)
      } else {
        // Still in after phase - check if next non-context is +/-, meaning this is actually a new hunk
        const ahead = peekNextNonContext(lines, i + 1)
        if (ahead === 'change') {
          // This context belongs to a new hunk, stop here
          break
        }
        contextAfter.push(line)
      }
      i++
    }
  }

  return { hunk: { scopeLines, contextBefore, removedLines, addedLines, contextAfter }, nextIndex: i }
}

function peekNextNonContext(lines: string[], from: number): 'change' | 'end' {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('***') || line.trim().startsWith('@@')) return 'end'
    if (line.startsWith('-') || line.startsWith('+')) return 'change'
  }
  return 'end'
}

export async function applyPatch(patches: FilePatch[], cwd: string): Promise<string> {
  let updated = 0
  let added = 0
  let deleted = 0

  for (const patch of patches) {
    const resolved = path.isAbsolute(patch.path) ? patch.path : path.resolve(cwd, patch.path)

    if (patch.action === 'delete') {
      await fs.unlink(resolved)
      deleted++
      continue
    }

    if (patch.action === 'add') {
      try {
        await fs.access(resolved)
        throw new Error(`文件已存在，无法新建: ${patch.path}`)
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, patch.content ?? '', 'utf-8')
      added++
      continue
    }

    // action === 'update'
    const content = await fs.readFile(resolved, 'utf-8')
    let fileLines = content.split('\n')

    // Apply hunks from last to first to avoid line offset issues
    const hunks = [...patch.hunks].reverse()
    for (const hunk of hunks) {
      fileLines = applyHunk(fileLines, hunk, patch.path)
    }

    await fs.writeFile(resolved, fileLines.join('\n'), 'utf-8')
    updated++
  }

  const parts: string[] = []
  if (updated) parts.push(`更新 ${updated} 个文件`)
  if (added) parts.push(`新建 ${added} 个文件`)
  if (deleted) parts.push(`删除 ${deleted} 个文件`)
  return `已应用补丁: ${parts.join(', ')}`
}

function applyHunk(fileLines: string[], hunk: PatchHunk, filePath: string): string[] {
  // Build the needle: contextBefore + removedLines + contextAfter
  const needle = [...hunk.contextBefore, ...hunk.removedLines, ...hunk.contextAfter]
  if (needle.length === 0) {
    throw new Error(`[${filePath}] 补丁 hunk 无法定位：上下文和删除行均为空`)
  }

  // Determine search range based on scope lines
  let searchStart = 0
  let searchEnd = fileLines.length
  if (hunk.scopeLines.length > 0) {
    const scopeRange = findScopeRange(fileLines, hunk.scopeLines)
    if (scopeRange) {
      searchStart = scopeRange.start
      searchEnd = scopeRange.end
    }
  }

  // Find needle in file lines
  const matchIdx = findNeedle(fileLines, needle, searchStart, searchEnd)
  if (matchIdx === -1) {
    const preview = needle.slice(0, 3).join('\n')
    throw new Error(`[${filePath}] 无法在文件中找到匹配位置:\n${preview}${needle.length > 3 ? '\n...' : ''}`)
  }

  // Build replacement: contextBefore + addedLines + contextAfter
  const replacement = [...hunk.contextBefore, ...hunk.addedLines, ...hunk.contextAfter]
  const result = [...fileLines]
  result.splice(matchIdx, needle.length, ...replacement)
  return result
}

function findNeedle(fileLines: string[], needle: string[], start: number, end: number): number {
  const needleLen = needle.length
  outer:
  for (let i = start; i <= end - needleLen; i++) {
    for (let j = 0; j < needleLen; j++) {
      if (fileLines[i + j] !== needle[j]) continue outer
    }
    // Check uniqueness - make sure there's no second match
    for (let k = i + 1; k <= end - needleLen; k++) {
      let match = true
      for (let j = 0; j < needleLen; j++) {
        if (fileLines[k + j] !== needle[j]) { match = false; break }
      }
      if (match) return i // Return first match even if not unique (scope narrows it)
    }
    return i
  }
  return -1
}

function findScopeRange(fileLines: string[], scopeLines: string[]): { start: number; end: number } | null {
  // Scope lines look like: @@ ClassName or @@ functionName
  // Find the line that contains the scope identifier and return the range until next same-level scope
  for (const scope of scopeLines) {
    const scopeId = scope.replace(/^@@\s*/, '').trim()
    if (!scopeId) continue

    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].includes(scopeId)) {
        // Find the end of this scope - next occurrence of similar pattern or end of file
        let end = fileLines.length
        for (let j = i + 1; j < fileLines.length; j++) {
          // Simple heuristic: a line at same or lower indentation with a scope-like pattern
          // For now, just use the rest of the file from scope start
          // This is intentionally broad - the needle matching will do the precise work
        }
        return { start: i, end }
      }
    }
  }
  return null
}

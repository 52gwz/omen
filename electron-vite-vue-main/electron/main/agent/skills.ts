import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

export interface SkillMetadata {
  name: string
  description: string
  path: string
  builtin: boolean
  enabled: boolean
}

const MAX_SCAN_DEPTH = 3
const SKILL_FILENAME = 'SKILL.md'

function parseFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return null

  const yaml = match[1]
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const desc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name || !desc) return null
  return { name, description: desc }
}

async function scanSkillsDir(dir: string, depth: number, results: Omit<SkillMetadata, 'builtin' | 'enabled'>[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)

    if (entry.isFile() && entry.name === SKILL_FILENAME) {
      try {
        const content = await fs.readFile(fullPath, 'utf-8')
        const meta = parseFrontmatter(content)
        if (meta?.name && meta?.description) {
          results.push({ name: meta.name, description: meta.description, path: fullPath })
        }
      } catch { /* skip unreadable files */ }
    } else if (entry.isDirectory()) {
      await scanSkillsDir(fullPath, depth + 1, results)
    }
  }
}

function getBuiltinSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'builtin-skills')
  }
  return path.join(app.getAppPath(), 'builtin-skills')
}

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills')
}

async function loadBuiltinSkills(): Promise<Omit<SkillMetadata, 'builtin' | 'enabled'>[]> {
  const dir = getBuiltinSkillsDir()
  const results: Omit<SkillMetadata, 'builtin' | 'enabled'>[] = []
  await scanSkillsDir(dir, 0, results)
  return results
}

async function loadGlobalSkills(): Promise<Omit<SkillMetadata, 'builtin' | 'enabled'>[]> {
  const dir = getGlobalSkillsDir()
  const results: Omit<SkillMetadata, 'builtin' | 'enabled'>[] = []
  await scanSkillsDir(dir, 0, results)
  return results
}

export async function loadSkills(disabledNames: string[] = []): Promise<SkillMetadata[]> {
  const disabledSet = new Set(disabledNames)

  const [builtinRaw, globalRaw] = await Promise.all([
    loadBuiltinSkills(),
    loadGlobalSkills(),
  ])

  const seen = new Set<string>()
  const results: SkillMetadata[] = []

  for (const s of builtinRaw) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    results.push({ ...s, builtin: true, enabled: !disabledSet.has(s.name) })
  }

  for (const s of globalRaw) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    results.push({ ...s, builtin: false, enabled: !disabledSet.has(s.name) })
  }

  return results
}

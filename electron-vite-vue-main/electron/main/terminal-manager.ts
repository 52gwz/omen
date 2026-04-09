import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const pty = require('node-pty') as typeof import('node-pty')

export interface PtySession {
  ptyProcess: import('node-pty').IPty
  ownerId: number
  cwd: string
  history: string
  dataListeners: Array<(chunk: string) => void>
}

const sessions = new Map<string, PtySession>()

function resolveShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

export function resolveTerminalCwd(cwd?: string): string {
  if (!cwd) return os.homedir()
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd
  } catch {}
  return os.homedir()
}

function resolveUtf8Locale(): string {
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_CTYPE,
    process.env.LANG,
  ].filter((v): v is string => Boolean(v && /utf-?8/i.test(v)))
  return candidates[0] || 'en_US.UTF-8'
}

function appendHistory(session: PtySession, chunk: string) {
  session.history += chunk
  if (session.history.length > 200_000) {
    session.history = session.history.slice(-100_000)
  }
}

export function ensureNodePtyHelperExecutable() {
  try {
    const pkgPath = require.resolve('node-pty/package.json')
    const pkgDir = path.dirname(pkgPath)
    const unpackedPkgDir = pkgDir
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked')
    const helperPath = path.join(
      unpackedPkgDir,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    if (fs.existsSync(helperPath)) {
      fs.chmodSync(helperPath, 0o755)
    }
  } catch {}
}

export interface CreateSessionOptions {
  id: string
  cwd?: string
  ownerId: number
  cols?: number
  rows?: number
  onData?: (chunk: string) => void
  onExit?: (exitCode: number) => void
}

export function createSession(opts: CreateSessionOptions): PtySession {
  const resolvedCwd = resolveTerminalCwd(opts.cwd)
  const utf8Locale = resolveUtf8Locale()

  const ptyProcess = pty.spawn(resolveShell(), [], {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols || 80),
    rows: Math.max(5, opts.rows || 24),
    cwd: resolvedCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || utf8Locale,
      LC_ALL: process.env.LC_ALL || utf8Locale,
      LC_CTYPE: process.env.LC_CTYPE || utf8Locale,
    },
  })

  const session: PtySession = {
    ptyProcess,
    ownerId: opts.ownerId,
    cwd: resolvedCwd,
    history: '',
    dataListeners: [],
  }
  sessions.set(opts.id, session)

  if (opts.onData) session.dataListeners.push(opts.onData)

  ptyProcess.onData((chunk: string) => {
    appendHistory(session, chunk)
    for (const listener of session.dataListeners) {
      listener(chunk)
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    sessions.delete(opts.id)
    opts.onExit?.(exitCode)
  })

  return session
}

export function getSession(id: string): PtySession | undefined {
  return sessions.get(id)
}

export function hasSession(id: string): boolean {
  return sessions.has(id)
}

export function getAllSessionIds(): string[] {
  const ids: string[] = []
  sessions.forEach((_, id) => ids.push(id))
  return ids
}

export function getAllSessionInfo(): Array<{ id: string; cwd: string }> {
  const result: Array<{ id: string; cwd: string }> = []
  sessions.forEach((s, id) => {
    result.push({ id, cwd: s.cwd })
  })
  return result
}

export function writeToSession(id: string, data: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.ptyProcess.write(data)
  return true
}

export function readSessionHistory(id: string, lastN?: number): string | null {
  const session = sessions.get(id)
  if (!session) return null
  if (lastN && session.history.length > lastN) {
    return session.history.slice(-lastN)
  }
  return session.history
}

export function resizeSession(id: string, cols: number, rows: number): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.ptyProcess.resize(
    Math.max(20, Math.floor(cols || 80)),
    Math.max(5, Math.floor(rows || 24)),
  )
  return true
}

export function killSession(id: string) {
  const session = sessions.get(id)
  if (!session) return
  try { session.ptyProcess.kill() } catch {}
  sessions.delete(id)
}

export function killAllSessions() {
  const ids: string[] = []
  sessions.forEach((_, id) => ids.push(id))
  ids.forEach(id => killSession(id))
}

export function cleanupSessionsForOwner(ownerId: number) {
  const toKill: string[] = []
  sessions.forEach((session, id) => {
    if (session.ownerId === ownerId) toKill.push(id)
  })
  toKill.forEach(id => killSession(id))
}

export function addDataListener(id: string, listener: (chunk: string) => void): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.dataListeners.push(listener)
  return true
}

export function removeDataListener(id: string, listener: (chunk: string) => void) {
  const session = sessions.get(id)
  if (!session) return
  const idx = session.dataListeners.indexOf(listener)
  if (idx >= 0) session.dataListeners.splice(idx, 1)
}

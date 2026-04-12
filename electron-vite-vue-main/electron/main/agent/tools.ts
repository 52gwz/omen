import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileChangeTracker } from './file-change-tracker'
import {
  createSession as tmCreateSession,
  getSession as tmGetSession,
  hasSession as tmHasSession,
  getAllSessionInfo as tmGetAllSessionInfo,
  writeToSession as tmWriteToSession,
  readSessionHistory as tmReadSessionHistory,
} from '../terminal-manager'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolResultMeta {
  terminalCreated?: { id: string; cwd: string }
}

export interface ToolResult {
  content: string
  meta?: ToolResultMeta
}

export interface SenderLike {
  send(channel: string, data: any): void
  readonly id: number
  isDestroyed(): boolean
}

export interface ToolExecOptions {
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  toolCallId?: string
  changeTracker?: FileChangeTracker
  sender?: SenderLike
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'exec_command',
      description: '在工作目录中执行 shell 命令，返回 stdout 和 stderr。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取指定路径的文件内容，返回带行号的内容（格式：行号|内容）。支持通过 offset 和 limit 分段读取大文件。也支持读取图片（jpeg/png/gif/webp）和 PDF 文件。编辑文件前必须先 Read 一次。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对于工作目录或绝对路径）' },
          offset: { type: 'integer', description: '从第几行开始读取（1-based），可选' },
          limit: { type: 'integer', description: '读取的行数，可选' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '将内容写入指定路径的文件，如果文件已存在会直接覆盖。如果父目录不存在会自动创建。主要用于创建新文件，优先使用 StrReplace 编辑已有文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'StrReplace',
      description: '在文件中精确查找 old_string 并替换为 new_string。old_string 必须在文件中唯一匹配，否则替换失败（需提供更多上下文使其唯一）。设置 replace_all 为 true 可替换所有出现的位置（适合重命名变量等）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的原始文本（必须在文件中唯一）' },
          new_string: { type: 'string', description: '替换后的新文本（必须与 old_string 不同）' },
          replace_all: { type: 'boolean', description: '是否替换所有出现的位置，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Delete',
      description: '删除指定路径的文件。文件不存在或无权限时静默失败。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出指定目录的内容，返回文件和子目录列表。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认为工作目录' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: '使用正则表达式在文件中搜索内容。支持递归搜索目录、按文件类型过滤。返回匹配的文件路径、行号和内容。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索的正则表达式' },
          path: { type: 'string', description: '搜索的文件或目录路径，默认为工作目录' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
          file_glob: { type: 'string', description: '按 glob 过滤文件，如 "*.ts"、"*.{js,vue}"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: '更新任务计划/待办清单。用于记录和跟踪多步骤任务的进度。同一时间最多一个步骤处于 in_progress 状态。在执行复杂的多步骤任务时，应主动使用此工具来规划和跟踪进度。',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string', description: '可选的说明文字，解释当前计划的变更原因' },
          plan: {
            type: 'array',
            description: '计划步骤列表',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string', description: '步骤描述' },
                status: { type: 'string', description: '步骤状态: pending | in_progress | completed' },
              },
              required: ['step', 'status'],
            },
          },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_terminal',
      description: '创建一个新的持久化终端标签页。终端会在用户界面中显示，并保持活跃状态直到被关闭。适用于需要交互式终端环境的场景，如运行开发服务器、持续监控进程等。',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: '终端的工作目录，默认为当前工作目录' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_terminals',
      description: '列出当前所有活跃的终端会话，返回每个终端的 ID 和工作目录。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_in_terminal',
      description: '向指定终端发送命令。命令会自动追加换行符执行，工具立即返回，不等待命令完成。你需要通过 expected_ms 告知命令的预期执行时间，之后调用 read_terminal 获取输出时系统会自动等待至预期时间。如果有其他不依赖此命令结果的任务，可以先并行执行，稍后再 read_terminal。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '目标终端的 ID' },
          command: { type: 'string', description: '要执行的命令' },
          expected_ms: { type: 'integer', description: '命令预期执行时间（毫秒）。快速命令如 ls 设为 1000，编译类命令设为 10000-30000，启动服务设为 5000。read_terminal 会自动等待到这个时间' },
        },
        required: ['id', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal',
      description: '读取指定终端的最近输出。如果该终端有 run_in_terminal 设置的预期完成时间且尚未到达，会自动挂起等待至预期时间再读取，无需手动计时。适合检查命令执行结果、长时间运行进程的状态等。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '目标终端的 ID' },
          last_n: { type: 'integer', description: '读取最后 N 个字符，默认 4000' },
        },
        required: ['id'],
      },
    },
  },
]

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const MAX_OUTPUT_SIZE = MAX_FILE_SIZE * 2

interface OutputLogEntry {
  time: number
  text: string
}

interface RunningProcess {
  child: ChildProcess
  killReason: string
  command: string
  startTime: number
  outputLog: OutputLogEntry[]
}

const runningProcesses = new Map<string, RunningProcess>()

export function killRunningCommand(toolCallId: string): boolean {
  const proc = runningProcesses.get(toolCallId)
  if (!proc) return false
  proc.killReason = 'killed'
  killProcessGroup(proc.child)
  return true
}

export function getCommandLog(toolCallId: string): { command: string; startTime: number; elapsed: number; log: OutputLogEntry[] } | null {
  const proc = runningProcesses.get(toolCallId)
  if (!proc) return null
  return {
    command: proc.command,
    startTime: proc.startTime,
    elapsed: Date.now() - proc.startTime,
    log: proc.outputLog,
  }
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
}

function killProcessGroup(child: ChildProcess) {
  if (!child.pid) return
  const pid = child.pid

  function sendSignal(sig: NodeJS.Signals) {
    try {
      process.kill(-pid, sig)
    } catch {
      try { child.kill(sig) } catch {}
    }
  }

  sendSignal('SIGTERM')

  // SIGTERM 可能被忽略，2s 后用 SIGKILL 强制终止
  setTimeout(() => {
    try {
      process.kill(-pid, 0) // 检查进程是否还活着
      sendSignal('SIGKILL')
    } catch {
      // 进程已退出，无需 SIGKILL
    }
  }, 2000)
}

function buildCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const defaultPathEntries = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : ['/usr/local/bin', '/usr/bin', '/bin']
  const currentPathEntries = (env.PATH || '').split(path.delimiter).filter(Boolean)
  env.PATH = Array.from(new Set([...defaultPathEntries, ...currentPathEntries])).join(path.delimiter)
  return env
}

function resolveShellAndArgs(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'powershell.exe'
    return { shell, args: ['-NoLogo', '-NoProfile', '-Command', command] }
  }
  const shell = process.env.SHELL || '/bin/zsh'
  // interactive + login: packaged app launched from Finder can still load user shell initialization.
  return { shell, args: ['-i', '-l', '-c', command] }
}

async function execCommand(
  command: string,
  cwd: string,
  options?: { signal?: AbortSignal; onOutput?: (chunk: string) => void; toolCallId?: string },
): Promise<string> {
  try {
    const stat = await fs.stat(cwd)
    if (!stat.isDirectory()) {
      return `[error] 工作目录不是有效目录: ${cwd}`
    }
  } catch {
    return `[error] 工作目录不存在: ${cwd}`
  }

  if (options?.signal?.aborted) {
    return '[stopped] 操作已取消'
  }

  const { shell, args } = resolveShellAndArgs(command)
  const env = buildCommandEnv()

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
    })

    const proc: RunningProcess = {
      child,
      killReason: '',
      command,
      startTime: Date.now(),
      outputLog: [],
    }
    if (options?.toolCallId) {
      runningProcesses.set(options.toolCallId, proc)
    }

    let output = ''
    let killed = false

    const append = (text: string) => {
      if (output.length < MAX_OUTPUT_SIZE) {
        output += text
      }
      proc.outputLog.push({ time: Date.now(), text })
      options?.onOutput?.(text)
    }

    child.stdout?.on('data', (chunk: Buffer) => append(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk.toString()))

    // 用户停止对话 → kill 整个进程组
    const onAbort = () => {
      if (killed) return
      killed = true
      proc.killReason = 'stopped'
      killProcessGroup(child)
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort()
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.on('close', (code) => {
      options?.signal?.removeEventListener('abort', onAbort)
      if (options?.toolCallId) runningProcesses.delete(options.toolCallId)

      if (proc.killReason === 'killed') {
        append('\n[stopped] 用户已终止命令')
      } else if (proc.killReason === 'stopped') {
        append('\n[stopped] 用户已停止，命令已终止')
      } else if (code !== 0 && code !== null) {
        append(`\n[exit code: ${code}]`)
      }
      resolve(output || '(无输出)')
    })

    child.on('error', (err) => {
      options?.signal?.removeEventListener('abort', onAbort)
      if (options?.toolCallId) runningProcesses.delete(options.toolCallId)
      resolve(output + `\n[error] ${err.message}`)
    })
  })
}

const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp'])

async function readTool(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  cwd: string,
): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  const stat = await fs.stat(resolved)

  const ext = path.extname(resolved).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (stat.size > MAX_FILE_SIZE * 5) {
      return `[error] 图片过大 (${(stat.size / 1024).toFixed(0)}KB)，最大支持 5MB`
    }
    const buf = await fs.readFile(resolved)
    const base64 = buf.toString('base64')
    const mimeMap: Record<string, string> = {
      '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    }
    return `[image:${mimeMap[ext]}:base64]\n${base64}`
  }

  if (ext === '.pdf') {
    return `[info] PDF 文件，请使用 exec_command 配合相关工具（如 pdftotext）提取文本内容`
  }

  if (stat.size > MAX_FILE_SIZE) {
    return `[error] 文件过大 (${(stat.size / 1024).toFixed(0)}KB)，最大支持 1MB。可使用 offset 和 limit 参数分段读取。`
  }

  const content = await fs.readFile(resolved, 'utf-8')
  const allLines = content.split('\n')

  const startIdx = offset ? Math.max(0, offset - 1) : 0
  const endIdx = limit ? Math.min(allLines.length, startIdx + limit) : allLines.length
  const selectedLines = allLines.slice(startIdx, endIdx)

  const maxLineNumWidth = String(endIdx).length
  const numbered = selectedLines.map((line, i) => {
    const lineNum = String(startIdx + i + 1).padStart(maxLineNumWidth, ' ')
    return `${lineNum}|${line}`
  })

  let result = numbered.join('\n')
  if (startIdx > 0 || endIdx < allLines.length) {
    result = `[显示第 ${startIdx + 1}-${endIdx} 行，共 ${allLines.length} 行]\n${result}`
  }
  return result
}

async function writeTool(
  filePath: string,
  content: string,
  cwd: string,
  tracker?: FileChangeTracker,
): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  if (tracker) await tracker.recordBefore(resolved, 'write')
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, 'utf-8')
  if (tracker) await tracker.recordAfter(resolved)
  return `已写入 ${resolved}`
}

async function strReplaceTool(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean | undefined,
  cwd: string,
  tracker?: FileChangeTracker,
): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  const content = await fs.readFile(resolved, 'utf-8')

  if (oldString === newString) {
    return `[error] old_string 和 new_string 相同，无需替换`
  }

  if (!content.includes(oldString)) {
    return `[error] 在文件中未找到 old_string。请检查内容是否完全匹配（包括空格和缩进）。`
  }

  if (tracker) await tracker.recordBefore(resolved, 'replace')

  if (replaceAll) {
    const newContent = content.split(oldString).join(newString)
    const count = content.split(oldString).length - 1
    await fs.writeFile(resolved, newContent, 'utf-8')
    if (tracker) {
      tracker.addReplacement(resolved, oldString, newString, true)
      await tracker.recordAfter(resolved)
    }
    return `已替换 ${count} 处匹配`
  }

  const firstIdx = content.indexOf(oldString)
  const lastIdx = content.lastIndexOf(oldString)
  if (firstIdx !== lastIdx) {
    const occurrences = content.split(oldString).length - 1
    return `[error] old_string 在文件中出现了 ${occurrences} 次，不唯一。请提供更多上下文使其唯一匹配，或设置 replace_all 为 true 替换全部。`
  }

  const newContent = content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length)
  await fs.writeFile(resolved, newContent, 'utf-8')
  if (tracker) {
    tracker.addReplacement(resolved, oldString, newString, false)
    await tracker.recordAfter(resolved)
  }
  return `已替换 1 处匹配`
}

async function deleteTool(filePath: string, cwd: string, tracker?: FileChangeTracker): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  try {
    if (tracker) await tracker.recordBefore(resolved, 'delete')
    await fs.unlink(resolved)
    if (tracker) await tracker.recordAfter(resolved)
    return `已删除 ${resolved}`
  } catch {
    return `文件不存在或无法删除: ${resolved}`
  }
}

async function listDirectory(dirPath: string | undefined, cwd: string): Promise<string> {
  const resolved = dirPath ? resolvePath(dirPath, cwd) : cwd
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const lines = entries.map((e) => {
    const tag = e.isDirectory() ? '[dir] ' : '      '
    return `${tag}${e.name}`
  })
  return lines.join('\n') || '(空目录)'
}

const MAX_GREP_RESULTS = 200
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.cache', 'coverage', '.turbo', '.vite', 'build'])
const PER_FILE_LIMIT = 500

function matchGlob(filename: string, glob: string): boolean {
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (braceMatch) {
    const [, prefix, alternatives, suffix] = braceMatch
    return alternatives.split(',').some(alt => matchGlob(filename, prefix + alt + suffix))
  }
  const regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexStr}$`).test(filename)
}

function isBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function grepSearch(
  pattern: string,
  searchPath: string | undefined,
  ignoreCase: boolean | undefined,
  fileGlob: string | undefined,
  cwd: string,
): Promise<string> {
  const target = searchPath ? resolvePath(searchPath, cwd) : cwd
  const regex = new RegExp(pattern, ignoreCase ? 'ig' : 'g')
  const results: string[] = []

  async function searchFile(filePath: string) {
    if (results.length >= MAX_GREP_RESULTS) return
    try {
      const buf = await fs.readFile(filePath)
      if (isBinary(buf)) return
      const content = buf.toString('utf-8')
      const lines = content.split('\n')
      let fileMatches = 0
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${path.relative(cwd, filePath)}:${i + 1}:${lines[i]}`)
          fileMatches++
          if (results.length >= MAX_GREP_RESULTS || fileMatches >= PER_FILE_LIMIT) return
        }
        regex.lastIndex = 0
      }
    } catch {
      // skip unreadable files
    }
  }

  async function walkDir(dir: string) {
    if (results.length >= MAX_GREP_RESULTS) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (results.length >= MAX_GREP_RESULTS) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walkDir(fullPath)
      } else if (entry.isFile()) {
        if (fileGlob && !matchGlob(entry.name, fileGlob)) continue
        await searchFile(fullPath)
      }
    }
  }

  const stat = await fs.stat(target)
  if (stat.isFile()) {
    await searchFile(target)
  } else {
    await walkDir(target)
  }

  if (results.length === 0) return '(无匹配结果)'

  let output = results.join('\n')
  if (results.length >= MAX_GREP_RESULTS) {
    output += `\n\n... 结果过多，仅显示前 ${MAX_GREP_RESULTS} 行，请缩小搜索范围`
  }
  return output
}

function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')
}

function processTerminalOutput(raw: string): string {
  return stripAnsiCodes(raw).split('\n').map(line => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    let result = ''
    for (const part of parts) {
      if (!part) continue
      if (part.length >= result.length) {
        result = part
      } else {
        result = part + result.slice(part.length)
      }
    }
    return result
  }).join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const terminalDeadlines = new Map<string, number>()

function text(content: string): ToolResult {
  return { content }
}

function textWithMeta(content: string, meta: ToolResultMeta): ToolResult {
  return { content, meta }
}

function createTerminalTool(
  cwd: string | undefined,
  agentCwd: string,
  sender?: SenderLike,
): ToolResult {
  const resolvedCwd = cwd || agentCwd
  const terminalId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  tmCreateSession({
    id: terminalId,
    cwd: resolvedCwd,
    ownerId: sender?.id ?? 0,
    onData: (chunk) => {
      if (sender && !sender.isDestroyed()) {
        sender.send('terminal:data', { id: terminalId, chunk })
      }
    },
    onExit: (exitCode) => {
      if (sender && !sender.isDestroyed()) {
        sender.send('terminal:exit', { id: terminalId, exitCode })
      }
    },
  })

  const session = tmGetSession(terminalId)
  const finalCwd = session?.cwd || resolvedCwd

  return textWithMeta(
    `终端已创建\nID: ${terminalId}\n工作目录: ${finalCwd}`,
    { terminalCreated: { id: terminalId, cwd: finalCwd } },
  )
}

function listTerminalsTool(): ToolResult {
  const sessions = tmGetAllSessionInfo()
  if (sessions.length === 0) {
    return text('当前没有活跃的终端会话')
  }
  const lines = sessions.map(s => `ID: ${s.id}  工作目录: ${s.cwd}`)
  return text(`活跃终端 (${sessions.length} 个):\n${lines.join('\n')}`)
}

function runInTerminalTool(
  id: string,
  command: string,
  expectedMs?: number,
): ToolResult {
  if (!tmHasSession(id)) {
    return text(`[error] 终端 ${id} 不存在。请先使用 create_terminal 创建终端，或使用 list_terminals 查看活跃终端。`)
  }

  tmWriteToSession(id, command + '\n')

  if (expectedMs && expectedMs > 0) {
    terminalDeadlines.set(id, Date.now() + expectedMs)
  }

  return text(`命令已发送至终端 ${id}。预期 ${expectedMs || 0}ms 后完成，使用 read_terminal 获取输出。`)
}

async function readTerminalTool(
  id: string,
  lastN?: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!tmHasSession(id)) {
    return text(`[error] 终端 ${id} 不存在。请使用 list_terminals 查看活跃终端。`)
  }

  const deadline = terminalDeadlines.get(id)
  if (deadline) {
    const remaining = deadline - Date.now()
    if (remaining > 0) {
      await (signal?.aborted
        ? Promise.resolve()
        : sleep(Math.min(remaining, 120_000)))
    }
    terminalDeadlines.delete(id)
  }

  const history = tmReadSessionHistory(id, lastN || 4000)
  if (!history) {
    return text('(终端暂无输出)')
  }
  const processed = processTerminalOutput(history)
  if (processed.length > MAX_OUTPUT_SIZE) {
    return text(processed.slice(-MAX_OUTPUT_SIZE) + '\n\n... 输出过长，仅显示最后部分')
  }
  return text(processed)
}

export async function executeTool(name: string, args: Record<string, unknown>, cwd: string, options?: ToolExecOptions): Promise<ToolResult> {
  try {
    switch (name) {
      case 'exec_command':
        return text(await execCommand(args.command as string, cwd, {
          signal: options?.signal,
          onOutput: options?.onOutput,
          toolCallId: options?.toolCallId,
        }))
      case 'Read':
        return text(await readTool(args.path as string, args.offset as number | undefined, args.limit as number | undefined, cwd))
      case 'Write':
        return text(await writeTool(args.path as string, args.content as string, cwd, options?.changeTracker))
      case 'StrReplace':
        return text(await strReplaceTool(args.path as string, args.old_string as string, args.new_string as string, args.replace_all as boolean | undefined, cwd, options?.changeTracker))
      case 'Delete':
        return text(await deleteTool(args.path as string, cwd, options?.changeTracker))
      case 'list_directory':
        return text(await listDirectory(args.path as string | undefined, cwd))
      case 'grep_search':
        return text(await grepSearch(
          args.pattern as string,
          args.path as string | undefined,
          args.ignore_case as boolean | undefined,
          args.file_glob as string | undefined,
          cwd,
        ))

      case 'create_terminal':
        return createTerminalTool(args.cwd as string | undefined, cwd, options?.sender)
      case 'list_terminals':
        return listTerminalsTool()
      case 'run_in_terminal':
        return runInTerminalTool(
          args.id as string,
          args.command as string,
          args.expected_ms as number | undefined,
        )
      case 'read_terminal':
        return await readTerminalTool(
          args.id as string,
          args.last_n as number | undefined,
          options?.signal,
        )

      default:
        return text(`[error] 未知工具: ${name}`)
    }
  } catch (err: any) {
    return text(`[error] ${err.message || String(err)}`)
  }
}

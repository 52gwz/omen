import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { browserManager } from './browser'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolResult {
  content: string
  screenshot?: string
}

export interface ToolExecOptions {
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  toolCallId?: string
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
      name: 'read_file',
      description: '读取指定路径的文件内容。路径相对于工作目录或使用绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入指定路径的文件。如果父目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的内容' },
        },
        required: ['path', 'content'],
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
      name: 'edit_file',
      description: '通过精确字符串匹配来局部替换文件内容。old_string 必须与文件中的内容完全一致（包括缩进和空白）。如果 old_string 在文件中不唯一，操作会失败，需要提供更多上下文使其唯一。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要编辑的文件路径' },
          old_string: { type: 'string', description: '要被替换的原始文本，必须与文件内容完全匹配' },
          new_string: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },

  // ---- Browser tools (vision-first) ----
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: '在浏览器中导航到指定 URL。首次调用时会自动启动浏览器。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要导航到的 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截取当前页面截图。这是你观察页面的主要方式。截图坐标系与点击坐标系一致。每次操作后都应截图确认结果。',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: '是否截取整个页面（含滚动区域），默认 false' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面上的位置。优先使用坐标 (x, y) 基于截图定位，也可用 CSS 选择器作为后备。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '点击的 x 坐标（基于截图）' },
          y: { type: 'number', description: '点击的 y 坐标（基于截图）' },
          selector: { type: 'string', description: '备用：CSS 选择器' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '输入文本。通过坐标 (x, y) 点击输入框后输入，也可用 CSS 选择器定位。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本' },
          x: { type: 'number', description: '输入框的 x 坐标（基于截图）' },
          y: { type: 'number', description: '输入框的 y 坐标（基于截图）' },
          selector: { type: 'string', description: '备用：CSS 选择器' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: '辅助工具：获取页面或指定元素的可见文本内容。仅返回屏幕上可见的文本。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，可选。不提供则返回页面可见文本' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '滚动页面。滚动后应截图查看新内容。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
          amount: { type: 'number', description: '滚动距离（像素），默认 500' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '辅助工具：在页面中执行 JavaScript 代码并返回结果。用于获取截图无法提供的数据。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: '要执行的 JavaScript 代码' },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭浏览器。下次使用浏览器工具时会自动重新启动。',
      parameters: {
        type: 'object',
        properties: {},
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

  const shell = process.env.SHELL || '/bin/zsh'

  return new Promise((resolve) => {
    const child = spawn(shell, ['-l', '-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
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

async function readFile(filePath: string, cwd: string): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  const stat = await fs.stat(resolved)
  if (stat.size > MAX_FILE_SIZE) {
    return `[error] 文件过大 (${(stat.size / 1024).toFixed(0)}KB)，最大支持 1MB`
  }
  return await fs.readFile(resolved, 'utf-8')
}

async function writeFile(filePath: string, content: string, cwd: string): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, 'utf-8')
  return `已写入 ${resolved}`
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

async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  cwd: string,
): Promise<string> {
  const resolved = resolvePath(filePath, cwd)
  const content = await fs.readFile(resolved, 'utf-8')

  if (oldString === newString) {
    return '[error] old_string 和 new_string 相同，无需修改'
  }

  const idx = content.indexOf(oldString)
  if (idx === -1) {
    return '[error] 在文件中找不到 old_string，请确保与文件内容完全一致（包括缩进和换行）'
  }

  const lastIdx = content.lastIndexOf(oldString)
  if (idx !== lastIdx) {
    return '[error] old_string 在文件中存在多处匹配，请提供更多上下文使其唯一'
  }

  const updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  await fs.writeFile(resolved, updated, 'utf-8')

  const startLine = content.slice(0, idx).split('\n').length
  const oldLines = oldString.split('\n').length
  const newLines = newString.split('\n').length
  return `已编辑 ${resolved}（第 ${startLine} 行起，${oldLines} 行 → ${newLines} 行）`
}

function text(content: string): ToolResult {
  return { content }
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
      case 'read_file':
        return text(await readFile(args.path as string, cwd))
      case 'write_file':
        return text(await writeFile(args.path as string, args.content as string, cwd))
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
      case 'edit_file':
        return text(await editFile(
          args.path as string,
          args.old_string as string,
          args.new_string as string,
          cwd,
        ))

      // ---- Browser tools ----
      case 'browser_navigate':
        return text(await browserManager.navigate(args.url as string))
      case 'browser_screenshot': {
        const result = await browserManager.screenshot(args.full_page as boolean | undefined)
        return { content: result.text, screenshot: result.base64 }
      }
      case 'browser_click':
        return text(await browserManager.click({
          x: args.x as number | undefined,
          y: args.y as number | undefined,
          selector: args.selector as string | undefined,
        }))
      case 'browser_type':
        return text(await browserManager.type(args.text as string, {
          x: args.x as number | undefined,
          y: args.y as number | undefined,
          selector: args.selector as string | undefined,
        }))
      case 'browser_get_text':
        return text(await browserManager.getText(args.selector as string | undefined))
      case 'browser_scroll':
        return text(await browserManager.scroll(
          args.direction as 'up' | 'down',
          args.amount as number | undefined,
        ))
      case 'browser_evaluate':
        return text(await browserManager.evaluate(args.script as string))
      case 'browser_close':
        return text(await browserManager.close())

      default:
        return text(`[error] 未知工具: ${name}`)
    }
  } catch (err: any) {
    return text(`[error] ${err.message || String(err)}`)
  }
}

import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
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
]

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const EXEC_TIMEOUT = 30_000 // 30s

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
}

async function execCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: EXEC_TIMEOUT, maxBuffer: MAX_FILE_SIZE * 2 }, (error, stdout, stderr) => {
      const parts: string[] = []
      if (stdout) parts.push(stdout)
      if (stderr) parts.push(`[stderr]\n${stderr}`)
      if (error && error.killed) parts.push(`[timeout] 命令执行超过 ${EXEC_TIMEOUT / 1000}s 已终止`)
      else if (error && !stderr) parts.push(`[error] ${error.message}`)
      resolve(parts.join('\n') || '(无输出)')
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

export async function executeTool(name: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  try {
    switch (name) {
      case 'exec_command':
        return await execCommand(args.command as string, cwd)
      case 'read_file':
        return await readFile(args.path as string, cwd)
      case 'write_file':
        return await writeFile(args.path as string, args.content as string, cwd)
      case 'list_directory':
        return await listDirectory(args.path as string | undefined, cwd)
      case 'grep_search':
        return await grepSearch(
          args.pattern as string,
          args.path as string | undefined,
          args.ignore_case as boolean | undefined,
          args.file_glob as string | undefined,
          cwd,
        )
      case 'edit_file':
        return await editFile(
          args.path as string,
          args.old_string as string,
          args.new_string as string,
          cwd,
        )
      default:
        return `[error] 未知工具: ${name}`
    }
  } catch (err: any) {
    return `[error] ${err.message || String(err)}`
  }
}

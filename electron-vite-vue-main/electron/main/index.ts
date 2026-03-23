import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import Store from 'electron-store'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ProjectData {
  id: string
  path: string
  name: string
}

interface ConversationMeta {
  id: string
  projectId?: string
  title: string
  createdAt: number
  cwd?: string
}

interface StoredToolCall {
  id: string
  name: string
  arguments: string
  status: string
  result?: string
}

interface StoredMessage {
  role: string
  content: string
  reasoning?: string
  images?: string[]
  toolCalls?: StoredToolCall[]
}

interface ModelProvider {
  id: string
  name: string
  apiKey: string
  baseURL: string
  models: string[]
}

type StoreSchema = {
  apiKey: string
  baseURL: string
  defaultModel: string
  maxIterations: number
  autoApproveAll: boolean
  providers: ModelProvider[]
  activeProviderId: string
  activeModel: string
  projects: ProjectData[]
  conversations: Record<string, { meta: ConversationMeta; messages: StoredMessage[] }>
  disabledSkills: string[]
  workspaceState: any
}

const store = new Store<StoreSchema>({
  defaults: {
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    maxIterations: 0,
    autoApproveAll: false,
    providers: [],
    activeProviderId: '',
    activeModel: '',
    projects: [],
    conversations: {},
    disabledSkills: [],
    workspaceState: null,
  },
})

// Migrate legacy single config to multi-provider format
;(function migrateConfig() {
  const providers = store.get('providers') || []
  if (providers.length === 0) {
    const apiKey = store.get('apiKey')
    if (apiKey) {
      const defaultModel = store.get('defaultModel') || 'gpt-4o-mini'
      const provider: ModelProvider = {
        id: crypto.randomUUID(),
        name: 'Default',
        apiKey,
        baseURL: store.get('baseURL') || 'https://api.openai.com/v1',
        models: [defaultModel],
      }
      store.set('providers', [provider])
      store.set('activeProviderId', provider.id)
      store.set('activeModel', defaultModel)
    }
  }
})()

function getAiConfig(providerId?: string) {
  const providers = store.get('providers') || []
  const pid = providerId || store.get('activeProviderId')
  const provider = providers.find(p => p.id === pid)

  if (!provider) {
    const apiKey = store.get('apiKey')
    if (!apiKey) throw new Error('请先在设置中配置模型供应商')
    const baseURL = (store.get('baseURL') || 'https://api.openai.com/v1').replace(/\/+$/, '')
    return { apiKey, baseURL }
  }

  if (!provider.apiKey) throw new Error(`供应商 "${provider.name}" 未设置 API Key`)
  return {
    apiKey: provider.apiKey,
    baseURL: (provider.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  }
}

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')


async function createWindow() {
  win = new BrowserWindow({
    title: 'Omen',
    width: 1280,
    height: 760,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      webviewTag: true,
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // win.webContents.on('will-navigate', (event, url) => { }) #344
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  activeWatchers.forEach(w => w.close())
  activeWatchers.clear()
  watchDebounceTimers.forEach(t => clearTimeout(t))
  watchDebounceTimers.clear()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// ---- AI Chat IPC Handlers ----

ipcMain.handle('ai:get-config', () => {
  return {
    providers: store.get('providers') || [],
    activeProviderId: store.get('activeProviderId') || '',
    activeModel: store.get('activeModel') || '',
    maxIterations: store.get('maxIterations') ?? 0,
    autoApproveAll: store.get('autoApproveAll') ?? false,
  }
})

ipcMain.handle('ai:save-config', (_, config: {
  providers: ModelProvider[]
  activeProviderId: string
  activeModel: string
  maxIterations: number
  autoApproveAll: boolean
}) => {
  store.set('providers', config.providers)
  store.set('activeProviderId', config.activeProviderId)
  store.set('activeModel', config.activeModel)
  store.set('maxIterations', config.maxIterations)
  store.set('autoApproveAll', config.autoApproveAll)
})

ipcMain.handle('ai:set-active', (_, data: { providerId: string; model: string }) => {
  store.set('activeProviderId', data.providerId)
  store.set('activeModel', data.model)
})

ipcMain.handle('ai:models', async (_, opts?: { apiKey?: string; baseURL?: string; providerId?: string }) => {
  let apiKey: string, baseURL: string
  if (opts?.apiKey && opts?.baseURL) {
    apiKey = opts.apiKey
    baseURL = opts.baseURL.replace(/\/+$/, '')
  } else {
    const config = getAiConfig(opts?.providerId)
    apiKey = config.apiKey
    baseURL = config.baseURL
  }
  const res = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) return []
  try {
    const json = await res.json() as { data?: { id: string }[] }
    return (json.data || []).map((m) => m.id)
  } catch {
    return []
  }
})

ipcMain.handle('ai:chat', async (_, payload: { model: string; messages: any[]; providerId?: string }) => {
  const { apiKey, baseURL } = getAiConfig(payload.providerId)
  const provider = createOpenAI({ apiKey, baseURL })
  const { text } = await generateText({
    model: provider(payload.model),
    messages: payload.messages as any,
  })
  return text
})

ipcMain.on('ai:chat-stream', async (event, payload: { requestId: string; model: string; messages: any[]; providerId?: string }) => {
  const { requestId, model, messages, providerId } = payload
  const sender = event.sender

  console.log(`\n[Chat ${requestId.slice(0, 8)}] model=${model}`)
  for (const m of messages) {
    const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    console.log(`  [${m.role}] ${contentStr.length > 200 ? contentStr.slice(0, 200) + '...' : contentStr}`)
  }

  const abortController = new AbortController()
  activeAbortControllers.set(requestId, abortController)

  try {
    const { apiKey, baseURL } = getAiConfig(providerId)
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, stream: true, messages }),
      signal: abortController.signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[Chat ${requestId.slice(0, 8)}] API error ${response.status}: ${errText}`)
      sender.send('ai:chat-stream-error', { requestId, message: `API 请求失败 (${response.status}): ${errText}` })
      return
    }

    const reader = (response.body as any).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let chunkCount = 0
    let fullContent = ''
    let fullReasoning = ''

    while (true) {
      if (abortController.signal.aborted) break
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue

        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content
          const reasoning = json.choices?.[0]?.delta?.reasoning_content

          if (reasoning) {
            fullReasoning += reasoning
            sender.send('ai:chat-stream-reasoning', { requestId, delta: reasoning })
            chunkCount++
          }
          if (delta) {
            fullContent += delta
            sender.send('ai:chat-stream-chunk', { requestId, delta })
            chunkCount++
          }
        } catch { /* skip malformed JSON */ }
      }
    }

    if (fullReasoning) {
      console.log(`  [reasoning] ${fullReasoning.length > 300 ? fullReasoning.slice(0, 300) + '...' : fullReasoning}`)
    }
    console.log(`  [assistant] ${fullContent.length > 300 ? fullContent.slice(0, 300) + '...' : fullContent}`)
    console.log(`[Chat ${requestId.slice(0, 8)}] done, ${chunkCount} chunks\n`)

    sender.send('ai:chat-stream-done', { requestId, chunkCount })
  } catch (err: any) {
    if (err.name === 'AbortError') {
      sender.send('ai:chat-stream-done', { requestId, chunkCount: 0, stopped: true })
      return
    }
    console.error(`[Chat ${requestId.slice(0, 8)}] error: ${err.message || err}`)
    sender.send('ai:chat-stream-error', { requestId, message: err.message || String(err) })
  } finally {
    activeAbortControllers.delete(requestId)
  }
})

// ---- Abort tracking ----

const activeAbortControllers = new Map<string, AbortController>()

ipcMain.on('ai:chat-stream-stop', (_, data: { requestId: string }) => {
  const ac = activeAbortControllers.get(data.requestId)
  if (ac) {
    ac.abort()
    activeAbortControllers.delete(data.requestId)
    console.log(`[Chat ${data.requestId.slice(0, 8)}] stopped by user`)
  }
})

ipcMain.on('agent:stop', (_, data: { requestId: string }) => {
  const ac = activeAbortControllers.get(data.requestId)
  if (ac) {
    ac.abort()
    activeAbortControllers.delete(data.requestId)
    console.log(`[Agent ${data.requestId.slice(0, 8)}] stopped by user`)
  }
})

ipcMain.on('agent:kill-command', (_, data: { toolCallId: string }) => {
  const killed = killRunningCommand(data.toolCallId)
  console.log(`[Agent] kill command ${data.toolCallId.slice(0, 8)}: ${killed ? 'ok' : 'not found'}`)
})

ipcMain.handle('agent:undo-changes', async (_, requestId: string) => {
  const tracker = getTracker(requestId)
  if (!tracker) return { error: '未找到变更记录' }
  return await tracker.undoAll()
})

ipcMain.handle('agent:reapply-changes', async (_, requestId: string) => {
  const tracker = getTracker(requestId)
  if (!tracker) return { error: '未找到变更记录' }
  return await tracker.reapplyAll()
})

ipcMain.handle('agent:get-changed-lines', (_, requestId: string) => {
  const tracker = getTracker(requestId)
  if (!tracker) return []
  return tracker.getChangedLineRanges()
})

// ---- Agent IPC Handlers ----

import { runAgentLoop } from './agent/loop'
import { killRunningCommand } from './agent/tools'
import { loadSkills } from './agent/skills'
import { buildSystemPrompt, buildUserInfoBlock, buildSkillsBlock, buildOpenTabsBlock } from './agent/system-prompt'
import { getTracker } from './agent/file-change-tracker'

ipcMain.on('agent:start', async (event, payload: {
  requestId: string
  model: string
  messages: any[]
  cwd: string
  providerId?: string
  tabContext?: string
}) => {
  const { requestId, model, messages } = payload
  const sender = event.sender
  const cwd = (!payload.cwd || payload.cwd === '~')
    ? os.homedir()
    : payload.cwd.startsWith('~/')
      ? path.join(os.homedir(), payload.cwd.slice(2))
      : payload.cwd

  console.log(`\n[Agent ${requestId.slice(0, 8)}] model=${model} cwd=${cwd}`)

  const abortController = new AbortController()
  activeAbortControllers.set(requestId, abortController)

  try {
    const { apiKey, baseURL } = getAiConfig(payload.providerId)
    const maxIterations = store.get('maxIterations') ?? 0
    const autoApproveAll = store.get('autoApproveAll') ?? false
    const disabledSkills = store.get('disabledSkills') || []

    await runAgentLoop({ requestId, model, messages, apiKey, baseURL, cwd, sender, maxIterations, autoApproveAll, signal: abortController.signal, disabledSkills, tabContext: payload.tabContext })
  } catch (err: any) {
    if (err.name === 'AbortError') {
      sender.send('agent:done', { requestId, stopped: true })
      return
    }
    console.error(`[Agent ${requestId.slice(0, 8)}] error: ${err.message || err}`)
    sender.send('agent:error', { requestId, message: err.message || String(err) })
    sender.send('agent:done', { requestId })
  } finally {
    activeAbortControllers.delete(requestId)
  }
})

ipcMain.handle('dialog:select-directory', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:select-files', async (_, defaultPath?: string) => {
  if (!win) return []
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
  }
  if (defaultPath) opts.defaultPath = defaultPath
  const result = await dialog.showOpenDialog(win, opts)
  if (result.canceled || !result.filePaths.length) return []
  return result.filePaths
})

ipcMain.handle('dialog:select-images', async () => {
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  })
  if (result.canceled || !result.filePaths.length) return []
  const images: string[] = []
  for (const filePath of result.filePaths) {
    try {
      const ext = path.extname(filePath).toLowerCase().replace('.', '')
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const data = fs.readFileSync(filePath)
      images.push(`data:${mime};base64,${data.toString('base64')}`)
    } catch { /* skip unreadable files */ }
  }
  return images
})

// ---- Project & Conversation IPC Handlers ----

ipcMain.handle('project:list', () => {
  return store.get('projects') || []
})

ipcMain.handle('project:add', (_, folderPath: string): ProjectData | null => {
  try {
    const stat = fs.statSync(folderPath)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }
  const projects = store.get('projects') || []
  if (projects.some((p) => p.path === folderPath)) {
    return projects.find((p) => p.path === folderPath)!
  }
  const project: ProjectData = {
    id: crypto.randomUUID(),
    path: folderPath,
    name: path.basename(folderPath),
  }
  projects.push(project)
  store.set('projects', projects)
  return project
})

ipcMain.handle('project:rename', (_, projectId: string, newName: string) => {
  const projects = store.get('projects') || []
  const project = projects.find((p) => p.id === projectId)
  if (!project) return
  project.name = newName
  store.set('projects', projects)
})

ipcMain.handle('project:remove', (_, projectId: string) => {
  const projects = (store.get('projects') || []).filter((p) => p.id !== projectId)
  store.set('projects', projects)
  const conversations = store.get('conversations') || {}
  for (const [convId, conv] of Object.entries(conversations)) {
    if (conv.meta.projectId === projectId) delete conversations[convId]
  }
  store.set('conversations', conversations)
})

ipcMain.handle('project:check-path', (_, folderPath: string): boolean => {
  try {
    return fs.statSync(folderPath).isDirectory()
  } catch {
    return false
  }
})


ipcMain.handle('conversation:list', (_, projectId?: string | null): ConversationMeta[] => {
  const conversations = store.get('conversations') || {}
  return Object.values(conversations)
    .map((c) => c.meta)
    .filter((meta) => {
      if (projectId) return meta.projectId === projectId
      return !meta.projectId
    })
    .sort((a, b) => b.createdAt - a.createdAt)
})

ipcMain.handle('conversation:create', (_, title: string, projectId?: string): ConversationMeta => {
  const projects = store.get('projects') || []
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  const meta: ConversationMeta = {
    id: crypto.randomUUID(),
    title: title || '新对话',
    createdAt: Date.now(),
    projectId,
    cwd: project?.path,
  }
  const conversations = store.get('conversations') || {}
  conversations[meta.id] = { meta, messages: [] }
  store.set('conversations', conversations)
  return meta
})

ipcMain.handle('conversation:set-cwd', (_, convId: string, cwd: string) => {
  const conversations = store.get('conversations') || {}
  if (conversations[convId]) {
    conversations[convId].meta.cwd = cwd
    store.set('conversations', conversations)
  }
})

ipcMain.handle('conversation:get-cwd', (_, convId: string): string => {
  const conversations = store.get('conversations') || {}
  return conversations[convId]?.meta.cwd || ''
})

ipcMain.handle('conversation:delete', (_, convId: string) => {
  const conversations = store.get('conversations') || {}
  delete conversations[convId]
  store.set('conversations', conversations)
})

ipcMain.handle('conversation:rename', (_, convId: string, title: string) => {
  const conversations = store.get('conversations') || {}
  if (conversations[convId]) {
    conversations[convId].meta.title = title
    store.set('conversations', conversations)
  }
})

ipcMain.handle('conversation:get-messages', (_, convId: string): StoredMessage[] => {
  const conversations = store.get('conversations') || {}
  return conversations[convId]?.messages || []
})

ipcMain.handle('conversation:save-messages', (_, convId: string, messages: StoredMessage[]) => {
  const conversations = store.get('conversations') || {}
  if (conversations[convId]) {
    conversations[convId].messages = messages
    store.set('conversations', conversations)
  }
})

ipcMain.handle('workspace:save', (_, state: any) => {
  store.set('workspaceState', state)
})

ipcMain.handle('workspace:load', () => {
  return store.get('workspaceState') || null
})

ipcMain.handle('agent:get-system-prompt', async (_, payload: { cwd: string; tabContext?: string }) => {
  const disabledSkills: string[] = store.get('disabledSkills') || []
  const skills = await loadSkills(disabledSkills)
  const enabledSkills = skills.filter((s: any) => s.enabled)
  const cwd = (!payload.cwd || payload.cwd === '~')
    ? os.homedir()
    : payload.cwd.startsWith('~/')
      ? path.join(os.homedir(), payload.cwd.slice(2))
      : payload.cwd

  let preview = buildSystemPrompt(cwd)
  preview += '\n\n--- 第一条用户消息将包含 ---\n\n'
  preview += buildUserInfoBlock(cwd)
  const skillsBlock = buildSkillsBlock(enabledSkills)
  if (skillsBlock) preview += '\n' + skillsBlock
  if (payload.tabContext) preview += '\n' + buildOpenTabsBlock(payload.tabContext)

  return preview
})

// ---- Skills IPC Handlers ----

ipcMain.handle('skills:list', async () => {
  const disabledSkills = store.get('disabledSkills') || []
  return loadSkills(disabledSkills)
})

ipcMain.handle('skills:import', async (): Promise<{ success: boolean; error?: string }> => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择技能文件夹',
    properties: ['openDirectory'],
  })
  if (canceled || !filePaths.length) return { success: false, error: '已取消' }

  const srcDir = filePaths[0]
  const skillFile = path.join(srcDir, 'SKILL.md')

  if (!fs.existsSync(skillFile)) {
    return { success: false, error: '所选文件夹中不存在 SKILL.md 文件' }
  }

  try {
    const content = fs.readFileSync(skillFile, 'utf-8')
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch) return { success: false, error: 'SKILL.md 缺少有效的 frontmatter' }
    const yaml = fmMatch[1]
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const desc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    if (!name || !desc) return { success: false, error: 'SKILL.md frontmatter 需要 name 和 description 字段' }
  } catch {
    return { success: false, error: '无法读取 SKILL.md' }
  }

  const globalSkillsDir = path.join(os.homedir(), '.agents', 'skills')
  const folderName = path.basename(srcDir)
  const destDir = path.join(globalSkillsDir, folderName)

  try {
    fs.mkdirSync(globalSkillsDir, { recursive: true })
    fs.cpSync(srcDir, destDir, { recursive: true })
  } catch (e: any) {
    return { success: false, error: `复制失败: ${e.message}` }
  }

  return { success: true }
})

ipcMain.handle('skills:toggle', (_, name: string) => {
  const disabledSkills: string[] = store.get('disabledSkills') || []
  const idx = disabledSkills.indexOf(name)
  if (idx >= 0) {
    disabledSkills.splice(idx, 1)
  } else {
    disabledSkills.push(name)
  }
  store.set('disabledSkills', disabledSkills)
})

// ---- Filesystem IPC Handlers ----

ipcMain.handle('fs:show-in-folder', (_, fullPath: string) => {
  shell.showItemInFolder(fullPath)
})

ipcMain.handle('fs:read-dir', (_, dirPath: string): { name: string; path: string; isDirectory: boolean }[] => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
})

ipcMain.handle('fs:read-file', async (_, filePath: string): Promise<{ content: string; error?: string }> => {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 5 * 1024 * 1024) {
      return { content: '', error: '文件过大（超过 5MB）' }
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    return { content }
  } catch (e: any) {
    return { content: '', error: e.message }
  }
})

ipcMain.handle('fs:delete-path', async (_, targetPath: string): Promise<{ error?: string }> => {
  try {
    await shell.trashItem(targetPath)
    return {}
  } catch (e: any) {
    return { error: e.message }
  }
})

ipcMain.handle('fs:write-file', async (_, filePath: string, content: string): Promise<{ error?: string }> => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return {}
  } catch (e: any) {
    return { error: e.message }
  }
})

ipcMain.handle('fs:create-file', async (_, filePath: string): Promise<{ error?: string }> => {
  try {
    if (fs.existsSync(filePath)) return { error: '文件已存在' }
    fs.writeFileSync(filePath, '', 'utf-8')
    return {}
  } catch (e: any) {
    return { error: e.message }
  }
})

ipcMain.handle('fs:create-dir', async (_, dirPath: string): Promise<{ error?: string }> => {
  try {
    if (fs.existsSync(dirPath)) return { error: '文件夹已存在' }
    fs.mkdirSync(dirPath, { recursive: true })
    return {}
  } catch (e: any) {
    return { error: e.message }
  }
})

ipcMain.handle('fs:rename-path', async (_, srcPath: string, newName: string): Promise<{ newPath: string; error?: string }> => {
  try {
    const dir = path.dirname(srcPath)
    const dest = path.join(dir, newName)
    if (srcPath === dest) return { newPath: dest }
    if (fs.existsSync(dest)) return { newPath: '', error: `已存在: ${newName}` }
    fs.renameSync(srcPath, dest)
    return { newPath: dest }
  } catch (e: any) {
    return { newPath: '', error: e.message }
  }
})

ipcMain.handle('fs:move-path', async (_, srcPath: string, destDir: string): Promise<{ newPath: string; error?: string }> => {
  try {
    const name = path.basename(srcPath)
    const dest = path.join(destDir, name)
    if (srcPath === dest) return { newPath: dest }
    if (fs.existsSync(dest)) return { newPath: '', error: `目标已存在: ${name}` }
    fs.renameSync(srcPath, dest)
    return { newPath: dest }
  } catch (e: any) {
    return { newPath: '', error: e.message }
  }
})

// ---- File Watcher ----

const activeWatchers = new Map<string, fs.FSWatcher>()
const watchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

ipcMain.handle('fs:watch-dir', (_event, dirPath: string) => {
  if (activeWatchers.has(dirPath)) {
    activeWatchers.get(dirPath)!.close()
  }
  try {
    const watcher = fs.watch(dirPath, { recursive: true }, () => {
      if (watchDebounceTimers.has(dirPath)) {
        clearTimeout(watchDebounceTimers.get(dirPath)!)
      }
      watchDebounceTimers.set(dirPath, setTimeout(() => {
        watchDebounceTimers.delete(dirPath)
        if (win && !win.isDestroyed()) {
          win.webContents.send('fs:dir-changed', { dirPath })
        }
      }, 300))
    })
    activeWatchers.set(dirPath, watcher)
    watcher.on('error', () => {
      activeWatchers.delete(dirPath)
    })
  } catch { /* directory may not exist */ }
})

ipcMain.handle('fs:unwatch-dir', (_event, dirPath: string) => {
  const watcher = activeWatchers.get(dirPath)
  if (watcher) {
    watcher.close()
    activeWatchers.delete(dirPath)
  }
  const timer = watchDebounceTimers.get(dirPath)
  if (timer) {
    clearTimeout(timer)
    watchDebounceTimers.delete(dirPath)
  }
})

// ---- Single-file watch (editor auto-reload) ----

const fileWatchEntries = new Map<string, { count: number; watcher: fs.FSWatcher }>()
const fileWatchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resolveFileWatchKey(filePath: string): string {
  try {
    return path.resolve(filePath)
  } catch {
    return filePath
  }
}

ipcMain.handle('fs:watch-file', (_event, filePath: string): { resolvedPath: string } | { error: string } => {
  const key = resolveFileWatchKey(filePath)
  const existing = fileWatchEntries.get(key)
  if (existing) {
    existing.count += 1
    return { resolvedPath: key }
  }
  try {
    const watcher = fs.watch(key, (event) => {
      if (event !== 'change' && event !== 'rename') return
      const prev = fileWatchDebounceTimers.get(key)
      if (prev) clearTimeout(prev)
      fileWatchDebounceTimers.set(key, setTimeout(() => {
        fileWatchDebounceTimers.delete(key)
        if (win && !win.isDestroyed()) {
          win.webContents.send('fs:file-changed', { filePath: key })
        }
      }, 300))
    })
    watcher.on('error', () => {
      const entry = fileWatchEntries.get(key)
      if (entry) {
        entry.watcher.close()
        fileWatchEntries.delete(key)
      }
      const t = fileWatchDebounceTimers.get(key)
      if (t) {
        clearTimeout(t)
        fileWatchDebounceTimers.delete(key)
      }
    })
    fileWatchEntries.set(key, { count: 1, watcher })
    return { resolvedPath: key }
  } catch (e: any) {
    return { error: e?.message || 'watch failed' }
  }
})

ipcMain.handle('fs:unwatch-file', (_event, filePath: string) => {
  const key = resolveFileWatchKey(filePath)
  const entry = fileWatchEntries.get(key)
  if (!entry) return
  entry.count -= 1
  if (entry.count <= 0) {
    entry.watcher.close()
    fileWatchEntries.delete(key)
    const t = fileWatchDebounceTimers.get(key)
    if (t) {
      clearTimeout(t)
      fileWatchDebounceTimers.delete(key)
    }
  }
})

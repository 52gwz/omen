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
  screenshot?: string
}

interface StoredMessage {
  role: string
  content: string
  reasoning?: string
  toolCalls?: StoredToolCall[]
}

type StoreSchema = {
  apiKey: string
  baseURL: string
  defaultModel: string
  maxIterations: number
  projects: ProjectData[]
  conversations: Record<string, { meta: ConversationMeta; messages: StoredMessage[] }>
}

const store = new Store<StoreSchema>({
  defaults: {
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    maxIterations: 20,
    projects: [],
    conversations: {},
  },
})

function getAiConfig() {
  const apiKey = store.get('apiKey')
  if (!apiKey) throw new Error('请先在设置中填写 API Key')

  const baseURL = (store.get('baseURL') || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const defaultModel = store.get('defaultModel') || 'gpt-4o-mini'
  return { apiKey, baseURL, defaultModel }
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
    title: 'Main window',
    width: 1280,
    height: 760,
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
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
  if (browserManager.isActive()) {
    await browserManager.close().catch(() => {})
  }
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
    apiKey: store.get('apiKey'),
    baseURL: store.get('baseURL'),
    defaultModel: store.get('defaultModel'),
    maxIterations: store.get('maxIterations'),
  }
})

ipcMain.handle('ai:save-config', (_, config: { apiKey: string; baseURL: string; defaultModel: string; maxIterations: number }) => {
  store.set('apiKey', config.apiKey)
  store.set('baseURL', config.baseURL)
  store.set('defaultModel', config.defaultModel)
  store.set('maxIterations', config.maxIterations)
})

ipcMain.handle('ai:models', async () => {
  const { apiKey, baseURL } = getAiConfig()
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

ipcMain.handle('ai:chat', async (_, payload: { model: string; messages: { role: string; content: string }[] }) => {
  const { apiKey, baseURL } = getAiConfig()
  const provider = createOpenAI({ apiKey, baseURL })
  const { text } = await generateText({
    model: provider(payload.model),
    messages: payload.messages as any,
  })
  return text
})

ipcMain.on('ai:chat-stream', async (event, payload: { requestId: string; model: string; messages: { role: string; content: string }[] }) => {
  const { requestId, model, messages } = payload
  const sender = event.sender

  console.log(`\n[Chat ${requestId.slice(0, 8)}] model=${model}`)
  for (const m of messages) {
    console.log(`  [${m.role}] ${m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content}`)
  }

  const abortController = new AbortController()
  activeAbortControllers.set(requestId, abortController)

  try {
    const { apiKey, baseURL } = getAiConfig()
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

// ---- Agent IPC Handlers ----

import { runAgentLoop } from './agent/loop'
import { killRunningCommand } from './agent/tools'
import { browserManager } from './agent/browser'

ipcMain.on('agent:start', async (event, payload: {
  requestId: string
  model: string
  messages: { role: string; content: string }[]
  cwd: string
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
    const { apiKey, baseURL } = getAiConfig()
    const maxIterations = store.get('maxIterations') || 20
    await runAgentLoop({ requestId, model, messages, apiKey, baseURL, cwd, sender, maxIterations, signal: abortController.signal })
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

ipcMain.handle('conversation:list', (): ConversationMeta[] => {
  const conversations = store.get('conversations') || {}
  return Object.values(conversations)
    .map((c) => c.meta)
    .sort((a, b) => b.createdAt - a.createdAt)
})

ipcMain.handle('conversation:create', (_, title: string): ConversationMeta => {
  const meta: ConversationMeta = {
    id: crypto.randomUUID(),
    title: title || '新对话',
    createdAt: Date.now(),
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

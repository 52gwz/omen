import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

// --------- AI Chat API ---------
contextBridge.exposeInMainWorld('aiChat', {
  getConfig() {
    return ipcRenderer.invoke('ai:get-config')
  },
  saveConfig(config: { apiKey: string; baseURL: string; defaultModel: string }) {
    return ipcRenderer.invoke('ai:save-config', config)
  },
  getModels(): Promise<string[]> {
    return ipcRenderer.invoke('ai:models')
  },
  sendMessage(payload: { model: string; messages: { role: string; content: string }[] }): Promise<string> {
    return ipcRenderer.invoke('ai:chat', payload)
  },
  startStream(payload: { requestId: string; model: string; messages: { role: string; content: string }[] }) {
    ipcRenderer.send('ai:chat-stream', payload)
  },
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void) {
    const handler = (_: any, data: { requestId: string; delta: string }) => callback(data)
    ipcRenderer.on('ai:chat-stream-reasoning', handler)
    return () => { ipcRenderer.off('ai:chat-stream-reasoning', handler) }
  },
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void) {
    const handler = (_: any, data: { requestId: string; delta: string }) => callback(data)
    ipcRenderer.on('ai:chat-stream-chunk', handler)
    return () => { ipcRenderer.off('ai:chat-stream-chunk', handler) }
  },
  onStreamDone(callback: (data: { requestId: string; chunkCount: number }) => void) {
    const handler = (_: any, data: { requestId: string; chunkCount: number }) => callback(data)
    ipcRenderer.on('ai:chat-stream-done', handler)
    return () => { ipcRenderer.off('ai:chat-stream-done', handler) }
  },
  onStreamError(callback: (data: { requestId: string; message: string }) => void) {
    const handler = (_: any, data: { requestId: string; message: string }) => callback(data)
    ipcRenderer.on('ai:chat-stream-error', handler)
    return () => { ipcRenderer.off('ai:chat-stream-error', handler) }
  },
})

// --------- Agent API ---------
contextBridge.exposeInMainWorld('agentChat', {
  start(payload: { requestId: string; model: string; messages: { role: string; content: string }[]; cwd: string }) {
    ipcRenderer.send('agent:start', payload)
  },
  confirmTool(requestId: string, toolCallId: string) {
    ipcRenderer.send('agent:tool-confirm', { requestId, toolCallId })
  },
  rejectTool(requestId: string, toolCallId: string) {
    ipcRenderer.send('agent:tool-reject', { requestId, toolCallId })
  },
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:stream-chunk', handler)
    return () => { ipcRenderer.off('agent:stream-chunk', handler) }
  },
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:stream-reasoning', handler)
    return () => { ipcRenderer.off('agent:stream-reasoning', handler) }
  },
  onToolPending(callback: (data: { requestId: string; toolCallId: string; name: string; arguments: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:tool-pending', handler)
    return () => { ipcRenderer.off('agent:tool-pending', handler) }
  },
  onToolRunning(callback: (data: { requestId: string; toolCallId: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:tool-running', handler)
    return () => { ipcRenderer.off('agent:tool-running', handler) }
  },
  onToolResult(callback: (data: { requestId: string; toolCallId: string; result: string; rejected: boolean }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:tool-result', handler)
    return () => { ipcRenderer.off('agent:tool-result', handler) }
  },
  onNewTurn(callback: (data: { requestId: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:new-turn', handler)
    return () => { ipcRenderer.off('agent:new-turn', handler) }
  },
  onDone(callback: (data: { requestId: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:done', handler)
    return () => { ipcRenderer.off('agent:done', handler) }
  },
  onError(callback: (data: { requestId: string; message: string }) => void) {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('agent:error', handler)
    return () => { ipcRenderer.off('agent:error', handler) }
  },
})

// --------- Dialog API ---------
contextBridge.exposeInMainWorld('dialogApi', {
  selectDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:select-directory')
  },
})

// --------- Project & Conversation API ---------
contextBridge.exposeInMainWorld('projectApi', {
  list(): Promise<{ id: string; path: string; name: string }[]> {
    return ipcRenderer.invoke('project:list')
  },
  add(folderPath: string): Promise<{ id: string; path: string; name: string } | null> {
    return ipcRenderer.invoke('project:add', folderPath)
  },
  remove(projectId: string): Promise<void> {
    return ipcRenderer.invoke('project:remove', projectId)
  },
  checkPath(folderPath: string): Promise<boolean> {
    return ipcRenderer.invoke('project:check-path', folderPath)
  },
})

contextBridge.exposeInMainWorld('conversationApi', {
  list(projectId: string): Promise<{ id: string; projectId: string; title: string; createdAt: number }[]> {
    return ipcRenderer.invoke('conversation:list', projectId)
  },
  create(projectId: string, title: string): Promise<{ id: string; projectId: string; title: string; createdAt: number }> {
    return ipcRenderer.invoke('conversation:create', projectId, title)
  },
  delete(convId: string): Promise<void> {
    return ipcRenderer.invoke('conversation:delete', convId)
  },
  rename(convId: string, title: string): Promise<void> {
    return ipcRenderer.invoke('conversation:rename', convId, title)
  },
  getMessages(convId: string): Promise<{ role: string; content: string }[]> {
    return ipcRenderer.invoke('conversation:get-messages', convId)
  },
  saveMessages(convId: string, messages: { role: string; content: string }[]): Promise<void> {
    return ipcRenderer.invoke('conversation:save-messages', convId, messages)
  },
})

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise((resolve) => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)

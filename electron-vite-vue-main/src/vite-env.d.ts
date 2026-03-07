/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface AiChatConfig {
  apiKey: string
  baseURL: string
  defaultModel: string
  maxIterations: number
}

interface AiChatApi {
  getConfig(): Promise<AiChatConfig>
  saveConfig(config: AiChatConfig): Promise<void>
  getModels(): Promise<string[]>
  sendMessage(payload: { model: string; messages: { role: string; content: string }[] }): Promise<string>
  startStream(payload: { requestId: string; model: string; messages: { role: string; content: string }[] }): void
  stopStream(requestId: string): void
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamDone(callback: (data: { requestId: string; chunkCount: number }) => void): () => void
  onStreamError(callback: (data: { requestId: string; message: string }) => void): () => void
}

interface AgentChatApi {
  start(payload: { requestId: string; model: string; messages: { role: string; content: string }[]; cwd: string }): void
  stop(requestId: string): void
  confirmTool(requestId: string, toolCallId: string): void
  rejectTool(requestId: string, toolCallId: string): void
  killCommand(toolCallId: string): void
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void): () => void
  onToolPending(callback: (data: { requestId: string; toolCallId: string; name: string; arguments: string; autoApprove: boolean }) => void): () => void
  onToolRunning(callback: (data: { requestId: string; toolCallId: string }) => void): () => void
  onToolOutputStream(callback: (data: { requestId: string; toolCallId: string; chunk: string }) => void): () => void
  onToolResult(callback: (data: { requestId: string; toolCallId: string; result: string; rejected: boolean; screenshot?: string }) => void): () => void
  onNewTurn(callback: (data: { requestId: string }) => void): () => void
  onDone(callback: (data: { requestId: string }) => void): () => void
  onError(callback: (data: { requestId: string; message: string }) => void): () => void
}

interface DialogApi {
  selectDirectory(): Promise<string | null>
}

interface ProjectData {
  id: string
  path: string
  name: string
}

interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  cwd?: string
}

interface ProjectApi {
  list(): Promise<ProjectData[]>
  add(folderPath: string): Promise<ProjectData | null>
  remove(projectId: string): Promise<void>
  checkPath(folderPath: string): Promise<boolean>
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

interface ConversationApi {
  list(): Promise<ConversationMeta[]>
  create(title: string): Promise<ConversationMeta>
  delete(convId: string): Promise<void>
  rename(convId: string, title: string): Promise<void>
  getMessages(convId: string): Promise<StoredMessage[]>
  saveMessages(convId: string, messages: StoredMessage[]): Promise<void>
  setCwd(convId: string, cwd: string): Promise<void>
  getCwd(convId: string): Promise<string>
}

interface Window {
  ipcRenderer: import('electron').IpcRenderer
  aiChat: AiChatApi
  agentChat: AgentChatApi
  dialogApi: DialogApi
  projectApi: ProjectApi
  conversationApi: ConversationApi
}

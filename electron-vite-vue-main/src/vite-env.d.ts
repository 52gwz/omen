/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ModelProvider {
  id: string
  name: string
  apiKey: string
  baseURL: string
  models: string[]
}

interface AiChatConfig {
  providers: ModelProvider[]
  activeProviderId: string
  activeModel: string
  maxIterations: number
  autoApproveAll: boolean
}

interface AiChatApi {
  getConfig(): Promise<AiChatConfig>
  saveConfig(config: AiChatConfig & { providers: ModelProvider[] }): Promise<void>
  setActive(providerId: string, model: string): Promise<void>
  getModels(opts?: { apiKey?: string; baseURL?: string; providerId?: string }): Promise<string[]>
  sendMessage(payload: { model: string; messages: ApiMessage[]; providerId?: string }): Promise<string>
  startStream(payload: { requestId: string; model: string; messages: ApiMessage[]; providerId?: string }): void
  stopStream(requestId: string): void
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamDone(callback: (data: { requestId: string; chunkCount: number }) => void): () => void
  onStreamError(callback: (data: { requestId: string; message: string }) => void): () => void
}

interface AgentChatApi {
  start(payload: { requestId: string; model: string; messages: ApiMessage[]; cwd: string; providerId?: string; tabContext?: string }): void
  getSystemPrompt(payload: { cwd: string; tabContext?: string }): Promise<string>
  stop(requestId: string): void
  confirmTool(requestId: string, toolCallId: string): void
  rejectTool(requestId: string, toolCallId: string): void
  killCommand(toolCallId: string): void
  onStreamChunk(callback: (data: { requestId: string; delta: string }) => void): () => void
  onStreamReasoning(callback: (data: { requestId: string; delta: string }) => void): () => void
  onToolCallStreaming(callback: (data: { requestId: string; index: number; id: string; name: string; argumentsDelta: string }) => void): () => void
  onToolPending(callback: (data: { requestId: string; toolCallId: string; name: string; arguments: string; autoApprove: boolean }) => void): () => void
  onToolRunning(callback: (data: { requestId: string; toolCallId: string }) => void): () => void
  onToolOutputStream(callback: (data: { requestId: string; toolCallId: string; chunk: string }) => void): () => void
  onToolResult(callback: (data: { requestId: string; toolCallId: string; result: string; rejected: boolean }) => void): () => void
  onNewTurn(callback: (data: { requestId: string }) => void): () => void
  onDone(callback: (data: { requestId: string }) => void): () => void
  onError(callback: (data: { requestId: string; message: string }) => void): () => void
  onPlanUpdate(callback: (data: { requestId: string; toolCallId: string; explanation: string | null; plan: Array<{ step: string; status: string }> }) => void): () => void
}

interface DialogApi {
  selectDirectory(): Promise<string | null>
  selectImages(): Promise<string[]>
  selectFiles(defaultPath?: string): Promise<string[]>
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
  projectId?: string
}

interface ProjectApi {
  list(): Promise<ProjectData[]>
  add(folderPath: string): Promise<ProjectData | null>
  remove(projectId: string): Promise<void>
  rename(projectId: string, newName: string): Promise<void>
  checkPath(folderPath: string): Promise<boolean>
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

type MultimodalContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>

interface ApiMessage {
  role: string
  content: string | MultimodalContent
}

interface ConversationApi {
  list(projectId?: string | null): Promise<ConversationMeta[]>
  create(title: string, projectId?: string): Promise<ConversationMeta>
  delete(convId: string): Promise<void>
  rename(convId: string, title: string): Promise<void>
  getMessages(convId: string): Promise<StoredMessage[]>
  saveMessages(convId: string, messages: StoredMessage[]): Promise<void>
  setCwd(convId: string, cwd: string): Promise<void>
  getCwd(convId: string): Promise<string>
}

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface SkillInfo {
  name: string
  description: string
  path: string
  builtin: boolean
  enabled: boolean
}

interface SkillsApi {
  list(): Promise<SkillInfo[]>
  toggle(name: string): Promise<void>
  importSkill(): Promise<{ success: boolean; error?: string }>
}

interface FsApi {
  readDir(dirPath: string): Promise<FileEntry[]>
  deletePath(targetPath: string): Promise<{ error?: string }>
  showInFolder(fullPath: string): Promise<void>
  watchDir(dirPath: string): Promise<void>
  unwatchDir(dirPath: string): Promise<void>
  onDirChanged(callback: (data: { dirPath: string }) => void): () => void
  readFile(filePath: string): Promise<{ content: string; error?: string }>
  writeFile(filePath: string, content: string): Promise<{ error?: string }>
}

interface Window {
  ipcRenderer: import('electron').IpcRenderer
  aiChat: AiChatApi
  agentChat: AgentChatApi
  dialogApi: DialogApi
  projectApi: ProjectApi
  conversationApi: ConversationApi
  skillsApi: SkillsApi
  fsApi: FsApi
}

export interface TabInfo {
  id: string
  convId: string
}

export const MIN_SPLIT_RATIO = 0.15

export interface PaneState {
  id: string
  tabs: TabInfo[]
  activeTabIdx: number
}

export interface PaneLeafNode {
  type: 'pane'
  pane: PaneState
}

export interface PaneSplitNode {
  type: 'split'
  id: string
  direction: 'row' | 'column'
  ratio: number
  first: PaneNode
  second: PaneNode
}

export type PaneNode = PaneLeafNode | PaneSplitNode

export type DropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface DragTabState {
  paneId: string
  tabId: string
}

export interface DropTarget {
  paneId: string
  position: DropPosition
}

export interface TabInsertTarget {
  paneId: string
  index: number
}

export interface MentionTab {
  key: string
  value: string
  type: 'file' | 'webview'
  currentUrl?: string
  path?: string
}

export interface CodeReference {
  filePath: string
  text: string
  startLine: number
  endLine: number
  language: string
}

export interface FileReference {
  filePath: string
  name: string
  isDirectory: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  arguments: string
  status: 'streaming' | 'pending' | 'confirmed' | 'rejected' | 'running' | 'completed' | 'error'
  result?: string
  streamOutput?: string
}

export interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningExpanded?: boolean
  images?: string[]
  toolCalls?: ToolCallInfo[]
  planSteps?: PlanStep[]
  fileChanges?: { filePath: string; deleted: boolean }[]
  changesUndone?: boolean
  agentRequestId?: string
}

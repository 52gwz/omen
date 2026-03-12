import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import { toolDefinitions, executeTool, type ToolExecOptions } from './tools'
import { buildSystemPrompt } from './system-prompt'
import { loadSkills } from './skills'

type MessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

interface Message {
  role: string
  content: MessageContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface AgentRunParams {
  requestId: string
  model: string
  messages: { role: string; content: string | MessageContent }[]
  apiKey: string
  baseURL: string
  cwd: string
  sender: WebContents
  maxIterations: number
  autoApproveAll?: boolean
  signal?: AbortSignal
  disabledSkills?: string[]
}

function accumulateToolCalls(accumulated: Map<number, ToolCall>, deltas: ToolCallDelta[]) {
  for (const delta of deltas) {
    const existing = accumulated.get(delta.index)
    if (!existing) {
      accumulated.set(delta.index, {
        id: delta.id || '',
        type: 'function',
        function: {
          name: delta.function?.name || '',
          arguments: delta.function?.arguments || '',
        },
      })
    } else {
      if (delta.id) existing.id = delta.id
      if (delta.function?.name) existing.function.name += delta.function.name
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments
    }
  }
}

async function streamOnce(params: {
  allMessages: Message[]
  model: string
  apiKey: string
  baseURL: string
  requestId: string
  sender: WebContents
  signal?: AbortSignal
}): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: string }> {
  const { allMessages, model, apiKey, baseURL, requestId, sender, signal } = params

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: allMessages,
      tools: toolDefinitions,
      tool_choice: 'auto',
    }),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`API 请求失败 (${response.status}): ${errText}`)
  }

  const reader = (response.body as any).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let fullReasoning = ''
  let finishReason = 'stop'
  const toolCallAccum = new Map<number, ToolCall>()

  function emitContent(text: string) {
    if (!text) return
    fullContent += text
    sender.send('agent:stream-chunk', { requestId, delta: text })
  }

  while (true) {
    if (signal?.aborted) break
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
        const choice = json.choices?.[0]
        if (!choice) continue

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }

        const delta = choice.delta
        if (!delta) continue

        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content
          sender.send('agent:stream-reasoning', { requestId, delta: delta.reasoning_content })
        }

        if (delta.content) {
          emitContent(delta.content)
        }

        if (delta.tool_calls) {
          accumulateToolCalls(toolCallAccum, delta.tool_calls)
          for (const d of delta.tool_calls) {
            const tc = toolCallAccum.get(d.index)
            if (tc) {
              sender.send('agent:tool-call-streaming', {
                requestId,
                index: d.index,
                id: tc.id,
                name: tc.function.name,
                argumentsDelta: d.function?.arguments || '',
              })
            }
          }
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  const toolCalls = Array.from(toolCallAccum.values())
  return { content: fullContent.trim(), reasoning: fullReasoning.trim(), toolCalls, finishReason }
}

const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep_search',
])

const SAFE_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'echo', 'which', 'whoami',
  'date', 'env', 'printenv', 'uname', 'file', 'stat', 'du', 'df',
  'find', 'grep', 'rg', 'ag', 'tree', 'git status', 'git log', 'git diff', 'git branch',
])

const SAFE_COMMAND_PREFIXES = [
  'git status', 'git log', 'git diff', 'git branch',
]

function isExecCommandSafe(args: Record<string, unknown>): boolean {
  const cmd = (args.command as string || '').trim()
  if (!cmd) return false
  const first = cmd.split(/\s+/)[0]
  if (SAFE_COMMANDS.has(first)) return true
  return SAFE_COMMAND_PREFIXES.some((prefix) => cmd.startsWith(prefix))
}

function waitForConfirmation(requestId: string, toolCallId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmChannel = `agent:tool-confirm`
    const rejectChannel = `agent:tool-reject`

    function cleanup() {
      ipcMain.removeListener(confirmChannel, onConfirm)
      ipcMain.removeListener(rejectChannel, onReject)
    }

    const onConfirm = (_: any, data: { requestId: string; toolCallId: string }) => {
      if (data.requestId !== requestId || data.toolCallId !== toolCallId) return
      cleanup()
      resolve(true)
    }

    const onReject = (_: any, data: { requestId: string; toolCallId: string }) => {
      if (data.requestId !== requestId || data.toolCallId !== toolCallId) return
      cleanup()
      resolve(false)
    }

    ipcMain.on(confirmChannel, onConfirm)
    ipcMain.on(rejectChannel, onReject)

    if (signal) {
      signal.addEventListener('abort', () => {
        cleanup()
        resolve(false)
      }, { once: true })
    }
  })
}

export async function runAgentLoop(params: AgentRunParams) {
  const { requestId, model, apiKey, baseURL, cwd, sender, maxIterations, autoApproveAll, signal, disabledSkills = [] } = params

  const skills = await loadSkills(disabledSkills)
  const enabledSkills = skills.filter(s => s.enabled)

  const allMessages: Message[] = [
    { role: 'system', content: buildSystemPrompt(cwd, enabledSkills) },
    ...params.messages.map((m): Message => ({ role: m.role, content: m.content })),
  ]

  for (let i = 0; maxIterations <= 0 || i < maxIterations; i++) {
    if (signal?.aborted) {
      sender.send('agent:done', { requestId, stopped: true })
      return
    }
    if (i > 0) {
      sender.send('agent:new-turn', { requestId })
    }
    const result = await streamOnce({ allMessages, model, apiKey, baseURL, requestId, sender, signal })

    if (result.toolCalls.length === 0) {
      // No tool calls - normal text response, done
      sender.send('agent:done', { requestId })
      return
    }

    // Has tool calls - build assistant message with tool_calls
    const assistantMsg: Message = {
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    }
    allMessages.push(assistantMsg)

    for (const tc of result.toolCalls) {
      if (signal?.aborted) {
        sender.send('agent:done', { requestId, stopped: true })
        return
      }

      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = {}
      }

      const isSafe = autoApproveAll
        || SAFE_TOOLS.has(tc.function.name)
        || (tc.function.name === 'exec_command' && isExecCommandSafe(args))

      sender.send('agent:tool-pending', {
        requestId,
        toolCallId: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        autoApprove: isSafe,
      })

      let confirmed = true
      if (!isSafe) {
        confirmed = await waitForConfirmation(requestId, tc.id, signal)
        if (signal?.aborted) {
          sender.send('agent:done', { requestId, stopped: true })
          return
        }
      }

      if (!confirmed) {
        const toolMsg: Message = {
          role: 'tool',
          content: '[用户拒绝执行此操作]',
          tool_call_id: tc.id,
        }
        allMessages.push(toolMsg)
        sender.send('agent:tool-result', {
          requestId,
          toolCallId: tc.id,
          result: '[用户拒绝执行此操作]',
          rejected: true,
        })
        continue
      }

      sender.send('agent:tool-running', { requestId, toolCallId: tc.id })

      const execOptions: ToolExecOptions = {
        signal,
        toolCallId: tc.id,
        onOutput: (chunk) => {
          sender.send('agent:tool-output-stream', { requestId, toolCallId: tc.id, chunk })
        },
      }
      const toolResult = await executeTool(tc.function.name, args, cwd, execOptions)

      const toolMsg: Message = {
        role: 'tool',
        content: toolResult.content,
        tool_call_id: tc.id,
      }
      allMessages.push(toolMsg)

      sender.send('agent:tool-result', {
        requestId,
        toolCallId: tc.id,
        result: toolResult.content,
        rejected: false,
      })
    }

    // Continue the loop - the LLM will see tool results and decide next action
  }

  // Hit max iterations
  sender.send('agent:error', { requestId, message: `Agent 已达到最大迭代次数 (${maxIterations})` })
  sender.send('agent:done', { requestId })
}

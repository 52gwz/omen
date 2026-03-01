import type { WebContents } from 'electron'
import { ipcMain } from 'electron'
import { toolDefinitions, executeTool } from './tools'
import { buildSystemPrompt } from './system-prompt'

interface Message {
  role: string
  content: string | null
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
  messages: { role: string; content: string }[]
  apiKey: string
  baseURL: string
  cwd: string
  sender: WebContents
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
}): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: string }> {
  const { allMessages, model, apiKey, baseURL, requestId, sender } = params

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

  while (true) {
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
          fullContent += delta.content
          sender.send('agent:stream-chunk', { requestId, delta: delta.content })
        }

        if (delta.tool_calls) {
          accumulateToolCalls(toolCallAccum, delta.tool_calls)
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  const toolCalls = Array.from(toolCallAccum.values())
  return { content: fullContent, reasoning: fullReasoning, toolCalls, finishReason }
}

function waitForConfirmation(requestId: string, toolCallId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmChannel = `agent:tool-confirm`
    const rejectChannel = `agent:tool-reject`

    const onConfirm = (_: any, data: { requestId: string; toolCallId: string }) => {
      if (data.requestId !== requestId || data.toolCallId !== toolCallId) return
      ipcMain.removeListener(confirmChannel, onConfirm)
      ipcMain.removeListener(rejectChannel, onReject)
      resolve(true)
    }

    const onReject = (_: any, data: { requestId: string; toolCallId: string }) => {
      if (data.requestId !== requestId || data.toolCallId !== toolCallId) return
      ipcMain.removeListener(confirmChannel, onConfirm)
      ipcMain.removeListener(rejectChannel, onReject)
      resolve(false)
    }

    ipcMain.on(confirmChannel, onConfirm)
    ipcMain.on(rejectChannel, onReject)
  })
}

export async function runAgentLoop(params: AgentRunParams) {
  const { requestId, model, apiKey, baseURL, cwd, sender } = params

  const allMessages: Message[] = [
    { role: 'system', content: buildSystemPrompt(cwd) },
    ...params.messages.map((m) => ({ role: m.role, content: m.content })),
  ]

  const MAX_ITERATIONS = 20

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (i > 0) {
      sender.send('agent:new-turn', { requestId })
    }
    const result = await streamOnce({ allMessages, model, apiKey, baseURL, requestId, sender })

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

    // Process each tool call sequentially
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = {}
      }

      // Notify renderer about pending tool call
      sender.send('agent:tool-pending', {
        requestId,
        toolCallId: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })

      // Wait for user confirmation
      const confirmed = await waitForConfirmation(requestId, tc.id)

      if (!confirmed) {
        // User rejected - add rejection as tool result and continue
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

      // User confirmed - execute the tool
      sender.send('agent:tool-running', { requestId, toolCallId: tc.id })

      const toolResult = await executeTool(tc.function.name, args, cwd)

      const toolMsg: Message = {
        role: 'tool',
        content: toolResult,
        tool_call_id: tc.id,
      }
      allMessages.push(toolMsg)

      sender.send('agent:tool-result', {
        requestId,
        toolCallId: tc.id,
        result: toolResult,
        rejected: false,
      })
    }

    // Continue the loop - the LLM will see tool results and decide next action
  }

  // Hit max iterations
  sender.send('agent:error', { requestId, message: `Agent 已达到最大迭代次数 (${MAX_ITERATIONS})` })
  sender.send('agent:done', { requestId })
}

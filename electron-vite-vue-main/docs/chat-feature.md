# 对话功能核心原理

## 整体架构

对话功能基于 **Electron 三层架构**：Main (Node.js) ↔ Preload (Bridge) ↔ Renderer (Vue)。

- **Main 进程**：运行在 Node.js 环境，负责与 OpenAI 兼容 API 通信，处理密钥和网络请求
- **Preload 脚本**：通过 `contextBridge` 将 IPC 通道封装为类型安全的 `window.aiChat` API
- **Renderer 进程**：Vue 组件消费 `window.aiChat`，管理 UI 状态和消息列表

```
┌──────────────────────────────────────────────────────┐
│  Renderer (Vue)                                      │
│  window.aiChat.startStream() ──┐                     │
│  window.aiChat.onStreamChunk() │                     │
│  window.aiChat.onStreamDone()  │                     │
└────────────────────────────────┼──────────────────────┘
                                 │  contextBridge
┌────────────────────────────────┼──────────────────────┐
│  Preload                       │                      │
│  ipcRenderer.send/on ──────────┼───── IPC ──────────┐ │
└────────────────────────────────┼─────────────────────┼─┘
                                 │                     │
┌────────────────────────────────┼─────────────────────┼─┐
│  Main (Node.js)                │                     │ │
│  ipcMain.on('ai:chat-stream') ─┘                     │ │
│  fetch(baseURL/chat/completions, { stream: true }) ──┘ │
└──────────────────────────────────────────────────────────┘
```

## 关键依赖

```json
"@ai-sdk/openai": "^1.3.24",
"ai": "^4.3.19"
```

这两个包来自 [Vercel AI SDK](https://sdk.vercel.ai/)：

| 包 | 作用 |
|---|---|
| `ai` | 核心库，提供 `generateText`、`streamText`、`CoreMessage` 等统一接口 |
| `@ai-sdk/openai` | OpenAI 兼容 Provider，通过 `createOpenAI()` 创建可被 `ai` 核心库消费的 model 实例 |

**当前使用方式**：项目中 `generateText` 用于非流式对话（`ai:chat` 通道），流式对话则**直接使用原生 `fetch` 调用 SSE 接口**（`ai:chat-stream` 通道），未使用 AI SDK 的 `streamText`。这是为了最大限度控制 SSE 解析逻辑，方便调试不同网关的兼容性问题。

## 配置管理

配置项（API Key、Base URL、默认模型）由用户在界面中设置，通过 IPC 传递到 Main 进程，使用 `electron-store` 持久化到本地磁盘。

需要管理的配置项：

| 字段 | 说明 | 示例 |
|---|---|---|
| `apiKey` | OpenAI 兼容 API 密钥 | `sk-xxx` |
| `baseURL` | 接口地址 | `https://api.openai.com/v1` |
| `defaultModel` | 默认模型 | `gpt-4o-mini` |

### 数据流

```
┌─────────────────────────────────────────────────┐
│  Renderer (设置面板)                              │
│  用户填写 apiKey / baseURL / defaultModel        │
│         │ saveConfig()                           │
│         ▼                                        │
│  window.aiChat.saveConfig(config) ───────┐       │
│  window.aiChat.getConfig()               │       │
└──────────────────────────────────────────┼───────┘
                                           │ IPC
┌──────────────────────────────────────────┼───────┐
│  Main 进程                               │       │
│  ipcMain.handle('ai:save-config') ◄──────┘       │
│  electron-store 读写本地 JSON 文件                │
│  getAiConfig() 优先读 store，无值时给默认值       │
└──────────────────────────────────────────────────┘
```

### 核心逻辑

Main 进程中 `getAiConfig()` 从 `electron-store` 读取用户配置：

```typescript
import Store from 'electron-store'

const store = new Store()

function getAiConfig() {
  const apiKey = store.get('apiKey') as string
  if (!apiKey) throw new Error('请先在设置中填写 API Key')

  const baseURL = (store.get('baseURL') as string || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const defaultModel = (store.get('defaultModel') as string) || 'gpt-4o-mini'
  return { apiKey, baseURL, defaultModel }
}
```

Preload 层暴露配置读写接口：

```typescript
contextBridge.exposeInMainWorld('aiChat', {
  getConfig()  { return ipcRenderer.invoke('ai:get-config') },
  saveConfig(config: { apiKey: string, baseURL: string, defaultModel: string }) {
    return ipcRenderer.invoke('ai:save-config', config)
  },
  // ...其他方法
})
```

Renderer 设置面板中调用 `window.aiChat.saveConfig(config)` 即可持久化，配置立即生效，无需重启应用。

## 模型加载

应用启动时（Vue `onMounted`）调用 `window.aiChat.getModels()`，流程：

1. Renderer 通过 preload bridge 触发 `ipcRenderer.invoke('ai:models')`
2. Main 进程使用 `fetch` 请求 `${baseURL}/models`（标准 OpenAI Models API）
3. 解析返回的 `data[].id` 列表，发送回 Renderer
4. Renderer 拿到列表后填充 `<select>` 下拉框，默认选中用户在设置中指定的模型

```typescript
// Main 进程 - 创建 provider 实例（非流式对话时使用）
const provider = createOpenAI({ apiKey, baseURL, compatibility: 'strict' })
const { text } = await generateText({
  model: provider(modelName),  // provider(modelName) 返回一个 LanguageModel 实例
  messages: normalizedMessages,
})
```

`createOpenAI()` 接收 `apiKey`、`baseURL`、`compatibility` 参数，返回一个 provider 函数。调用 `provider('gpt-4o-mini')` 即可得到可直接传入 `generateText` / `streamText` 的 model 对象。

## 流式输出

### 请求发起

Renderer 调用 `window.aiChat.startStream({ requestId, model, messages })`，通过 `ipcRenderer.send`（单向）发送到 Main 进程。`requestId` 是客户端生成的 UUID，用于多请求并发时匹配响应。

### SSE 解析（Main 进程核心逻辑）

Main 进程通过原生 `fetch` 发起流式请求：

```typescript
const response = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model,
    stream: true,         // 关键：开启流式返回
    messages: normalizedMessages,
  }),
})
```

然后使用 `ReadableStream` 逐块读取：

```typescript
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (!done) {
  const { value, done: readerDone } = await reader.read()
  buffer += decoder.decode(value, { stream: true })
  // 按 '\n\n' 分割 SSE 事件，逐条解析 data: 行
}
```

每解析出一个 SSE 事件，提取 JSON 中的 `choices[0].delta.content` 和 `choices[0].delta.reasoning_content`，通过 IPC 推送给 Renderer。

### IPC 事件通道

| 通道 | 方向 | 数据 | 含义 |
|---|---|---|---|
| `ai:chat-stream` | Renderer → Main | `{ requestId, model, messages }` | 发起流式请求 |
| `ai:chat-stream-reasoning` | Main → Renderer | `{ requestId, delta }` | 推理过程增量片段 |
| `ai:chat-stream-chunk` | Main → Renderer | `{ requestId, delta }` | 正文内容增量片段 |
| `ai:chat-stream-done` | Main → Renderer | `{ requestId, chunkCount }` | 流结束 |
| `ai:chat-stream-error` | Main → Renderer | `{ requestId, message }` | 流异常 |

### Renderer 侧消费

在 Vue 组件中注册四个监听器，按 `requestId` 过滤后拼接到当前 assistant 消息：

```typescript
// 推理过程 - 追加到 message.reasoning
window.aiChat.onStreamReasoning(({ requestId, delta }) => {
  current.reasoning = (current.reasoning || '') + delta
})

// 正文内容 - 追加到 message.content
window.aiChat.onStreamChunk(({ requestId, delta }) => {
  current.content += delta
})
```

组件销毁时通过返回的 `off` 函数取消监听，防止内存泄漏。

## 推理过程展示

部分模型（如 DeepSeek-R1）在流式返回中，会先通过 `reasoning_content` 字段输出思考过程，之后才返回 `content` 正文。

Main 进程解析 SSE 时区分这两个字段：

```typescript
const delta = json.choices?.[0]?.delta?.content
const reasoning = json.choices?.[0]?.delta?.reasoning_content

if (reasoning) sender.send('ai:chat-stream-reasoning', { requestId, delta: reasoning })
if (delta)     sender.send('ai:chat-stream-chunk',     { requestId, delta })
```

Renderer 中使用 `<details>` 折叠展示推理过程：

```html
<details v-if="message.reasoning" class="chat-reasoning">
  <summary>推理过程</summary>
  <p>{{ message.reasoning }}</p>
</details>
```

## Preload 桥接层设计

Preload 通过 `contextBridge.exposeInMainWorld('aiChat', {...})` 暴露类型安全的 API，核心设计：

- **请求类**（`getModels`、`sendMessage`）：使用 `ipcRenderer.invoke`（双向，有返回值）
- **流式类**（`startStream`）：使用 `ipcRenderer.send`（单向），响应通过独立的 `ipcRenderer.on` 事件接收
- **监听器**：每个 `onStreamXxx` 方法返回一个卸载函数 `() => void`，调用即取消监听

类型声明在 `src/vite-env.d.ts` 中扩展 `Window` 接口，确保 Renderer 中使用 `window.aiChat` 时有完整类型提示。

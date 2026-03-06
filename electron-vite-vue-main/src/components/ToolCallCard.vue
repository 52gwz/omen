<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  name: string
  arguments: string
  status: 'pending' | 'confirmed' | 'rejected' | 'running' | 'completed' | 'error'
  result?: string
  screenshot?: string
}>()

const emit = defineEmits<{
  confirm: []
  reject: []
}>()

const resultExpanded = ref(false)

const toolLabel: Record<string, string> = {
  exec_command: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  list_directory: '列出目录',
  grep_search: '搜索内容',
  edit_file: '编辑文件',
  browser_navigate: '浏览器导航',
  browser_screenshot: '页面截图',
  browser_click: '点击页面',
  browser_type: '输入文本',
  browser_get_text: '获取文本',
  browser_scroll: '滚动页面',
  browser_evaluate: '执行脚本',
  browser_close: '关闭浏览器',
}

const screenshotExpanded = ref(false)

const statusLabel: Record<string, string> = {
  pending: '等待确认',
  confirmed: '已确认',
  rejected: '已拒绝',
  running: '执行中...',
  completed: '已完成',
  error: '出错',
}

const displayName = computed(() => toolLabel[props.name] || props.name)
const displayStatus = computed(() => statusLabel[props.status] || props.status)

const parsedArgs = computed(() => {
  try {
    const obj = JSON.parse(props.arguments)
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
  } catch {
    return props.arguments
  }
})

const truncatedResult = computed(() => {
  if (!props.result) return ''
  if (props.result.length > 2000) return props.result.slice(0, 2000) + '\n... (已截断)'
  return props.result
})
</script>

<template>
  <div class="tool-card" :class="status">
    <div class="tool-header">
      <div class="tool-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </div>
      <span class="tool-name">{{ displayName }}</span>
      <span class="tool-status-badge" :class="status">{{ displayStatus }}</span>
    </div>

    <div class="tool-args">
      <pre>{{ parsedArgs }}</pre>
    </div>

    <div v-if="status === 'pending'" class="tool-actions">
      <button class="action-btn confirm" @click="emit('confirm')">确认执行</button>
      <button class="action-btn reject" @click="emit('reject')">拒绝</button>
    </div>

    <div v-if="status === 'running'" class="tool-running">
      <span class="spinner"></span>
      <span>执行中...</span>
    </div>

    <!-- Screenshot preview -->
    <div v-if="screenshot && (status === 'completed')" class="screenshot-section">
      <button class="result-toggle" @click="screenshotExpanded = !screenshotExpanded">
        查看截图
        <svg
          class="result-chevron"
          :class="{ expanded: screenshotExpanded }"
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div v-if="screenshotExpanded" class="screenshot-panel">
        <img :src="`data:image/png;base64,${screenshot}`" class="screenshot-img" alt="页面截图" />
      </div>
    </div>

    <div v-if="result && (status === 'completed' || status === 'error' || status === 'rejected')" class="tool-result-section">
      <button class="result-toggle" @click="resultExpanded = !resultExpanded">
        {{ status === 'rejected' ? '拒绝信息' : '执行结果' }}
        <svg
          class="result-chevron"
          :class="{ expanded: resultExpanded }"
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div v-if="resultExpanded" class="result-panel">
        <pre class="result-content">{{ truncatedResult }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 12px;
  margin: 8px 0;
  background: var(--c-surface-alt);
}

.tool-card.pending { border-color: var(--c-yellow); }
.tool-card.running { border-color: var(--c-blue); }
.tool-card.completed { border-color: var(--c-green); }
.tool-card.rejected { border-color: var(--c-red); }
.tool-card.error { border-color: var(--c-red); }

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.tool-icon {
  color: var(--c-overlay1);
  display: flex;
  align-items: center;
}

.tool-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--c-text);
}

.tool-status-badge {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.tool-status-badge.pending { background: var(--c-badge-pending-bg); color: var(--c-badge-pending-text); }
.tool-status-badge.running { background: var(--c-badge-running-bg); color: var(--c-badge-running-text); }
.tool-status-badge.completed { background: var(--c-badge-completed-bg); color: var(--c-badge-completed-text); }
.tool-status-badge.rejected { background: var(--c-badge-error-bg); color: var(--c-badge-error-text); }
.tool-status-badge.error { background: var(--c-badge-error-bg); color: var(--c-badge-error-text); }
.tool-status-badge.confirmed { background: var(--c-badge-completed-bg); color: var(--c-badge-completed-text); }

.tool-args {
  background: var(--c-base);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
}

.tool-args pre {
  margin: 0;
  font-size: 0.82rem;
  color: var(--c-subtext1);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.5;
}

.tool-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  flex: 1;
  padding: 7px 0;
  border-radius: 8px;
  border: none;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.2s;
}

.action-btn:hover { opacity: 0.85; }

.action-btn.confirm {
  background: var(--c-confirm-btn-bg);
  color: var(--c-confirm-btn-text);
}

.action-btn.reject {
  background: var(--c-surface1);
  color: var(--c-text);
}

.tool-running {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  color: var(--c-blue);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--c-surface1);
  border-top-color: var(--c-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.result-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--c-overlay1);
  font-size: 0.82rem;
  cursor: pointer;
  padding: 0;
  user-select: none;
  font-family: inherit;
  transition: color 0.2s;
}

.result-toggle:hover { color: var(--c-subtext1); }

.result-chevron {
  transition: transform 0.25s ease;
}

.result-chevron.expanded {
  transform: rotate(180deg);
}

.result-panel {
  margin-top: 8px;
  background: var(--c-base);
  border-radius: 8px;
  padding: 10px 12px;
  max-height: 300px;
  overflow-y: auto;
}

.result-content {
  margin: 0;
  font-size: 0.8rem;
  color: var(--c-subtext0);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.5;
}

.screenshot-section {
  margin-bottom: 4px;
}

.screenshot-panel {
  margin-top: 8px;
  background: var(--c-base);
  border-radius: 8px;
  padding: 8px;
  overflow: hidden;
}

.screenshot-img {
  width: 100%;
  border-radius: 6px;
  display: block;
  cursor: pointer;
  transition: opacity 0.2s;
}

.screenshot-img:hover {
  opacity: 0.9;
}
</style>

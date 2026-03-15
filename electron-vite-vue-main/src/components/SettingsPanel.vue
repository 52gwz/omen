<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

const emit = defineEmits<{ close: [] }>()

const providers = reactive<ModelProvider[]>([])
const activeProviderId = ref('')
const activeModel = ref('')
const applyProviderId = ref('')
const applyModel = ref('')
const maxIterations = ref(0)
const autoApproveAll = ref(false)
const saving = ref(false)
const message = ref('')
const expandedId = ref<string | null>(null)

const fetchingMap = reactive<Record<string, boolean>>({})
const fetchErrorMap = reactive<Record<string, string>>({})
const newModelInput = reactive<Record<string, string>>({})
const keyVisibleMap = reactive<Record<string, boolean>>({})

onMounted(async () => {
  try {
    const config = await window.aiChat.getConfig()
    providers.length = 0
    for (const p of config.providers) {
      providers.push({ ...p, models: [...p.models] })
    }
    activeProviderId.value = config.activeProviderId
    activeModel.value = config.activeModel
    applyProviderId.value = config.applyProviderId || ''
    applyModel.value = config.applyModel || ''
    maxIterations.value = config.maxIterations ?? 0
    autoApproveAll.value = config.autoApproveAll ?? false
    if (providers.length === 1) expandedId.value = providers[0].id
  } catch {}
})

function addProvider() {
  const id = crypto.randomUUID()
  providers.push({
    id,
    name: '',
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    models: [],
  })
  expandedId.value = id
}

function removeProvider(idx: number) {
  const removed = providers[idx]
  providers.splice(idx, 1)
  if (expandedId.value === removed.id) expandedId.value = null
  if (activeProviderId.value === removed.id) {
    activeProviderId.value = providers[0]?.id || ''
    activeModel.value = providers[0]?.models[0] || ''
  }
}

function toggleProvider(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

async function fetchModelsFor(provider: ModelProvider) {
  if (!provider.apiKey) {
    fetchErrorMap[provider.id] = '请先填写 API Key'
    return
  }
  fetchingMap[provider.id] = true
  fetchErrorMap[provider.id] = ''
  try {
    const list = await window.aiChat.getModels({
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
    })
    if (list.length) {
      const existing = new Set(provider.models)
      for (const m of list) {
        if (!existing.has(m)) provider.models.push(m)
      }
      autoActivateIfNeeded(provider)
    } else {
      fetchErrorMap[provider.id] = '该接口未返回模型列表，请手动添加'
    }
  } catch {
    fetchErrorMap[provider.id] = '获取模型列表失败'
  } finally {
    fetchingMap[provider.id] = false
  }
}

function addModelManual(provider: ModelProvider) {
  const name = (newModelInput[provider.id] || '').trim()
  if (!name) return
  if (!provider.models.includes(name)) provider.models.push(name)
  newModelInput[provider.id] = ''
  autoActivateIfNeeded(provider)
}

function autoActivateIfNeeded(provider: ModelProvider) {
  if (!activeProviderId.value && provider.models.length) {
    activeProviderId.value = provider.id
    activeModel.value = provider.models[0]
  }
  if (activeProviderId.value === provider.id && !activeModel.value && provider.models.length) {
    activeModel.value = provider.models[0]
  }
}

function removeModel(provider: ModelProvider, model: string) {
  const idx = provider.models.indexOf(model)
  if (idx >= 0) provider.models.splice(idx, 1)
}

const applyProviderModels = computed(() => {
  if (!applyProviderId.value) return []
  const p = providers.find(p => p.id === applyProviderId.value)
  return p?.models || []
})

function onApplyProviderChange() {
  applyModel.value = ''
}

async function save() {
  saving.value = true
  message.value = ''

  // Auto-select first provider+model if nothing is active
  if (providers.length) {
    const activeValid = providers.some(p => p.id === activeProviderId.value)
    if (!activeValid) {
      activeProviderId.value = providers[0].id
      activeModel.value = providers[0].models[0] || ''
    }
    if (!activeModel.value) {
      const ap = providers.find(p => p.id === activeProviderId.value)
      if (ap?.models.length) activeModel.value = ap.models[0]
    }
  }

  try {
    await window.aiChat.saveConfig({
      providers: providers.map(p => ({ ...p, models: [...p.models] })),
      activeProviderId: activeProviderId.value,
      activeModel: activeModel.value,
      applyProviderId: applyProviderId.value,
      applyModel: applyModel.value,
      maxIterations: maxIterations.value,
      autoApproveAll: autoApproveAll.value,
    })
    message.value = '保存成功'
    setTimeout(() => emit('close'), 600)
  } catch (e: any) {
    message.value = `保存失败: ${e.message}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>设置</h2>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="settings-body">
        <div class="section-label">模型供应商</div>

        <div v-for="(p, idx) in providers" :key="p.id" class="provider-card">
          <div class="provider-card-header" @click="toggleProvider(p.id)">
            <span class="provider-name">{{ p.name || '未命名供应商' }}</span>
            <div class="provider-header-right">
              <span v-if="p.models.length" class="model-count">{{ p.models.length }} 个模型</span>
              <button class="icon-btn" @click.stop="removeProvider(idx)" title="删除此供应商">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
                </svg>
              </button>
              <svg
                class="expand-chevron"
                :class="{ expanded: expandedId === p.id }"
                width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          <div v-if="expandedId === p.id" class="provider-card-body">
            <label>
              <span>名称</span>
              <input v-model="p.name" type="text" placeholder="如 OpenAI、DeepSeek、Ollama" />
            </label>
            <label>
              <span>API Key</span>
              <div class="key-input-wrap">
                <input v-model="p.apiKey" :type="keyVisibleMap[p.id] ? 'text' : 'password'" placeholder="sk-..." />
                <button class="key-toggle-btn" type="button" @click="keyVisibleMap[p.id] = !keyVisibleMap[p.id]" tabindex="-1">
                  <svg v-if="keyVisibleMap[p.id]" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                  <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  </svg>
                </button>
              </div>
            </label>
            <label>
              <span>Base URL</span>
              <input v-model="p.baseURL" type="text" placeholder="https://api.openai.com/v1" />
            </label>

            <div class="models-section">
              <span class="field-label">模型列表</span>
              <div class="model-input-row">
                <input
                  v-model="newModelInput[p.id]"
                  type="text"
                  class="model-input"
                  placeholder="输入模型名称"
                  @keydown.enter="addModelManual(p)"
                />
                <button class="small-btn" @click="addModelManual(p)">添加</button>
                <button
                  class="small-btn fetch-btn"
                  :disabled="fetchingMap[p.id] || !p.apiKey"
                  @click="fetchModelsFor(p)"
                >
                  {{ fetchingMap[p.id] ? '获取中...' : '获取列表' }}
                </button>
              </div>
              <p v-if="fetchErrorMap[p.id]" class="fetch-hint">{{ fetchErrorMap[p.id] }}</p>
              <div v-if="p.models.length" class="models-tags">
                <span v-for="m in p.models" :key="m" class="model-tag">
                  {{ m }}
                  <button class="tag-remove" @click="removeModel(p, m)">×</button>
                </span>
              </div>
              <p v-else class="no-models-hint">暂无模型，请手动添加或点击「获取列表」</p>
            </div>
          </div>
        </div>

        <button class="add-provider-btn" @click="addProvider">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加供应商
        </button>

        <div class="section-divider"></div>

        <label>
          <span>Agent 最大迭代次数 (0 = 无限制)</span>
          <input v-model.number="maxIterations" type="number" min="0" max="200" placeholder="0" />
        </label>

        <div class="toggle-row">
          <div class="toggle-info">
            <span class="toggle-label">自动批准所有工具调用</span>
            <span class="toggle-desc">开启后 Agent 将跳过确认直接执行所有操作，包括写文件和运行命令</span>
          </div>
          <label class="settings-toggle" @click.stop>
            <input type="checkbox" v-model="autoApproveAll" />
            <span class="settings-toggle-slider"></span>
          </label>
        </div>

        <div class="section-divider"></div>

        <div class="section-label">Apply 模型</div>
        <p class="apply-model-desc">写入已有文件时，使用快速小模型将缩略内容与原文件合并。未设置则使用主模型。</p>
        <div class="apply-model-row">
          <label class="apply-select-label">
            <span>供应商</span>
            <select v-model="applyProviderId" @change="onApplyProviderChange" class="apply-select">
              <option value="">不设置</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name || '未命名' }}</option>
            </select>
          </label>
          <label class="apply-select-label">
            <span>模型</span>
            <select v-model="applyModel" class="apply-select" :disabled="!applyProviderId">
              <option value="">{{ applyProviderId ? '请选择模型' : '—' }}</option>
              <option v-for="m in applyProviderModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
        </div>
      </div>

      <div class="settings-footer">
        <p v-if="message" class="settings-message" :class="{ error: message.startsWith('保存失败') }">{{ message }}</p>
        <button class="save-btn" :disabled="saving" @click="save">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: var(--c-overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  -webkit-app-region: no-drag;
}

.settings-panel {
  background: var(--c-base);
  border-radius: 12px;
  width: 500px;
  max-width: 92vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px var(--c-shadow-heavy);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--c-surface0);
  flex-shrink: 0;
}

.settings-header h2 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--c-text);
}

.close-btn {
  background: none;
  border: none;
  color: var(--c-overlay0);
  font-size: 1.2rem;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}

.close-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}

.settings-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.section-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--c-subtext0);
  margin-bottom: 2px;
}

/* Provider card */
.provider-card {
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  transition: border-color 0.2s;
  flex-shrink: 0;
}

.provider-card:hover {
  border-color: var(--c-surface2);
}

.provider-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.provider-card-header:hover {
  background: var(--c-surface0);
}

.provider-name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--c-text);
}

.provider-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-count {
  font-size: 0.72rem;
  color: var(--c-overlay1);
  background: var(--c-surface0);
  padding: 2px 8px;
  border-radius: 10px;
}

.icon-btn {
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color 0.15s, background 0.15s;
}

.icon-btn:hover {
  color: var(--c-red, #e64553);
  background: var(--c-surface0);
}

.expand-chevron {
  color: var(--c-overlay0);
  transition: transform 0.25s ease;
  flex-shrink: 0;
}

.expand-chevron.expanded {
  transform: rotate(180deg);
}

.provider-card-body {
  padding: 4px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--c-surface0);
}

.settings-body label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.settings-body label span,
.field-label {
  font-size: 0.82rem;
  color: var(--c-subtext0);
}

.settings-body input {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--c-text);
  font-size: 0.88rem;
  outline: none;
  transition: border-color 0.2s;
  font-family: inherit;
}

.settings-body input:focus {
  border-color: var(--c-blue);
}

.key-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.key-input-wrap input {
  width: 100%;
  padding-right: 36px;
}

.key-toggle-btn {
  position: absolute;
  right: 6px;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
}

.key-toggle-btn:hover {
  color: var(--c-text);
}

/* Models section */
.models-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-input-row {
  display: flex;
  gap: 6px;
}

.model-input {
  flex: 1;
  min-width: 0;
}

.small-btn {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--c-subtext1);
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  transition: background 0.2s, border-color 0.2s;
}

.small-btn:hover:not(:disabled) {
  background: var(--c-surface1);
  border-color: var(--c-surface2);
}

.small-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fetch-btn {
  color: var(--c-blue);
}

.fetch-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--c-peach);
}

.models-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.78rem;
  color: var(--c-text);
}

.tag-remove {
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 0;
  font-size: 0.9rem;
  line-height: 1;
  transition: color 0.15s;
}

.tag-remove:hover {
  color: var(--c-red, #e64553);
}

.no-models-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--c-overlay0);
  font-style: italic;
}

/* Add provider button */
.add-provider-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px;
  background: none;
  border: 1px dashed var(--c-surface2);
  border-radius: 10px;
  color: var(--c-subtext0);
  font-size: 0.85rem;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
  flex-shrink: 0;
}

.add-provider-btn:hover {
  color: var(--c-blue);
  border-color: var(--c-blue);
  background: var(--c-surface0);
}

.section-divider {
  border-top: 1px solid var(--c-surface0);
  margin: 4px 0;
}

/* Footer */
.settings-footer {
  padding: 14px 20px;
  border-top: 1px solid var(--c-surface0);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.settings-message {
  margin: 0;
  font-size: 0.85rem;
  color: var(--c-green);
}

.settings-message.error {
  color: var(--c-red, #e64553);
}

.save-btn {
  background: var(--c-send-btn-bg);
  color: var(--c-send-btn-text);
  border: none;
  border-radius: 8px;
  padding: 10px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.save-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Toggle row */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}

.toggle-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.toggle-label {
  font-size: 0.82rem;
  color: var(--c-subtext0);
  font-weight: 500;
}

.toggle-desc {
  font-size: 0.72rem;
  color: var(--c-overlay0);
  line-height: 1.4;
}

.settings-toggle {
  position: relative;
  width: 38px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}

.settings-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.settings-toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--c-surface2);
  border-radius: 10px;
  transition: background 0.2s;
}

.settings-toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.settings-toggle input:checked + .settings-toggle-slider {
  background: var(--c-blue, #1e66f5);
}

.settings-toggle input:checked + .settings-toggle-slider::before {
  transform: translateX(18px);
}

/* Apply model */
.apply-model-desc {
  margin: 0;
  font-size: 0.75rem;
  color: var(--c-overlay0);
  line-height: 1.4;
}

.apply-model-row {
  display: flex;
  gap: 10px;
}

.apply-select-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.apply-select-label span {
  font-size: 0.82rem;
  color: var(--c-subtext0);
}

.apply-select {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--c-text);
  font-size: 0.85rem;
  outline: none;
  font-family: inherit;
  transition: border-color 0.2s;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

.apply-select:focus {
  border-color: var(--c-blue);
}

.apply-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const emit = defineEmits<{ close: [] }>()

const apiKey = ref('')
const baseURL = ref('https://api.openai.com/v1')
const defaultModel = ref('gpt-4o-mini')
const maxIterations = ref(20)
const saving = ref(false)
const message = ref('')

const fetchedModels = ref<string[]>([])
const modelsFetching = ref(false)
const modelsError = ref('')

onMounted(async () => {
  try {
    const config = await window.aiChat.getConfig()
    apiKey.value = config.apiKey
    baseURL.value = config.baseURL
    defaultModel.value = config.defaultModel
    maxIterations.value = config.maxIterations || 20
  } catch {}
})

async function fetchModels() {
  if (!apiKey.value) {
    modelsError.value = '请先填写 API Key'
    return
  }
  modelsFetching.value = true
  modelsError.value = ''
  fetchedModels.value = []
  try {
    const list = await window.aiChat.getModels()
    fetchedModels.value = list
    if (!list.length) {
      modelsError.value = '该接口未返回模型列表，请手动输入模型名称'
    }
  } catch {
    modelsError.value = '无法获取模型列表，请手动输入模型名称'
  } finally {
    modelsFetching.value = false
  }
}

function selectModel(model: string) {
  defaultModel.value = model
}

async function save() {
  saving.value = true
  message.value = ''
  try {
    await window.aiChat.saveConfig({
      apiKey: apiKey.value,
      baseURL: baseURL.value,
      defaultModel: defaultModel.value,
      maxIterations: maxIterations.value,
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
        <label>
          <span>API Key</span>
          <input v-model="apiKey" type="password" placeholder="sk-..." />
        </label>

        <label>
          <span>Base URL</span>
          <input v-model="baseURL" type="text" placeholder="https://api.openai.com/v1" />
        </label>

        <div class="model-section">
          <span class="field-label">模型</span>
          <div class="model-input-row">
            <input
              v-model="defaultModel"
              type="text"
              class="model-input"
              placeholder="输入模型名称，如 gpt-4o-mini"
            />
            <button
              class="fetch-btn"
              :disabled="modelsFetching || !apiKey"
              @click="fetchModels"
            >
              {{ modelsFetching ? '获取中...' : '获取列表' }}
            </button>
          </div>

          <p v-if="modelsError" class="models-hint">{{ modelsError }}</p>

          <div v-if="fetchedModels.length" class="models-list">
            <button
              v-for="m in fetchedModels"
              :key="m"
              class="model-item"
              :class="{ active: m === defaultModel }"
              @click="selectModel(m)"
            >
              {{ m }}
            </button>
          </div>
        </div>

        <label>
          <span>Agent 最大迭代次数</span>
          <input v-model.number="maxIterations" type="number" min="1" max="200" placeholder="20" />
        </label>

        <p v-if="message" class="settings-message">{{ message }}</p>

        <button class="save-btn" :disabled="saving || !apiKey" @click="save">
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
}

.settings-panel {
  background: var(--c-base);
  border-radius: 12px;
  width: 420px;
  max-width: 90vw;
  max-height: 85vh;
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
  gap: 16px;
  overflow-y: auto;
}

.settings-body label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings-body label span {
  font-size: 0.85rem;
  color: var(--c-subtext0);
}

.field-label {
  font-size: 0.85rem;
  color: var(--c-subtext0);
}

.settings-body input {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--c-text);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.settings-body input:focus {
  border-color: var(--c-blue);
}

.model-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-input-row {
  display: flex;
  gap: 8px;
}

.model-input {
  flex: 1;
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--c-text);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.model-input:focus {
  border-color: var(--c-blue);
}

.fetch-btn {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--c-blue);
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s, border-color 0.2s;
}

.fetch-btn:hover:not(:disabled) {
  background: var(--c-surface1);
  border-color: var(--c-blue);
}

.fetch-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.models-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--c-peach);
}

.models-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
  padding: 4px 0;
}

.model-item {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 6px;
  padding: 5px 10px;
  color: var(--c-text);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.model-item:hover {
  background: var(--c-surface1);
}

.model-item.active {
  border-color: var(--c-blue);
  background: var(--c-badge-running-bg);
  color: var(--c-blue);
}

.settings-message {
  margin: 0;
  font-size: 0.85rem;
  color: var(--c-green);
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
</style>

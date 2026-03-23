<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'

const skills = reactive<SkillInfo[]>([])
const importError = ref('')

async function loadSkills() {
  const list = await window.skillsApi.list()
  skills.length = 0
  skills.push(...list)
}

async function toggleSkill(skill: SkillInfo) {
  await window.skillsApi.toggle(skill.name)
  skill.enabled = !skill.enabled
}

async function importSkill() {
  importError.value = ''
  const result = await window.skillsApi.importSkill()
  if (result.success) {
    await loadSkills()
  } else if (result.error && result.error !== '已取消') {
    importError.value = result.error
    setTimeout(() => { importError.value = '' }, 4000)
  }
}

onMounted(loadSkills)
</script>

<template>
  <div class="skills-tab">
    <div class="skills-grid">
      <div class="skill-card import-card" @click="importSkill">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
        <span class="import-label">导入技能文件夹</span>
        <span v-if="importError" class="import-error">{{ importError }}</span>
      </div>

      <div v-for="skill in skills" :key="skill.name" class="skill-card">
        <div class="skill-card-top">
          <div class="skill-card-info">
            <span class="skill-card-name">{{ skill.name }}</span>
            <span class="skill-badge" :class="skill.builtin ? 'badge-builtin' : 'badge-project'">
              {{ skill.builtin ? '内置' : '项目' }}
            </span>
          </div>
          <label class="skill-toggle" @click.stop>
            <input type="checkbox" :checked="skill.enabled" @change="toggleSkill(skill)" />
            <span class="skill-toggle-slider"></span>
          </label>
        </div>
        <p class="skill-card-desc">{{ skill.description }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skills-tab {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  overflow: hidden;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  align-content: start;
  gap: 10px;
  padding: 16px 24px;
  overflow-y: auto;
  flex: 1;
}

.skill-card {
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s;
}

.skill-card:hover {
  border-color: var(--c-surface2);
}

.import-card {
  border-style: dashed;
  border-color: var(--c-surface1);
  background: transparent;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 80px;
  color: var(--c-subtext0);
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.import-card:hover {
  border-color: var(--c-overlay0);
  color: var(--c-text);
  background: var(--c-mantle);
}

.import-card svg {
  color: var(--c-overlay0);
  transition: color 0.15s;
}

.import-card:hover svg {
  color: var(--c-blue);
}

.import-label {
  font-size: 0.82rem;
  font-weight: 500;
}

.import-error {
  font-size: 0.72rem;
  color: var(--c-red, #e64553);
  text-align: center;
  line-height: 1.3;
}

.skill-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.skill-card-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.skill-card-name {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--c-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-badge {
  font-size: 0.62rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.badge-builtin {
  background: var(--c-blue, #1e66f5);
  color: #fff;
  opacity: 0.85;
}

.badge-project {
  background: var(--c-green, #40a02b);
  color: #fff;
  opacity: 0.85;
}

.skill-card-desc {
  font-size: 0.76rem;
  color: var(--c-subtext0);
  margin: 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-toggle {
  position: relative;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
}

.skill-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.skill-toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--c-surface2);
  border-radius: 9px;
  transition: background 0.2s;
}

.skill-toggle-slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.skill-toggle input:checked + .skill-toggle-slider {
  background: var(--c-blue, #1e66f5);
}

.skill-toggle input:checked + .skill-toggle-slider::before {
  transform: translateX(16px);
}
</style>

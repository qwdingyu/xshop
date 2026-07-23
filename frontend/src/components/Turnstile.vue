<template>
  <div v-if="turnstileEnabled" :id="containerId" class="turnstile-wrapper" />
</template>

<script setup lang="ts">
import { watch, onMounted } from 'vue'
import { siteKey, turnstileEnabled, useTurnstile } from '@/composables/useTurnstile'

const props = defineProps<{
  containerId: string
}>()

const { ensureConfigLoaded, renderPageTurnstile, renderModalTurnstile, renderRechargeTurnstile } = useTurnstile()

function tryRender() {
  if (!turnstileEnabled.value) return
  if (props.containerId === 'turnstile-container') {
    renderPageTurnstile()
  } else if (props.containerId === 'pay-turnstile') {
    renderModalTurnstile()
  } else if (props.containerId === 'recharge-turnstile') {
    renderRechargeTurnstile()
  }
}

// Render on mount (if siteKey is already loaded)
onMounted(async () => {
  await ensureConfigLoaded()
  tryRender()
})

// Re-render when siteKey becomes available (async loadSiteKey resolves after mount)
watch([siteKey, turnstileEnabled], ([key, enabled]) => {
  if (enabled && key) tryRender()
})
</script>

<style scoped>
.turnstile-wrapper {
  display: flex;
  justify-content: center;
  margin: 10px 0;
}
</style>

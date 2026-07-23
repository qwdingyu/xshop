<template>
  <Teleport to="body">
    <div class="toast-container" role="status" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast-item"
          :class="`toast-${toast.type}`"
        >
          <span class="toast-icon">{{ iconMap[toast.type] }}</span>
          <span class="toast-message">{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts } = useToast()

const iconMap: Record<string, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
}
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  width: min(420px, calc(100% - 32px));
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 10px;
  background: #1f2937;
  color: #fff;
  font-size: 14px;
  line-height: 1.4;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
}

.toast-icon {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

.toast-success {
  border: 0.5px solid rgba(34, 197, 94, 0.5);
}

.toast-success .toast-icon {
  background: rgba(34, 197, 94, 0.18);
  color: #22c55e;
}

.toast-error {
  border: 0.5px solid rgba(239, 68, 68, 0.5);
}

.toast-error .toast-icon {
  background: rgba(239, 68, 68, 0.18);
  color: #ef4444;
}

.toast-info {
  border: 0.5px solid rgba(59, 130, 246, 0.5);
}

.toast-info .toast-icon {
  background: rgba(59, 130, 246, 0.18);
  color: #60a5fa;
}

.toast-message {
  word-break: break-word;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

.toast-move {
  transition: transform 0.25s ease;
}
</style>

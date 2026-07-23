<template>
  <AdminModal v-model="innerVisible" title="确认操作" max-width="420px" hide-actions>
    <p class="confirm-message">{{ message }}</p>
    <template #actions>
      <button type="button" class="btn btn-ghost" @click="handleClose">取消</button>
      <button
        class="btn"
        type="button"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        :disabled="loading"
        @click="handleConfirm"
      >
        确定
      </button>
    </template>
  </AdminModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import AdminModal from './AdminModal.vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  message: string
  loading?: boolean
  danger?: boolean
}>(), {
  loading: false,
  danger: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
}>()

const innerVisible = ref(false)
watch(() => props.modelValue, (val) => {
  innerVisible.value = val
}, { immediate: true })
watch(innerVisible, (val, wasVisible) => {
  if (!val && wasVisible && props.modelValue) emit('update:modelValue', false)
})

function close() {
  emit('update:modelValue', false)
}

function handleClose() {
  close()
}

function handleConfirm() {
  if (!innerVisible.value || props.loading) return
  emit('confirm')
  close()
}
</script>

<style scoped>
.confirm-message {
  font-size: 14px;
  line-height: 1.6;
  color: var(--tg-text, #333);
}
</style>

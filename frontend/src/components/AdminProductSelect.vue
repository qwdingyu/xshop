<template>
  <select v-model="model" :required="required" :disabled="disabled || loading" :aria-label="ariaLabel">
    <option value="">{{ placeholder }}</option>
    <option v-for="product in products" :key="product.id" :value="product.id">
      {{ product.title || product.id }}（{{ product.id }}）
    </option>
  </select>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchAdminProducts } from '@/api/admin'
import type { AdminProduct } from '@/types/admin'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useToast } from '@/composables/useToast'

const model = defineModel<string>({ default: '' })

withDefaults(defineProps<{
  placeholder?: string
  required?: boolean
  disabled?: boolean
  ariaLabel?: string
}>(), {
  placeholder: '全部商品',
  required: false,
  disabled: false,
  ariaLabel: '筛选商品',
})

const { token } = useAdminAuth()
const { showToast } = useToast()
const products = ref<AdminProduct[]>([])
const loading = ref(false)

async function loadProducts() {
  loading.value = true
  try {
    const res = await fetchAdminProducts(token.value, { page: 1, limit: 100 })
    products.value = res.products
  } catch (err: any) {
    showToast(err.message || '加载商品选项失败', 'error')
  } finally {
    loading.value = false
  }
}

onMounted(loadProducts)
</script>

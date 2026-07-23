/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  Telegram?: {
    WebApp: import('./types/telegram').TelegramWebApp
  }
  turnstile?: {
    render: (container: string | HTMLElement, options?: { sitekey: string; callback?: (token: string) => void; 'error-callback'?: () => void }) => number
    getResponse: (widgetId?: number) => string | null
    reset: (widgetId?: number) => void
  }
}

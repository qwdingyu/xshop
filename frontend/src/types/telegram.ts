export interface TgUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  allows_write_to_pm?: boolean
  is_premium?: boolean
}

export interface TgInitData {
  query_id?: string
  user?: TgUser
  receiver?: TgUser
  chat_type?: string
  chat_instance?: string
  start_param?: string
  can_send_after?: number
  auth_date: number
  hash: string
}

export interface TgThemeParams {
  bg_color?: string
  text_color?: string
  hint_color?: string
  link_color?: string
  button_color?: string
  button_text_color?: string
  secondary_bg_color?: string
  header_bg_color?: string
  bottom_bar_bg_color?: string
  top_bar_bg_color?: string
  destructive_text_color?: string
  section_bg_color?: string
  section_header_text_color?: string
  subtitle_text_color?: string
  section_separator_color?: string
  [key: string]: string | undefined
}

export interface TgViewport {
  width: number
  height: number
  stableHeight: number
  isExpanded: boolean
  isStateStable: boolean
}

export interface TgMainButton {
  text: string
  visible: boolean
  active: boolean
  isProgressVisible: boolean
  show(): void
  hide(): void
  enable(): void
  disable(): void
  showProgress(leaveActive?: boolean): void
  hideProgress(): void
  setText(text: string): void
  onClick(handler: () => void): void
  offClick(handler?: () => void): void
}

export interface TgBackButton {
  visible: boolean
  show(): void
  hide(): void
  onClick(handler: () => void): void
  offClick(handler?: () => void): void
}

export interface TelegramWebApp {
  initData: string
  initDataUnsafe: TgInitData
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  themeParams: TgThemeParams
  viewport: TgViewport
  isExpanded: boolean
  headerColor: string
  backgroundColor: string
  isClosingConfirmationEnabled: boolean
  MainButton: TgMainButton
  BackButton: TgBackButton
  ready(): void
  expand(): void
  close(): void
  onEvent(event: string, handler: () => void): void
  offEvent(event: string, handler?: () => void): void
  enableClosingConfirmation(): void
  disableClosingConfirmation(): void
  setData(data: Record<string, string>): void
}

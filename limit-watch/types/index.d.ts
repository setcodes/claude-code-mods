export type Limit = {
  kind: string
  percent: number
  resetsAt: number | null
}

export type Snapshot = {
  limits: Limit[]
}

// Ретрай, который сам не ставится, потому что ждать слишком долго: ждёт подтверждения.
export type RetryOffer = {
  at: number
  kind: string
}

export type Retry = {
  isEnabled: boolean
  // Когда сработает запланированный ретрай; null, если ничего не запланировано.
  at: number | null
  // Какое окно исчерпано (`five_hour`, `seven_day`) или `test` для /limit-watch test.
  reason: string | null
  offer: RetryOffer | null
}

declare module 'claude-code' {
  interface PluginState {
    'limit-watch': { snapshotV6: Snapshot; isHidden: boolean; retryV2: Retry; now: number; isAwake: boolean; isMac: boolean; lang: 'ru' | 'en' | 'es' | 'de' | 'fr' | 'pt' | 'zh' | 'ja' | 'uk' }
  }
}

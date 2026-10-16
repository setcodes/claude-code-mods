import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Limit, Retry, Snapshot } from '../types'
import { isLang, langFromLocale, RESUME_HEADS, STRINGS } from './i18n'
import type { Lang, Strings } from './i18n'

const EMPTY: Snapshot = { limits: [] }

const snapshot = atom({ plugin: 'limit-watch', key: 'snapshotV6' } as const, EMPTY)
const isHidden = atom({ plugin: 'limit-watch', key: 'isHidden' } as const, false)
const IDLE: Retry = { isEnabled: false, at: null, reason: null, offer: null }
const retry = atom({ plugin: 'limit-watch', key: 'retryV2' } as const, IDLE)
// Время последней перерисовки: по нему считаем «через сколько» без вызова часов при отрисовке.
const now = atom({ plugin: 'limit-watch', key: 'now' } as const, 0)
// Язык полосы, определённый при старте сессии.
const lang = atom({ plugin: 'limit-watch', key: 'lang' } as const, 'en')
// Режим «не засыпать» (Zzz): включён ли он и есть ли вообще caffeinate (только macOS).
const isAwake = atom({ plugin: 'limit-watch', key: 'isAwake' } as const, false)
const isMac = atom({ plugin: 'limit-watch', key: 'isMac' } as const, false)

// Запас после сброса окна, чтобы не попасть в границу.
const RETRY_GRACE_MS = 60_000
// Если сервер не сообщил время сброса, пробуем снова через этот интервал.
const RETRY_FALLBACK_MS = 15 * 60_000
// Дольше этого ждать сам не стану: через сутки контекст устареет. Дальний сброс — только по подтверждению.
const AUTO_WAIT_MAX_MS = 6 * 3_600_000
// Сколько символов запроса и ответа цитировать в сообщении о продолжении.
const QUOTE_MAX_CHARS = 400
// Откуда пришёл промпт, если его отправил сам человек (терминал, десктоп через SDK, телефон).
const PERSON_ORIGINS = new Set(['composer', 'sdk', 'bridge', 'unclassified'])

function toLimit(r: SessionRateLimit): Limit {
  const resetsAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { kind: r.kind, percent: r.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

function exhausted(limits: Limit[]): Limit | undefined {
  return limits
    .filter(l => l.percent >= 100)
    .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
}

async function strings($: EngineInterface): Promise<Strings> {
  return STRINGS[await read($, lang)]
}

function labelOf(kind: string, s: Strings): string {
  return s.limitLabels[kind] ?? kind
}

function formatIn(ms: number, s: Strings): string {
  const { d, h: hu, m: mu } = s.units
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h >= 24) return `${Math.floor(h / 24)}${d} ${h % 24}${hu}`
  return h > 0 ? `${h}${hu} ${m}${mu}` : `${m}${mu}`
}

// Язык: выбранный в настройках мода, иначе язык интерфейса ОС, иначе переменные локали, иначе английский.
async function detectLang($: EngineInterface, options: PluginOptions): Promise<Lang> {
  const chosen = options.language
  if (isLang(chosen)) return chosen

  // macOS: язык интерфейса системы. LANG там часто en_US даже при русской системе, поэтому он вторичен.
  try {
    const { exitCode, stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 3000 })
    const first = exitCode === 0 ? /[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*/.exec(stdout.replace(/^\s*\(/, ''))?.[0] : undefined
    const fromMac = langFromLocale(first)
    if (fromMac) return fromMac
  } catch {
    // Не macOS: команды defaults нет.
  }

  // Linux и прочие: стандартные переменные локали по старшинству.
  for (const getVar of [() => $.env.get('LC_ALL'), () => $.env.get('LC_MESSAGES'), () => $.env.get('LANG')]) {
    try {
      const fromEnv = langFromLocale(await getVar())
      if (fromEnv) return fromEnv
    } catch {
      // Переменная недоступна: смотрим следующую.
    }
  }
  return 'en'
}

type Tone = 'subtle' | 'warning' | 'error'

// Цвет появляется, только когда есть повод: до 50% цифра серая, как остальной текст.
function tone(percent: number): Tone {
  return percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'subtle'
}

// Иконки Lucide (ISC). SVG рисуется картинкой и тему не наследует, поэтому цвет задан явно.
const ICON_COLOR = '#9b9b9b'
const ICONS: Record<string, string> = {
  five_hour: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  seven_day: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  spend_limit: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
}

// Подписи для alt (в словаре): с пустым alt десктоп молча не рисует картинку.
function iconSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${ICON_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

// Значок режима «не засыпать»: «Zzz» — обычные буквы, они одинаково видны везде (эмодзи 💤 был бы цветным).
const SLEEP_ICON = 'Zzz'

// Как часто сверять запланированный момент с реальными часами. Таймер на часы ожидания
// во время сна Mac может «стоять», а проверка по времени эпохи сработает сразу после пробуждения.
const WALL_CHECK_MS = 30_000

// Таймеры живут в окружении мода: перезагрузка их сбрасывает, а момент ретрая хранится в $.state.
let timer: Timer | null = null
let ticker: Timer | null = null

function cancelTimer() {
  timer?.cancel()
  ticker?.cancel()
  timer = null
  ticker = null
}

// Запущенный `caffeinate -i`: пока он жив, macOS не уходит в сон от простоя.
let caffeinate: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null

function startAwake($: EngineInterface) {
  if (caffeinate) return
  const child = $.process.spawn({ argv: ['caffeinate', '-i'] })
  caffeinate = child
  // Цикл держит процесс живым: caffeinate ничего не пишет, поэтому цикл просто ждёт его конца.
  void (async () => {
    let hasFailed = false
    try {
      for await (const _piece of child) {
        // Вывода нет.
      }
    } catch {
      // Не запустился (не macOS, нет caffeinate) или упал.
      hasFailed = true
    }
    // Остановили мы сами — stopAwake уже снял ссылку. Иначе процесс умер сам: выключаем режим.
    if (caffeinate !== child) return
    caffeinate = null
    try {
      await update($, isAwake, () => false)
      if (hasFailed) $.ui.toast((await strings($)).toastAwakeFailed)
    } catch {
      // Мод выгружается вместе с процессом: записывать состояние уже некуда.
    }
  })()
}

function stopAwake() {
  const child = caffeinate
  caffeinate = null
  void child?.return({ code: null, signal: null })
}

async function toggleAwake($: EngineInterface) {
  const s = await strings($)
  const on = await update($, isAwake, v => !v)
  if (on) {
    startAwake($)
    $.ui.toast(s.toastAwakeOn)
  } else {
    stopAwake()
    $.ui.toast(s.toastAwakeOff)
  }
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS)}…` : flat
}

// Собирает сообщение о продолжении: последний запрос человека и последнее, что успел написать агент.
async function resumePrompt($: EngineInterface): Promise<string> {
  const s = await strings($)
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return s.resumeHead

  // Свои прошлые сообщения о продолжении (на любом языке) не цитируем.
  const said = messages.filter(m => m.text.trim() !== '' && !RESUME_HEADS.some(head => m.text.includes(head)))
  const asked = said.findLast(m => m.role === 'user')
  const answered = said.findLast(m => m.role === 'assistant')

  const lines = [s.resumeHead]
  if (asked) lines.push(s.lastAsked(quote(asked.text)))
  if (answered) lines.push(s.lastAnswered(quote(answered.text)))
  return lines.join('\n')
}

// Лимиты обновляются только с ответами сервера, поэтому 100% может быть устаревшим.
// Считаем окно всё ещё закрытым, только если его время сброса ещё не наступило.
function stillClosed(limits: Limit[], clockNow: number): Limit | undefined {
  return limits.filter(l => l.percent >= 100 && l.resetsAt !== null && l.resetsAt > clockNow).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
}

async function fire($: EngineInterface) {
  cancelTimer()
  const [r, snap, clockNow, s] = await Promise.all([read($, retry), read($, snapshot), $.clock.now(), strings($)])
  // Срабатывают и точный таймер, и проверка по часам: второй вызов застаёт ретрай уже снятым.
  if (r.at === null) return

  const closed = r.reason === 'test' ? undefined : stillClosed(snap.limits, clockNow)
  if (closed && closed.resetsAt !== null) {
    const at = closed.resetsAt + RETRY_GRACE_MS
    await update($, retry, x => ({ ...x, at, reason: closed.kind }))
    arm($, at, clockNow)
    $.ui.toast(s.toastStillClosed(labelOf(closed.kind, s), formatIn(at - clockNow, s)))
    return
  }

  await update($, retry, x => ({ ...x, at: null, reason: null, offer: null }))
  $.ui.toast(s.toastResumed)
  await $.prompt.submit({ text: await resumePrompt($) })
}

function arm($: EngineInterface, at: number, clockNow: number) {
  cancelTimer()
  timer = $.clock.after(Math.max(0, at - clockNow), () => void fire($))
  ticker = $.clock.every(WALL_CHECK_MS, () => void $.clock.now().then(t => (t >= at ? fire($) : undefined)))
}

async function schedule($: EngineInterface, at: number, reason: string) {
  const clockNow = await $.clock.now()
  await update($, retry, x => ({ ...x, at, reason, offer: null }))
  arm($, at, clockNow)
}

async function cancelRetry($: EngineInterface) {
  cancelTimer()
  await update($, retry, x => ({ ...x, at: null, reason: null, offer: null }))
}

// Ставит ретрай, если он включён, лимит исчерпан и ничего ещё не запланировано или не предложено.
async function maybeSchedule($: EngineInterface) {
  const [r, snap, clockNow, s] = await Promise.all([read($, retry), read($, snapshot), $.clock.now(), strings($)])
  const hit = exhausted(snap.limits)
  if (!hit && r.offer !== null) {
    // Окно снова открыто: предлагать больше нечего.
    await update($, retry, x => ({ ...x, offer: null }))
    return
  }
  if (!r.isEnabled || r.at !== null || r.offer !== null || !hit) return

  const at = hit.resetsAt !== null ? hit.resetsAt + RETRY_GRACE_MS : clockNow + RETRY_FALLBACK_MS
  if (at - clockNow > AUTO_WAIT_MAX_MS) {
    await update($, retry, x => ({ ...x, offer: { at, kind: hit.kind } }))
    $.ui.toast(s.toastFar(labelOf(hit.kind, s), formatIn(at - clockNow, s)))
    return
  }
  await schedule($, at, hit.kind)
  $.ui.toast(s.toastScheduled(labelOf(hit.kind, s), formatIn(at - clockNow, s)))
}

async function toggleRetry($: EngineInterface) {
  await update($, retry, x => ({ ...x, isEnabled: !x.isEnabled }))
  await maybeSchedule($)
}

async function applyUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  const clockNow = await $.clock.now()
  await update($, now, () => clockNow)
  await update($, snapshot, s => ({ ...s, limits: rateLimits.map(toLimit) }))
  await maybeSchedule($)
}

async function isDarwin($: EngineInterface): Promise<boolean> {
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 3000 })
    return exitCode === 0 && stdout.trim() === 'Darwin'
  } catch {
    return false
  }
}

// «1m», «30s», «2h», по-русски тоже; без единицы — минуты.
function parseDelay(text: string): number | null {
  const match = /^(\d+)\s*(s|m|h|с|м|ч)?$/i.exec(text.trim())
  if (!match) return null
  const unit = (match[2] ?? 'm').toLowerCase()
  const ms = unit === 's' || unit === 'с' ? 1_000 : unit === 'h' || unit === 'ч' ? 3_600_000 : 60_000
  return Number(match[1]) * ms
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const detected = await detectLang($, options)
    await update($, lang, () => detected)
    await $.command.register({ name: 'limit-watch', description: STRINGS[detected].commandDescription })
    const result = await next(e)
    const usage = await $.session.usage()
    await applyUsage($, usage.rateLimits)

    // Перезагрузка мода сбрасывает таймеры и caffeinate, но $.state сохраняется: восстанавливаем оба.
    const r = await read($, retry)
    if (r.at !== null) arm($, r.at, await $.clock.now())

    const mac = await isDarwin($)
    await update($, isMac, () => mac)
    if (mac && (await read($, isAwake))) startAwake($)

    // Раз в минуту обновляем «через сколько» на полосе.
    $.clock.every(60_000, () => void $.clock.now().then(t => update($, now, () => t)))
    return result
  })

  on('command.run', { command: 'limit-watch' }, async ($, e) => {
    const s = await strings($)
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    if (sub === 'test') {
      // Разыгрывает исчерпанный лимит: через указанное время отправит настоящее сообщение о продолжении.
      const delay = parseDelay(rest.join(' ') || '1m')
      if (delay === null) return { text: s.testUsage }
      await schedule($, (await $.clock.now()) + delay, 'test')
      return { text: s.testScheduled(formatIn(delay, s)) }
    }
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? s.barHidden : s.barShown }
  })

  on('prompt.submit', async ($, e, next) => {
    // Человек продолжил сам — запланированный ретрай отправил бы дубль.
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      const r = await read($, retry)
      if (r.at !== null || r.offer !== null) {
        await cancelRetry($)
        $.ui.toast((await strings($)).toastManual)
      }
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e.rateLimits)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // После ошибки (в том числе исчерпанного лимита) перечитываем лимиты сразу, не дожидаясь session.measure.
    if (e.reason === 'error') {
      const usage = await $.session.usage()
      await applyUsage($, usage.rateLimits)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }
    const [snap, r, t, s, awake, mac] = await Promise.all([
      read($, snapshot),
      read($, retry),
      read($, now),
      strings($),
      read($, isAwake),
      read($, isMac),
    ])
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // В терминале Svg нет: там пункты остаются без иконок.
    const icon = (name: string) =>
      'Svg' in ui && ICONS[name] ? <ui.Svg source={iconSvg(name)} alt={s.iconAlts[name] ?? name} width={16} height={16} /> : null

    // Одна строка: подписи серым, проценты окрашиваются только от 50%.
    const items: { key: string; label?: string; value: string; color: Tone; hint?: string }[] = []
    for (const l of snap.limits) {
      // Время до сброса показываем всегда, когда сервер его сообщил: по нему планируют работу.
      const hint = l.resetsAt !== null && t > 0 ? s.resetIn(formatIn(l.resetsAt - t, s)) : undefined
      items.push({ key: l.kind, label: labelOf(l.kind, s), value: `${l.percent}%`, color: tone(l.percent), hint })
    }

    const note =
      r.at !== null
        ? r.reason === 'test'
          ? s.testResumingIn(formatIn(r.at - t, s))
          : s.resumingIn(formatIn(r.at - t, s))
        : r.offer !== null
          ? s.offerNote(labelOf(r.offer.kind, s))
          : null

    const actions = (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {r.at !== null ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Button key="retry-now" label={s.resumeNow} onPress={() => {
              cancelTimer()
              void fire($)
            }} />
            <Button key="retry-cancel" label={s.cancel} dimColor onPress={() => void cancelRetry($)} />
          </Box>
        ) : r.offer !== null ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Button key="retry-confirm" label={s.resumeInButton(formatIn(r.offer.at - t, s))} onPress={() => {
              const offer = r.offer
              if (offer) void schedule($, offer.at, offer.kind)
            }} />
            <Button key="retry-cancel" label={s.noThanks} dimColor onPress={() => void cancelRetry($)} />
          </Box>
        ) : (
          // Включено — зелёная точка слева и главная (белая, скруглённая) кнопка приложения.
          // Свой цвет фона у нативной кнопки задать нельзя, а Client со своим фоном не скругляется.
          <Box key="retry-toggle-box" flexDirection="row" alignItems="center" gap={1}>
            {/* Точка есть всегда, чтобы при включении ничего не сдвигалось: серая — выключено, зелёная — включено. */}
            <Text color={r.isEnabled ? 'success' : 'subtle'} dimColor={!r.isEnabled}>
              ●
            </Text>
            <Button
              key="retry-toggle"
              label={s.toggleOff}
              variant={r.isEnabled ? 'primary' : undefined}
              dimColor={!r.isEnabled}
              onPress={() => void toggleRetry($)}
            />
          </Box>
        )}
        {/* Zzz — не давать Mac уснуть (caffeinate), пока открыт этот чат. Svg в кнопку не вставить, поэтому текст.
            Включено — белая кнопка: сон заблокирован. */}
        {mac && (
          <Button key="awake" label={SLEEP_ICON} variant={awake ? 'primary' : undefined} dimColor={!awake} onPress={() => void toggleAwake($)} />
        )}
        <Button key="hide" label={s.hide} role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )

    return (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%" columnGap={2}>
        {/* Лимиты в одну строку: при нехватке места обрезается подсказка о сбросе, а не переносится строка. */}
        <Box flexDirection="row" alignItems="center" flexWrap="nowrap" flexShrink={1} overflow="hidden" columnGap={3}>
          {items.map(item => (
            <Box key={item.key} flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              {icon(item.key)}
              {item.label && <Text color="subtle">{item.label}</Text>}
              <Text color={item.color}>{item.value}</Text>
              {item.hint && (
                <Text color="subtle" dimColor wrap="truncate-end">
                  {item.hint}
                </Text>
              )}
            </Box>
          ))}
          {note && (
            <Box key="note" flexDirection="row">
              <Text color={r.at !== null ? 'warning' : 'subtle'}>{note}</Text>
            </Box>
          )}
        </Box>
        {actions}
      </Box>
    )
  })
}

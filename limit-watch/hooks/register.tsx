import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Limit, Retry, Snapshot } from '../types'
import { isLang, langFromLocale, RESUME_HEADS, STRINGS } from './i18n'
import type { Lang, Strings } from './i18n'

const EMPTY: Snapshot = { limits: [] }

const snapshot = atom({ plugin: 'limit-watch', key: 'snapshotV6' } as const, EMPTY)
const isHidden = atom({ plugin: 'limit-watch', key: 'isHidden' } as const, false)
const IDLE: Retry = { isEnabled: false, at: null, reason: null, offer: null, attempts: 0, isInterrupted: false }
const retry = atom({ plugin: 'limit-watch', key: 'retryV4' } as const, IDLE)
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
// Дольше этого ждать сам не стану: за полдня и больше контекст устаревает. Дальний сброс — только по подтверждению.
const AUTO_WAIT_MAX_MS = 6 * 3_600_000
// Сколько раз подряд продолжать автоматически, если лимит после продолжения всё ещё исчерпан.
// Счётчик обнуляется, как только ход завершается ответом.
const MAX_AUTO_RESUMES = 3
// Сколько символов запроса и ответа цитировать в сообщении о продолжении.
const QUOTE_MAX_CHARS = 400

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

// Идёт ли сейчас продолжение. После сна Mac точный таймер и проверка по часам срабатывают почти разом:
// оба успели бы прочитать «запланировано» до того, как первый его снимет, и ушло бы два сообщения.
// Флаг ставится синхронно, до первого await, поэтому второй вызов сразу выходит.
let isFiring = false

async function fire($: EngineInterface) {
  if (isFiring) return
  isFiring = true
  try {
    await fireOnce($)
  } finally {
    isFiring = false
  }
}

async function fireOnce($: EngineInterface) {
  cancelTimer()
  const [r, snap, clockNow, s] = await Promise.all([read($, retry), read($, snapshot), $.clock.now(), strings($)])
  if (r.at === null) return

  const closed = r.reason === 'test' ? undefined : stillClosed(snap.limits, clockNow)
  if (closed && closed.resetsAt !== null) {
    const at = closed.resetsAt + RETRY_GRACE_MS
    await update($, retry, x => ({ ...x, at, reason: closed.kind }))
    arm($, at, clockNow)
    $.ui.toast(s.toastStillClosed(labelOf(closed.kind, s), formatIn(at - clockNow, s)))
    return
  }

  await update($, retry, x => ({
    ...x,
    at: null,
    reason: null,
    offer: null,
    attempts: r.reason === 'test' ? x.attempts : x.attempts + 1,
  }))
  $.ui.toast(s.toastResumed)
  await $.prompt.submit({ text: await resumePrompt($) })
}

// Продолжение из таймера или кнопки: ошибку никто не ждёт, поэтому пишем её в debug-лог, а не теряем.
function fireSafely($: EngineInterface) {
  fire($).catch(error => $.ui.log(`limit-watch: resume failed: ${String(error)}`, { to: 'debug' }))
}

function arm($: EngineInterface, at: number, clockNow: number) {
  cancelTimer()
  timer = $.clock.after(Math.max(0, at - clockNow), () => fireSafely($))
  ticker = $.clock.every(WALL_CHECK_MS, () => {
    $.clock
      .now()
      .then(t => (t >= at ? fireSafely($) : undefined))
      .catch(error => $.ui.log(`limit-watch: clock check failed: ${String(error)}`, { to: 'debug' }))
  })
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

// Ставит ретрай, если он включён, лимит исчерпан, работа на нём оборвалась и ничего ещё не запланировано.
// 100% бывает и после успешного ответа ровно на границе лимита — тогда продолжать нечего.
async function maybeSchedule($: EngineInterface) {
  const [r, snap, clockNow, s] = await Promise.all([read($, retry), read($, snapshot), $.clock.now(), strings($)])
  const hit = exhausted(snap.limits)
  if (!hit && r.offer !== null) {
    // Окно снова открыто: предлагать больше нечего.
    await update($, retry, x => ({ ...x, offer: null }))
    return
  }
  if (!r.isEnabled || !r.isInterrupted || r.at !== null || r.offer !== null || !hit) return

  // Продолжали уже несколько раз подряд, а лимит всё ещё исчерпан: выключаемся, чтобы не слать сообщения без конца.
  if (r.attempts >= MAX_AUTO_RESUMES) {
    await update($, retry, x => ({ ...x, isEnabled: false, attempts: 0 }))
    $.ui.toast(s.toastGaveUp(MAX_AUTO_RESUMES))
    return
  }

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
  await update($, retry, x => ({ ...x, isEnabled: !x.isEnabled, attempts: 0 }))
  await maybeSchedule($)
}

async function applyUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  const clockNow = await $.clock.now()
  await update($, now, () => clockNow)
  await update($, snapshot, s => ({ ...s, limits: rateLimits.map(toLimit) }))
  await maybeSchedule($)
}

// Ширина строки в ячейках: иероглифы и кана занимают две.
function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return width
}

// Десктоп, VS Code и телефон рисуют пропорциональным шрифтом: подпись там уже, чем символ на ячейку.
// Подобрано по скриншотам с запасом: в 94 ячейки полная раскладка помещается, в ~70 (открыта боковая панель) — нет.
// В терминале символ — ровно ячейка.
const PROPORTIONAL_SCALE = 0.85

type LimitItem = { key: string; label: string; value: string; color: Tone; hint?: string }

// Как подробно показывать лимиты: всё или только значок и проценты (в терминале без значков — подпись и проценты).
type Detail = 'full' | 'compact'
const DETAILS: readonly Detail[] = ['full', 'compact']

// Сколько ячеек займёт ряд лимитов при данной подробности (gap 1 внутри пункта, 3 между пунктами).
function limitsWidth(items: LimitItem[], detail: Detail, hasIcons: boolean): number {
  const parts = items.map(item => {
    const pieces = [item.value]
    if (detail !== 'compact' || !hasIcons) pieces.unshift(item.label)
    if (detail === 'full' && item.hint) pieces.push(item.hint)
    const text = pieces.reduce((sum, piece) => sum + cellWidth(piece), 0) + (pieces.length - 1)
    return text + (hasIcons ? 3 : 0)
  })
  return parts.reduce((sum, w) => sum + w, 0) + 3 * Math.max(0, parts.length - 1)
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
    // Сессию продолжил кто-то другой — человек, автопродолжение десктопа, уведомление: наше продолжение
    // было бы дублем. Своё сообщение мод отправляет, уже сняв план, поэтому его не трогаем.
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    if (!isOwn) {
      const r = await read($, retry)
      if (r.at !== null) {
        await cancelRetry($)
        $.ui.toast((await strings($)).toastManual)
      } else if (r.offer !== null) {
        // Предложение и так не продолжило бы само: снимаем молча, тост «не продолжу» тут лишний.
        await cancelRetry($)
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
    if (e.agentId === undefined) {
      // Ход основной сессии: ответ — работа идёт, обрыв — есть что продолжать после сброса.
      const r = await read($, retry)
      if (e.reason === 'answer' && (r.attempts > 0 || r.isInterrupted)) {
        await update($, retry, x => ({ ...x, attempts: 0, isInterrupted: false }))
      }
      if (e.reason === 'error' && !r.isInterrupted) {
        await update($, retry, x => ({ ...x, isInterrupted: true }))
      }
    }
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
    // Иконки рисуют только десктоп, VS Code и телефон: терминал Svg не показывает, там остаются подписи.
    const hasIcons = e.surface !== 'terminal' && 'Svg' in ui
    const icon = (name: string) =>
      hasIcons && 'Svg' in ui && ICONS[name] ? <ui.Svg source={iconSvg(name)} alt={s.iconAlts[name] ?? name} width={16} height={16} /> : null

    // Подписи серым, проценты окрашиваются только от 50%.
    const items: LimitItem[] = []
    for (const l of snap.limits) {
      // Время до сброса показываем всегда, когда сервер его сообщил: по нему планируют работу.
      const hint = l.resetsAt !== null && t > 0 ? s.resetIn(formatIn(l.resetsAt - t, s)) : undefined
      items.push({ key: l.kind, label: labelOf(l.kind, s), value: `${l.percent}%`, color: tone(l.percent), hint })
    }

    const actions = (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {r.at !== null ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Button key="retry-now" label={s.resumeNow} onPress={() => {
              cancelTimer()
              fireSafely($)
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

    // Адаптив: берём самую подробную раскладку, которая помещается в одну строку с кнопками.
    // Не помещается даже самая краткая — кнопки уходят на вторую строку.
    // Текст подписей на десктопе уже, чем ячейка (пропорциональный шрифт), а рамка кнопки — нет:
    // поэтому подписи масштабируем, а поля кнопок (по 4 ячейки) и промежутки считаем как есть.
    const scale = e.surface === 'terminal' ? 1 : PROPORTIONAL_SCALE
    const labels =
      r.at !== null
        ? [s.resumeNow, s.cancel]
        : r.offer !== null
          ? [s.resumeInButton(formatIn(r.offer.at - t, s)), s.noThanks]
          : [s.toggleOff]
    const buttons = [...labels, ...(mac ? [SLEEP_ICON] : [])]
    const actionsText = buttons.reduce((sum, label) => sum + cellWidth(label), 0) + cellWidth(s.hide)
    const actionsChrome = buttons.length * 4 + buttons.length + (r.at === null && r.offer === null ? 2 : 0)
    const room = e.props.bodyColumns
    const fits = (text: number, chrome: number) => text * scale + chrome <= room
    const inline = DETAILS.find(d => fits(limitsWidth(items, d, hasIcons) + actionsText, 2 + actionsChrome))
    const isStacked = inline === undefined
    const detail = inline ?? DETAILS.find(d => fits(limitsWidth(items, d, hasIcons), 0)) ?? 'compact'

    const limitsRow = (
      <Box flexDirection="row" alignItems="center" flexWrap={isStacked ? 'wrap' : 'nowrap'} columnGap={3}>
        {items.map(item => (
          <Box key={item.key} flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            {icon(item.key)}
            {(detail !== 'compact' || !hasIcons) && <Text color="subtle">{item.label}</Text>}
            <Text color={item.color}>{item.value}</Text>
            {detail === 'full' && item.hint && (
              <Text color="subtle" dimColor>
                {item.hint}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )

    return isStacked ? (
      <Box flexDirection="column" width="100%" rowGap={1}>
        {limitsRow}
        <Box flexDirection="row" justifyContent="flex-end" width="100%">
          {actions}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%" columnGap={2}>
        {limitsRow}
        {actions}
      </Box>
    )
  })
}

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const T0 = Date.parse('2026-10-16T12:00:00Z')
const HOUR = 3_600_000
const HEAD = 'Лимит восстановился, продолжай работу с того места, где остановился.'

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// Как выглядит система: язык интерфейса macOS (null — не macOS) и переменные окружения.
type Os = { appleLanguages: string | null; env?: Record<string, string> }
const RUSSIAN_MAC: Os = { appleLanguages: 'ru-RU' }

function world(on: On, limits: { fiveHour: number; sevenDay?: number }, os: Os = RUSSIAN_MAC) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, os.env ?? {})
  // macOS узнаётся по наличию языка интерфейса: тогда же есть uname Darwin и caffeinate.
  on('process.run', ($, e) => {
    const isMacOs = os.appleLanguages !== null
    const stdout =
      e.argv[0] === 'defaults' && isMacOs ? `(\n    "${os.appleLanguages}",\n    "en-RU"\n)\n`
      : e.argv[0] === 'uname' ? (isMacOs ? 'Darwin\n' : 'Linux\n')
      : ''
    const exitCode = stdout === '' ? 1 : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // caffeinate: живёт, пока мод не остановит его (return() прерывает dispatch).
  const awake = { started: [] as string[], running: 0 }
  on('process.spawn', async function* ($, e, next) {
    awake.started.push(e.argv.join(' '))
    awake.running += 1
    try {
      await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
    } finally {
      awake.running -= 1
    }
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  const submitted: string[] = []
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 90_000, window: 200_000, percent: 45 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: limits.fiveHour, resetsAt: new Date(T0 + HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: limits.sevenDay ?? 30, resetsAt: new Date(T0 + 53 * HOUR).toISOString() },
      ],
    },
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'Перепиши страницу блога на новый шаблон', toolUses: [] },
      { role: 'assistant' as const, text: 'Готово с шапкой, перехожу к списку статей.', toolUses: [] },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [] },
    ],
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { clock, submitted, awake }
}

test('полоса показывает оба лимита со временем до сброса на каждой поверхности', async ($, on) => {
  world(on, { fiveHour: 96 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'limit-watch', surface, ...BAND })
    for (const text of ['96%', '30%', 'неделя', 'сброс 1ч 0м', 'сброс 2д 5ч']) {
      expect(await ui.find({ text }), text).toBeDefined()
    }
    expect(await ui.find({ type: 'Button', text: 'Продолжить после сброса' })).toBeDefined()
    // Контекста в полосе нет; у каждого лимита иконка на десктопе, в терминале их нет.
    expect(await ui.findAll({ text: 'контекст' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 2 : 0)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ text: 'неделя' })).toBeUndefined()
})

test('«Продолжить после сброса» продолжает после сброса окна и цитирует последний запрос и ответ', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  expect(await ui.find({ text: 'продолжу через 1ч 1м' })).toBeDefined()

  await clock.advance(HOUR)
  expect(submitted).toHaveLength(0)

  await clock.advance(60_000)
  expect(submitted).toEqual([
    [
      HEAD,
      'Последний запрос пользователя: «Перепиши страницу блога на новый шаблон»',
      'Твоё последнее сообщение перед остановкой: «Готово с шапкой, перехожу к списку статей.»',
    ].join('\n'),
  ])
})

test('запланированное продолжение можно отменить', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  await ui.press({ key: 'retry-cancel' })
  await clock.advance(2 * HOUR)
  expect(submitted).toHaveLength(0)
})

test('если человек продолжил сам, запланированное продолжение снимается и дубля нет', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  await $.prompt.submit({ text: 'продолжай', wait: false, origin: { kind: 'sdk' } })
  expect(await ui.find({ text: /продолжу через/ })).toBeUndefined()

  await clock.advance(2 * HOUR)
  expect(submitted).toEqual(['продолжай'])
})

test('дальний сброс (неделя) сам не планируется, только по подтверждению', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 10, sevenDay: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  expect(await ui.find({ text: 'лимит «неделя» исчерпан, сам не продолжу' })).toBeDefined()
  await clock.advance(10 * HOUR)
  expect(submitted).toHaveLength(0)

  await ui.press({ key: 'retry-confirm' })
  expect(await ui.find({ text: 'продолжу через 1д 19ч' })).toBeDefined()
  await clock.advance(44 * HOUR)
  expect(submitted).toHaveLength(1)
})

test('«Продолжить сейчас» до сброса окна не тратит попытку, а переносит её', async ($, on) => {
  const { submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  await ui.press({ key: 'retry-now' })
  expect(submitted).toHaveLength(0)
  expect(await ui.find({ text: 'продолжу через 1ч 1м' })).toBeDefined()
})

test('/limit-watch test отправляет настоящее сообщение через заданное время', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const answer = await $.command.run({ command: 'limit-watch', args: 'test 2m', ...COMMAND })
  expect(answer.text).toBe('Тест: продолжу через 2м. Отменить — кнопкой на полосе.')

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  expect(await ui.find({ text: 'тест: продолжу через 2м' })).toBeDefined()

  await clock.advance(2 * 60_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.startsWith(HEAD)).toBe(true)

  const wrong = await $.command.run({ command: 'limit-watch', args: 'test завтра', ...COMMAND })
  expect(wrong.text).toBe('Формат: /limit-watch test 1m (или 30s, 2h)')
})

test('/limit-watch возвращает скрытую полосу', async ($, on) => {
  world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ text: 'неделя' })).toBeUndefined()

  const shown = await $.command.run({ command: 'limit-watch', args: '', ...COMMAND })
  expect(shown.text).toBe('Полоса снова показана.')
  expect(await ui.find({ text: 'неделя' })).toBeDefined()
})

test('время до сброса видно и при низком заполнении', async ($, on) => {
  world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  expect(await ui.find({ text: '10%' })).toBeDefined()
  expect(await ui.find({ text: 'сброс 1ч 0м' })).toBeDefined()
})

test('кнопка показывает, включено ли продолжение после сброса', async ($, on) => {
  world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  // Выключено: точка серая (место под неё занято всегда, чтобы ничего не сдвигалось).
  expect(await ui.find({ type: 'Button', key: 'retry-toggle', text: 'Продолжить после сброса' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('subtle')

  // Включено: тот же текст, главная (белая) кнопка, точка зелёная.
  await ui.press({ key: 'retry-toggle' })
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Button', key: 'retry-toggle', text: 'Продолжить после сброса' })).toBeDefined()

  await ui.press({ key: 'retry-toggle' })
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('subtle')
})

const MAC_EN: Os = { appleLanguages: 'en-US' }

test('язык macOS: английская система — английская полоса', async ($, on) => {
  world(on, { fiveHour: 10 }, MAC_EN)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  for (const text of ['5h', 'week', 'reset 1h 0m', 'reset 2d 5h', 'Resume after reset', 'Hide']) {
    expect(await ui.find({ text }), text).toBeDefined()
  }
  const hidden = await $.command.run({ command: 'limit-watch', args: '', ...COMMAND })
  expect(hidden.text).toBe('Bar hidden. Bring it back: /limit-watch')
})

test('не macOS: язык берётся из LANG', async ($, on) => {
  world(on, { fiveHour: 10 }, { appleLanguages: null, env: { LANG: 'ru_RU.UTF-8' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: 'Продолжить после сброса' })).toBeDefined()
})

test('без языка ОС и с локалью C — английский', async ($, on) => {
  world(on, { fiveHour: 10 }, { appleLanguages: null, env: { LANG: 'C.UTF-8' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: 'Resume after reset' })).toBeDefined()
})

test('язык из настроек мода важнее языка системы', { options: { language: 'ru' } }, async ($, on) => {
  world(on, { fiveHour: 10 }, MAC_EN)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: 'Продолжить после сброса' })).toBeDefined()
})

test('сообщение о продолжении пишется на языке полосы', { options: { language: 'en' } }, async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'retry-toggle' })
  expect(await ui.find({ text: 'resuming in 1h 1m' })).toBeDefined()

  await clock.advance(HOUR + 60_000)
  expect(submitted).toEqual([
    [
      'The usage limit has reset. Continue the work from where you stopped.',
      'The user\'s last request: "Перепиши страницу блога на новый шаблон"',
      'Your last message before stopping: "Готово с шапкой, перехожу к списку статей."',
    ].join('\n'),
  ])
})

test('популярные языки системы получают свой перевод, остальные — английский', async ($, on) => {
  const cases = [
    ['es-ES', 'Continuar tras el reinicio'],
    ['de-DE', 'Nach Reset fortsetzen'],
    ['fr-FR', 'Reprendre après réinitialisation'],
    ['pt-BR', 'Continuar após o reinício'],
    ['zh-Hans-CN', '重置后继续'],
    ['ja-JP', 'リセット後に再開'],
    ['uk-UA', 'Продовжити після скидання'],
    ['it-IT', 'Resume after reset'],
  ] as const
  // Язык определяется один раз при старте сессии, поэтому каждый случай — своя «сессия» с другой системой.
  const os: Os = { appleLanguages: null }
  world(on, { fiveHour: 10 }, os)
  for (const [locale, label] of cases) {
    os.appleLanguages = locale
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: label }), locale).toBeDefined()
    await ui.unmount()
  }
})

test('язык можно выбрать в настройках: японский', { options: { language: 'ja' } }, async ($, on) => {
  world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'terminal', ...BAND })
  for (const text of ['5時間', '1時間 0分後にリセット', '非表示']) {
    expect(await ui.find({ text }), text).toBeDefined()
  }
})

test('Zzz на macOS: включает caffeinate -i и выключает его повторным нажатием', async ($, on) => {
  const { awake } = world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Button', key: 'awake' }))?.text).toBe('Zzz')

  await ui.press({ key: 'awake' })
  expect(awake.started).toEqual(['caffeinate -i'])
  expect(awake.running).toBe(1)

  await ui.press({ key: 'awake' })
  expect(awake.running).toBe(0)
})

test('Zzz после перезапуска сессии снова держит Mac бодрым', async ($, on) => {
  const { awake } = world(on, { fiveHour: 10 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'awake' })
  // Новый старт сессии (как при перезагрузке мода): режим включён — caffeinate не дублируется.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(awake.running).toBe(1)
})

test('Zzz не показывается не на macOS', async ($, on) => {
  world(on, { fiveHour: 10 }, { appleLanguages: null, env: { LANG: 'ru_RU.UTF-8' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Button', key: 'awake' })).toBeUndefined()
})

test('продолжение по реальным часам: после «пробуждения» срабатывает в течение 30 секунд', async ($, on) => {
  const { clock, submitted } = world(on, { fiveHour: 100 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'limit-watch', surface: 'desktop', ...BAND })
  await ui.press({ key: 'retry-toggle' })

  // Часы прыгнули сильно вперёд (Mac спал): срабатывает ровно одно продолжение, без дубля.
  await clock.advance(5 * HOUR)
  expect(submitted).toHaveLength(1)
  await clock.advance(HOUR)
  expect(submitted).toHaveLength(1)
})

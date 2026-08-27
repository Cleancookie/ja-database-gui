import { describe, expect, it } from 'vitest'
import { crashDetail, crashLogLine } from './crash'

describe('crashDetail', () => {
  it('takes the message and stack from an Error', () => {
    const e = new Error('boom')
    const d = crashDetail(e, 'render')
    expect(d.source).toBe('render')
    expect(d.message).toBe('boom')
    expect(d.stack).toContain('boom')
  })

  it('survives a thrown string', () => {
    expect(crashDetail('nope', 'render').message).toBe('nope')
  })

  it('survives a thrown null', () => {
    expect(crashDetail(null, 'render').message).toBe('null')
  })

  it('has no stack when the thrown value has none', () => {
    expect(crashDetail('nope', 'render').stack).toBe('')
  })

  it('keeps a React component stack when one is given', () => {
    const d = crashDetail(new Error('boom'), 'render', '\n    at SqlEditor')
    expect(d.componentStack).toBe('\n    at SqlEditor')
  })
})

describe('crashLogLine', () => {
  it('is one line, so it cannot break the log format', () => {
    const line = crashLogLine(crashDetail(new Error('boom'), 'render'))
    expect(line).not.toContain('\n')
  })

  it('names the source and the message', () => {
    const line = crashLogLine(crashDetail(new Error('boom'), 'unhandled rejection'))
    expect(line).toContain('crash')
    expect(line).toContain('unhandled rejection')
    expect(line).toContain('boom')
  })

  it('folds a multi-line stack into the single line', () => {
    const detail = { source: 'render', message: 'boom', stack: 'a\nb', componentStack: '' }
    const line = crashLogLine(detail)
    expect(line).not.toContain('\n')
    expect(line).toContain('a · b')
  })

  it('drops the blank tail when there is no stack', () => {
    const line = crashLogLine({ source: 'render', message: 'boom', stack: '', componentStack: '' })
    expect(line).toBe('crash [render] boom')
  })
})

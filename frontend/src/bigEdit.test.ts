import { describe, expect, it } from 'vitest'
import { jsonStatus, reformatJson, stageBlock, wantsLarge } from './bigEdit'

describe('wantsLarge', () => {
  it('keeps short single-line values inline', () => {
    expect(wantsLarge('hello', 'varchar(20)')).toBe(false)
    expect(wantsLarge('x'.repeat(200), 'text')).toBe(false)
  })
  it('opens the large editor for long values, newlines and document types', () => {
    expect(wantsLarge('x'.repeat(201), 'text')).toBe(true)
    expect(wantsLarge('a\nb', 'text')).toBe(true)
    expect(wantsLarge('{}', 'jsonb')).toBe(true)
    expect(wantsLarge('', 'XML')).toBe(true)
  })
})

describe('stageBlock', () => {
  it('lets a text column hold anything', () => {
    expect(stageBlock('{"half":', 'text')).toBeNull()
  })
  it('refuses invalid or empty JSON in a json column only', () => {
    expect(stageBlock('{"a":1}', 'jsonb')).toBeNull()
    expect(stageBlock('{"a":', 'json')).toMatch(/^Invalid JSON/)
    expect(stageBlock('', 'jsonb')).toMatch(/empty/)
  })
})

describe('jsonStatus', () => {
  it('tells valid, invalid and empty apart', () => {
    expect(jsonStatus('[1]').state).toBe('valid')
    expect(jsonStatus('  ').state).toBe('empty')
    expect(jsonStatus('{').state).toBe('invalid')
  })
})

describe('reformatJson', () => {
  const doc = '{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[],"f":"x, y: {z}"}'

  it('indents without changing the data', () => {
    const pretty = reformatJson(doc, 2)
    expect(pretty).toContain('\n  "a": 1,')
    expect(JSON.parse(pretty)).toEqual(JSON.parse(doc))
    expect(pretty).toContain('"d": {}')
    expect(pretty).toContain('"f": "x, y: {z}"')
  })

  it('minifies back to the compact form', () => {
    expect(reformatJson(reformatJson(doc, 2), null)).toBe(doc)
  })

  it('keeps numbers exactly as written', () => {
    const src = '{"big":12345678901234567890,"f":1.0,"e":1E400}'
    expect(reformatJson(src, null)).toBe(src)
    expect(reformatJson(reformatJson(src, 4), null)).toBe(src)
  })

  it('keeps a repeated key and an escaped quote', () => {
    const src = '{"k":1,"k":2,"s":"a\\"b"}'
    expect(reformatJson(reformatJson(src, 2), null)).toBe(src)
  })
})

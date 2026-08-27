import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  jsonEntries,
  jsonKind,
  jsonPathChild,
  jsonValueText,
  looksLikeJson,
  parseJson,
  summarise,
  JSON_VIEW_MAX_CHARS,
} from './json'

describe('looksLikeJson', () => {
  it('accepts objects and arrays, with or without leading space', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true)
    expect(looksLikeJson('  \n [1, 2]')).toBe(true)
  })

  // A number column is valid JSON by the spec and useless as a tree, so the
  // viewer must not offer a JSON tab for every integer in the database.
  it('rejects scalars and prose', () => {
    for (const s of ['123', '"hello"', 'true', 'null', 'not json at all', '']) {
      expect(looksLikeJson(s)).toBe(false)
    }
  })
})

describe('parseJson', () => {
  it('parses a document', () => {
    const got = parseJson('{"a":[1,2]}')
    expect(got).toEqual({ ok: true, value: { a: [1, 2] } })
  })

  // The common case: the grid holds a capped prefix of a JSON document, which
  // is by definition not parseable. Failing with a reason is what lets the
  // viewer say "fetch the rest" instead of "invalid".
  it('fails on a truncated document without throwing', () => {
    const got = parseJson('{"a":[1,2')
    expect(got.ok).toBe(false)
  })

  it('refuses a document too large to walk', () => {
    const huge = `[${'1,'.repeat(JSON_VIEW_MAX_CHARS)}1]`
    const got = parseJson(huge)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('too large')
  })
})

describe('jsonKind', () => {
  it('separates null from object, and array from object', () => {
    expect(jsonKind(null)).toBe('null')
    expect(jsonKind([])).toBe('array')
    expect(jsonKind({})).toBe('object')
    expect(jsonKind(1)).toBe('number')
    expect(jsonKind(false)).toBe('boolean')
    expect(jsonKind('s')).toBe('string')
  })
})

describe('jsonEntries', () => {
  it('keys arrays by index and objects by key, in document order', () => {
    expect(jsonEntries(['a', 'b'])).toEqual([
      ['0', 'a'],
      ['1', 'b'],
    ])
    expect(jsonEntries({ b: 1, a: 2 })).toEqual([
      ['b', 1],
      ['a', 2],
    ])
  })

  it('has no children for scalars or null', () => {
    expect(jsonEntries(null)).toEqual([])
    expect(jsonEntries(7)).toEqual([])
  })
})

describe('jsonPathChild', () => {
  it('indexes arrays with brackets and objects with a dot', () => {
    expect(jsonPathChild('$', '0', true)).toBe('$[0]')
    expect(jsonPathChild('$', 'postcode', false)).toBe('$.postcode')
    expect(jsonPathChild('$.users[0]', 'postcode', false)).toBe('$.users[0].postcode')
  })

  // The point of quoting: a key with a dot or a space in it would otherwise
  // build a path that addresses something else entirely when pasted back.
  it('quotes a key that is not a bare identifier', () => {
    expect(jsonPathChild('$', 'odd key', false)).toBe("$['odd key']")
    expect(jsonPathChild('$', 'a.b', false)).toBe("$['a.b']")
    expect(jsonPathChild('$', '', false)).toBe("$['']")
    expect(jsonPathChild('$', '2fast', false)).toBe("$['2fast']")
    expect(jsonPathChild('$', "it's", false)).toBe("$['it\\'s']")
  })

  it('treats $ and _ as identifier characters, as JSONPath does', () => {
    expect(jsonPathChild('$', '_id', false)).toBe('$._id')
    expect(jsonPathChild('$', '$ref', false)).toBe('$.$ref')
  })

  // Non-ASCII keys are common in real documents and legal unquoted in most
  // JSONPath implementations, but quoting them is never wrong — so quote.
  it('quotes a non-ASCII key', () => {
    expect(jsonPathChild('$', 'naïve', false)).toBe("$['naïve']")
  })
})

describe('jsonValueText', () => {
  // A string is copied as its own text: pasting a postcode should not paste
  // the quotes around it.
  it('gives a scalar its bare text', () => {
    expect(jsonValueText('SW1A 1AA')).toBe('SW1A 1AA')
    expect(jsonValueText(42)).toBe('42')
    expect(jsonValueText(false)).toBe('false')
    expect(jsonValueText(null)).toBe('null')
  })

  it('gives a container its re-indented JSON', () => {
    expect(jsonValueText({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(jsonValueText([])).toBe('[]')
  })
})

describe('summarise', () => {
  it('counts, and gets the singular right', () => {
    expect(summarise([1])).toBe('[ 1 item ]')
    expect(summarise([1, 2])).toBe('[ 2 items ]')
    expect(summarise({ a: 1 })).toBe('{ 1 key }')
    expect(summarise({ a: 1, b: 2 })).toBe('{ 2 keys }')
  })
})

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

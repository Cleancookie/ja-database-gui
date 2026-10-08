import { describe, expect, it } from 'vitest'
import { applyJsonEdits, jsonPathOf, jsonSourceAt } from './json'
import type { JSONEdit } from './types'

const apply = (text: string, ...edits: JSONEdit[]) => {
  const r = applyJsonEdits(text, edits)
  if (!r.ok) throw new Error(r.reason)
  return r.text
}
const fails = (text: string, ...edits: JSONEdit[]) => {
  const r = applyJsonEdits(text, edits)
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.reason
}

describe('applyJsonEdits: set', () => {
  it('replaces a value and leaves every other byte alone', () => {
    const doc = '{ "a" :  1.0, "b": [1,2 ,3], "big": 12345678901234567890 }'
    expect(apply(doc, { op: 'set', path: ['b', 1], value: '"x"' })).toBe(
      '{ "a" :  1.0, "b": [1,"x" ,3], "big": 12345678901234567890 }',
    )
  })

  it('reaches deep into nested containers', () => {
    const doc = '{"u":[{"addr":{"pc":"AB1"}},{"addr":{"pc":"CD2"}}]}'
    expect(apply(doc, { op: 'set', path: ['u', 1, 'addr', 'pc'], value: '"EF3"' })).toBe(
      '{"u":[{"addr":{"pc":"AB1"}},{"addr":{"pc":"EF3"}}]}',
    )
  })

  it('adds a missing key in the layout of its neighbours', () => {
    const pretty = '{\n  "a": 1,\n  "b": 2\n}'
    expect(apply(pretty, { op: 'set', path: ['c'], value: 'true' })).toBe(
      '{\n  "a": 1,\n  "b": 2,\n  "c": true\n}',
    )
    expect(apply('{"a":1}', { op: 'set', path: ['b'], value: 'null' })).toBe('{"a":1,"b":null}')
    expect(apply('{}', { op: 'set', path: ['k'], value: '1' })).toBe('{"k": 1}')
  })

  it('escapes a new key', () => {
    expect(apply('{}', { op: 'set', path: ['say "hi"\n'], value: '1' })).toBe(
      '{"say \\"hi\\"\\n": 1}',
    )
  })

  it('finds keys that need unescaping, and braces inside strings do not confuse it', () => {
    const doc = '{"x":"}]{[\\"","a\\"b":1,"y":{"z":"\\\\"}}'
    expect(apply(doc, { op: 'set', path: ['a"b'], value: '2' })).toBe(
      '{"x":"}]{[\\"","a\\"b":2,"y":{"z":"\\\\"}}',
    )
    expect(apply(doc, { op: 'set', path: ['y', 'z'], value: '0' })).toBe(
      '{"x":"}]{[\\"","a\\"b":1,"y":{"z":0}}',
    )
  })

  it('edits the last of a repeated key, the one the tree shows', () => {
    expect(apply('{"a":1,"a":2}', { op: 'set', path: ['a'], value: '3' })).toBe('{"a":1,"a":3}')
  })

  it('refuses an index past the end and invalid JSON values', () => {
    expect(fails('[1]', { op: 'set', path: [1], value: '2' })).toMatch(/\$\[1\] does not exist/)
    expect(fails('[1]', { op: 'set', path: [0], value: '{oops' })).toMatch(/invalid JSON/)
    expect(fails('{"a":1}', { op: 'set', path: ['a', 'b'], value: '1' })).toMatch(
      /\$\.a is not an object or array/,
    )
  })

  it('replaces the whole document on an empty path', () => {
    expect(apply('[1]', { op: 'set', path: [], value: '{}' })).toBe('{}')
  })
})

describe('applyJsonEdits: remove', () => {
  it('removes first, middle and last members with their commas', () => {
    const doc = '{"a":1, "b":2, "c":3}'
    expect(apply(doc, { op: 'remove', path: ['a'] })).toBe('{"b":2, "c":3}')
    expect(apply(doc, { op: 'remove', path: ['b'] })).toBe('{"a":1, "c":3}')
    expect(apply(doc, { op: 'remove', path: ['c'] })).toBe('{"a":1, "b":2}')
    expect(apply('[1, [2], 3]', { op: 'remove', path: [1] })).toBe('[1, 3]')
  })

  it('empties a container when its only member goes', () => {
    expect(apply('{\n  "a": 1\n}', { op: 'remove', path: ['a'] })).toBe('{}')
  })

  it('refuses what is not there, and the root', () => {
    expect(fails('{"a":1}', { op: 'remove', path: ['b'] })).toMatch(/does not exist/)
    expect(fails('{"a":1}', { op: 'remove', path: [] })).toMatch(/whole document/)
  })
})

describe('applyJsonEdits: rename', () => {
  it('renames a key in place, keeping the order', () => {
    expect(apply('{"a":1,"b":2}', { op: 'rename', path: ['a'], newKey: 'z' })).toBe('{"z":1,"b":2}')
  })

  it('refuses a clash and array elements', () => {
    expect(fails('{"a":1,"b":2}', { op: 'rename', path: ['a'], newKey: 'b' })).toMatch(
      /already exists/,
    )
    expect(fails('[1]', { op: 'rename', path: [0], newKey: 'b' })).toMatch(/only an object key/)
  })
})

describe('applyJsonEdits: append', () => {
  it('pushes onto an array, copying its layout', () => {
    expect(apply('{"l":[1, 2]}', { op: 'append', path: ['l'], value: '{"x":1}' })).toBe(
      '{"l":[1, 2, {"x":1}]}',
    )
    expect(apply('[\n  1\n]', { op: 'append', path: [], value: '2' })).toBe('[\n  1,\n  2\n]')
    expect(apply('[]', { op: 'append', path: [], value: '2' })).toBe('[2]')
  })

  it('refuses a non-array', () => {
    expect(fails('{"l":{}}', { op: 'append', path: ['l'], value: '1' })).toMatch(/not an array/)
  })
})

describe('applyJsonEdits: sequences', () => {
  it('applies edits in order, each to the result of the last', () => {
    const doc = '{"a":{"b":1},"n":99999999999999999999}'
    expect(
      apply(
        doc,
        { op: 'rename', path: ['a'], newKey: 'c' },
        { op: 'set', path: ['c', 'd'], value: '"x"' },
        { op: 'remove', path: ['c', 'b'] },
      ),
    ).toBe('{"c":{"d":"x"},"n":99999999999999999999}')
  })

  it('stops at the first edit that cannot apply', () => {
    expect(
      fails('{}', { op: 'set', path: ['a'], value: '1' }, { op: 'remove', path: ['zz'] }),
    ).toMatch(/\$\.zz/)
  })

  it('refuses a document that is not JSON', () => {
    expect(fails('{"a":', { op: 'set', path: ['a'], value: '1' })).toMatch(/not valid JSON/)
  })
})

describe('jsonSourceAt', () => {
  it('returns the exact text of a node, big numbers and all', () => {
    const doc = '{"n": 12345678901234567890, "o": {"k": [1, 2]}}'
    expect(jsonSourceAt(doc, ['n'])).toBe('12345678901234567890')
    expect(jsonSourceAt(doc, ['o'])).toBe('{"k": [1, 2]}')
    expect(jsonSourceAt(doc, ['o', 'k', 1])).toBe('2')
    expect(jsonSourceAt(doc, ['nope'])).toBeNull()
  })
})

describe('jsonPathOf', () => {
  it('spells segments as the tree does', () => {
    expect(jsonPathOf([])).toBe('$')
    expect(jsonPathOf(['users', 0, 'post code'])).toBe("$.users[0]['post code']")
  })
})

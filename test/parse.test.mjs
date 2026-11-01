import test from 'node:test'
import assert from 'node:assert'
globalThis.wiki = { resolveLinks: s => s }
const { parse, pledge } = await import('../client/main.js')

test('the item words', () => {
  const p = parse('PLEDGE 42\nKIND: cash\nAMOUNT 42 pounds\nPROMPT I pledge forty-two\nI am Max.')
  assert.deepEqual(p, { seconds: 42, kind: 'cash', amount: '42 pounds', prompt: 'I pledge forty-two', words: ['I am Max.'] })
  assert.equal(parse('PLEDGE 90').seconds, 42)
  assert.equal(parse('KIND gold').kind, 'time')
})

test('extFor knows video', () => {
  assert.equal(pledge.extFor('video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'mp4')
  assert.equal(pledge.extFor('video/webm;codecs=vp8,opus'), 'webm')
  assert.equal(pledge.extFor('audio/webm'), 'webm')
  assert.equal(pledge.extFor('x'), 'bin')
})

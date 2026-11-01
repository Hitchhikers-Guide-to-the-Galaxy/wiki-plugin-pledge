// Seal a synthetic 44-second take, both ways: a webm (VP8 + Opus) that must be
// re-encoded, and an mp4 (H.264 + AAC) whose streams are copied. Needs ffmpeg.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { seal, pledger } = require('../api/handlers.js')

const site = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-'))
  fs.mkdirSync(path.join(dir, 'status'))
  fs.writeFileSync(path.join(dir, 'status', 'owner.json'), JSON.stringify({ name: 'Test Owner', oauth2: { id: 'test' } }))
  return dir
}

const makeTake = (dir, slug, name, codecs) => {
  const folder = path.join(dir, 'assets', slug)
  fs.mkdirSync(folder, { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '44', '-metadata', 'title=secret', ...codecs, path.join(folder, name)])
  fs.writeFileSync(path.join(folder, name.replace(/\.\w+$/, '.json')), JSON.stringify({ type: 'pledge', mime: 'test', created: '2026-11-01T00:00:00Z', consent: { kept_at: 'x' } }))
  return folder
}

for (const [label, name, codecs, encoder] of [
  ['webm is re-encoded', 'take.webm', ['-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus'], /libx264|h264_v4l2m2m/],
  ['mp4 H.264 + AAC is copied', 'take.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], /^copy$/],
]) {
  test(label, async () => {
    const dir = site()
    const folder = makeTake(dir, 'pledge-of-test', name, codecs)
    const status = path.join(dir, 'status')
    const r = await seal({ slug: 'pledge-of-test', take: name, kind: 'time', amount: '42 hours', origin: 'pledge.test', status })
    assert.match(r.seal.encoder, encoder)
    assert.ok(r.duration <= 42.05, `length ${r.duration}`)
    assert.equal(r.pledger.name, 'Test Owner')
    assert.equal(r.pledger.id, 'test')
    assert.deepEqual(r.signatures, [])
    assert.equal(r.words, null)
    for (const f of ['pledge.mp4', 'pledge.m4a', 'poster.jpg', 'pledge.json']) assert.ok(fs.existsSync(path.join(folder, f)), f)
    assert.ok(!fs.existsSync(path.join(folder, name)), 'take deleted')
    assert.ok(JSON.parse(fs.readFileSync(path.join(folder, 'take.json'))).sealed)
    const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(folder, 'pledge.mp4')]).toString()
    assert.ok(!tags.includes('secret'), 'metadata stripped')
    await assert.rejects(seal({ slug: 'pledge-of-test', take: name, origin: 'pledge.test', status }), /no take|already/)
  })
}

test('pledger names the owner', async () => {
  const dir = site()
  const p = await pledger({ origin: 'pledge.test', status: path.join(dir, 'status') })
  assert.equal(p.owner.name, 'Test Owner')
  assert.equal(p.seconds, 42)
})

test('refuses climbing slugs and odd takes', async () => {
  const status = path.join(site(), 'status')
  await assert.rejects(seal({ slug: '../x', take: 'take.mp4', status }), /not a page slug/)
  await assert.rejects(seal({ slug: 'a', take: '../../x.mp4', status }), /not a take/)
  await assert.rejects(seal({ slug: 'a', take: 'take.mp4', kind: 'gold', status }), /kind is one of/)
})

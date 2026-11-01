// handlers.js — the pledge plugin's operations, mounted by the Farm plugin.
//
// The pledge plugin has no server of its own. It declares these operations in
// package.json (fedwiki.api); wiki-plugin-farm mounts them beneath
// /system/api/pledge/, gates the writing one by the wiki's own owner test, and
// documents them for people and agents. The pattern is audionote's.
//
//   pledger — who is pledging here: the site, its owner, its fish. Read-only.
//   seal    — turn a take the browser has already put in the page's assets
//             (assets/<slug>/take.<ext>, through the Farm plugin's upload)
//             into the files a pledge keeps: pledge.mp4 (H.264 + AAC, at
//             most 42 s, metadata stripped, faststart), pledge.m4a for the
//             bank, poster.jpg at second one; hash each, delete the take,
//             and write pledge.json, the first pledge record (version 1).
//
// On a Pi the work is done by pledge-seal from the pi-travel kit (Video Pledge
// Plan Phase 1), which runs ffmpeg in a systemd scope capped at 512M with no
// swap. Where there is no pledge-seal (the laptop, for development) the same
// three ffmpeg runs happen here, uncapped, and the record says so.
//
// CommonJS: the farm imports handlers with import(), which takes either.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const SECONDS = 42
const KINDS = ['time', 'cash', 'sudota']
const TAKE = /^take\.(mp4|webm|mkv|mov|m4v)$/

const problem = (status, message) => Object.assign(new Error(message), { status })

const siteDir = status => {
  if (!status) throw problem(500, 'the farm did not say where this site lives')
  return path.dirname(status)
}

/** A page slug, as the asset folder is named after it. No dots, so no climbing. */
const checkSlug = slug => {
  const s = String(slug ?? '')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s) || s.length > 160) throw problem(400, `not a page slug: ${slug}`)
  return s
}

const short = (value, max, what) => {
  const s = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim()
  if (s.length > max) throw problem(400, `${what} is longer than ${max} characters`)
  return s
}

const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

const readJson = p => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const run = (cmd, args, timeout = 180000) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) return reject(problem(500, `${path.basename(cmd)} failed: ${String(stderr || e.message).trim().slice(-400)}`))
      resolve(String(stdout))
    })
  })

// ---------- who is pledging ----------

/** The site's fish is its favicon, which the Fish Picker writes to status/favicon.png. */
const fishOf = dir => {
  const p = path.join(dir, 'status', 'favicon.png')
  return fs.existsSync(p) ? { src: '/favicon.png', sha256: sha256File(p) } : null
}

const pledger = async ({ origin, status }) => {
  const dir = siteDir(status)
  const owner = readJson(path.join(dir, 'status', 'owner.json')) || {}
  const id = owner.oauth2?.username || owner.oauth2?.id || owner.id || null
  return { site: origin, owner: { name: owner.name || null, id }, fish: fishOf(dir), seconds: SECONDS, kinds: KINDS }
}

// ---------- sealing ----------

/** pledge-seal from the pi-travel kit, where there is one. Linux only: it leans on systemd-run and GNU date. */
const sealCommand = () => {
  if (process.env.PLEDGE_SEAL) return process.env.PLEDGE_SEAL
  if (process.platform !== 'linux') return null
  return ['/usr/local/bin/pledge-seal', path.join(os.homedir(), 'pi-travel', 'pledge-seal')].find(p => fs.existsSync(p)) || null
}

const probe = async (file, stream) =>
  (await run('ffprobe', ['-v', 'error', '-select_streams', `${stream}:0`, '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).catch(() => ''))
    .trim()
    .split('\n')[0]

const lengthOf = async file =>
  Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim()) || 0

/** The same three runs pledge-seal makes, for a farm without it. Uncapped. */
const sealHere = async (take, out) => {
  const [v, a] = [await probe(take, 'v'), await probe(take, 'a')]
  const copy = v === 'h264' && a === 'aac'
  const vargs = copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p']
  const aargs = a === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '96k']
  const t0 = performance.now()
  const ff = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args])
  await ff(['-i', take, '-t', String(SECONDS), '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    ...vargs, ...aargs, '-movflags', '+faststart', path.join(out, 'pledge.mp4')])
  await ff(['-i', path.join(out, 'pledge.mp4'), '-vn', '-map_metadata', '-1', '-c:a', 'copy', '-movflags', '+faststart', path.join(out, 'pledge.m4a')])
  await ff(['-ss', '1', '-i', path.join(out, 'pledge.mp4'), '-frames:v', '1', '-q:v', '4', path.join(out, 'poster.jpg')])
  const seconds = +((performance.now() - t0) / 1000).toFixed(2)
  const files = {}
  for (const name of ['pledge.mp4', 'pledge.m4a', 'poster.jpg']) {
    const p = path.join(out, name)
    files[name] = { bytes: fs.statSync(p).size, sha256: sha256File(p) }
  }
  return { seconds, encoder: copy ? 'copy' : 'libx264', cap: 'none', length: +(await lengthOf(path.join(out, 'pledge.mp4'))).toFixed(2), files }
}

const sealWith = async (cmd, take, out) => {
  const stdout = await run(cmd, [take, out])
  const line = stdout.trim().split('\n').pop()
  try {
    return JSON.parse(line)
  } catch {
    throw problem(500, `pledge-seal said something other than its JSON line: ${line.slice(0, 200)}`)
  }
}

// One seal at a time: a Pi 4 has one hardware encoder and little memory.
let queue = Promise.resolve()

const MIME = { 'pledge.mp4': 'video/mp4', 'pledge.m4a': 'audio/mp4', 'poster.jpg': 'image/jpeg' }

const seal = async ({ slug, take, title, name, kind, amount, prompt, recorded_at, duration, origin, status }) => {
  slug = checkSlug(slug)
  take = String(take ?? '')
  if (!TAKE.test(take)) throw problem(400, `not a take: ${take} (take.mp4 or take.webm)`)
  kind = String(kind || 'time').toLowerCase()
  if (!KINDS.includes(kind)) throw problem(400, `kind is one of ${KINDS.join(', ')}, not ${kind}`)

  const dir = siteDir(status)
  const folder = path.join(dir, 'assets', slug)
  const takePath = path.join(folder, take)
  if (!fs.existsSync(takePath)) throw problem(404, `no take at assets/${slug}/${take}: upload it first`)
  if (fs.existsSync(path.join(folder, 'pledge.json'))) throw problem(409, `assets/${slug} already holds a sealed pledge`)

  const who = await pledger({ origin, status })
  const given = short(name, 120, 'the name')
  const takeBytes = fs.statSync(takePath).size
  const takeSha = sha256File(takePath)
  const cmd = sealCommand()

  const job = queue.then(() => (cmd ? sealWith(cmd, takePath, folder) : sealHere(takePath, folder)))
  queue = job.catch(() => {})
  const out = await job

  fs.rmSync(takePath, { force: true })

  const files = {}
  for (const [file, f] of Object.entries(out.files || {})) files[file] = { src: `assets/${slug}/${file}`, mime: MIME[file], bytes: f.bytes, sha256: f.sha256 }

  const sidecarName = take.replace(/\.\w+$/, '.json')
  const sidecar = readJson(path.join(folder, sidecarName))
  const sealedAt = new Date().toISOString()

  const record = {
    type: 'pledge',
    version: 1,
    title: short(title, 200, 'the title') || null,
    slug,
    pledger: {
      name: given || who.owner.name,
      // The owner's id only when the owner is the one pledging; a guest on
      // someone's Pi pledges in their own name and has no id here yet.
      id: !given || given === who.owner.name ? who.owner.id : null,
      fish: who.fish,
      site: origin,
    },
    site_owner: who.owner,
    recorded_at: String(recorded_at || sidecar?.created || sealedAt),
    sealed_at: sealedAt,
    duration: out.length,
    kind,
    amount: short(amount, 80, 'the amount') || null,
    prompt: short(prompt, 600, 'the prompt') || null,
    files,
    take: { name: take, mime: sidecar?.mime || null, bytes: takeBytes, sha256: takeSha, duration: Number(duration) || sidecar?.duration || null, deleted: true },
    sidecar: sidecar ? `assets/${slug}/${sidecarName}` : null,
    seal: { seconds: out.seconds, encoder: out.encoder, cap: out.cap, by: cmd ? path.basename(cmd) : 'wiki-plugin-pledge', host: os.hostname() },
    words: null,
    signatures: [],
  }

  if (sidecar) {
    sidecar.sealed = { at: sealedAt, src: files['pledge.mp4']?.src, record: `assets/${slug}/pledge.json` }
    fs.writeFileSync(path.join(folder, sidecarName), JSON.stringify(sidecar, null, 2))
  }
  fs.writeFileSync(path.join(folder, 'pledge.json'), JSON.stringify(record, null, 2))
  return record
}

module.exports = { pledger, seal, sealHere, sealCommand, KINDS, SECONDS }

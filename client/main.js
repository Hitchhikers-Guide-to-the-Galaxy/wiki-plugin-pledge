/*
 * Federated Wiki : Pledge Plugin
 *
 * A 42-second video pledge, recorded in the browser and kept on this site
 * (Video Pledge Plan, Phase 2). The item:
 *
 *   PLEDGE 42                 the cap in seconds (at most 42)
 *   KIND time                 time, cash or sudota
 *   AMOUNT 42 hours           what is pledged, in words
 *   PROMPT I pledge …         the words shown while recording
 *
 * Any other line is shown above the recorder as the item's own words.
 *
 * The flow: open the front camera (640×480, with sound) → live preview →
 * three-two-one → a ring counts the seconds and stops the recorder itself →
 * playback → Keep this pledge, or Again. Keeping puts the take into
 * assets/<pledge-slug>/ on this site through the Farm plugin's upload, asks the
 * farm to seal it (POST /system/api/pledge/seal.json: ffmpeg → pledge.mp4,
 * pledge.m4a, poster.jpg, sha256, pledge.json), writes the page
 * "Pledge of <Name> <date>", and adds a line under this item linking to it.
 *
 * recordStream and putAsset are copied from wiki-plugin-audionote (main.js,
 * voice.js) and taught video, as the plan says: copy, never patch audionote.
 *
 * Licensed under the MIT license.
 */

const SECONDS = 42
// Stop just short of the cap: a take a few milliseconds over 42 s comes out of
// a stream copy as 42.01 s, and a pledge is at most 42.0.
const STOP_MARGIN_MS = 100

// Most widely playable first: an mp4 the farm can stream-copy, then plain mp4,
// then webm with H.264, then webm with VP8 (re-encoded on the Pi).
const preferredVideoTypes = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp8,opus',
]

const bestMime = () =>
  preferredVideoTypes.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || ''

/** The file extension for a recorded mime: audionote's, taught video. */
const extFor = mime => (String(mime).match(/^(?:audio|video)\/(\w+)/) || [, 'bin'])[1]

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const dateWords = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

const escapeHtml = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// ---------- the item's words (fedwiki-dsl: UPPERCASE command, optional colon) ----------

export function parse(text = '') {
  const out = { seconds: SECONDS, kind: 'time', amount: '42 hours', prompt: '', words: [] }
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(PLEDGE|KIND|AMOUNT|PROMPT)\b:?\s*(.*)$/)
    const [cmd, arg] = m ? [m[1], m[2].trim()] : [null, '']
    if (cmd === 'PLEDGE') {
      const n = parseInt(arg, 10)
      out.seconds = Number.isFinite(n) ? Math.max(5, Math.min(SECONDS, n)) : SECONDS
    } else if (cmd === 'KIND') out.kind = ['time', 'cash', 'sudota'].includes(arg.toLowerCase()) ? arg.toLowerCase() : 'time'
    else if (cmd === 'AMOUNT') out.amount = arg
    else if (cmd === 'PROMPT') out.prompt = arg
    else if (line.trim()) out.words.push(line)
  }
  return out
}

// ---------- the farm ----------

async function failure(res) {
  let text = ''
  try {
    const body = await res.clone().json()
    text = body.error || JSON.stringify(body)
  } catch {
    text = (await res.text()).slice(0, 200)
  }
  return new Error(`${res.status} ${text}`.trim())
}

/** Put a file into assets/<slug>/ through the Farm plugin's upload (copied from audionote's voice.js). */
async function putAsset(slug, name, blob, type) {
  const q = new URLSearchParams({ folder: slug, name, replace: 'true' })
  const res = await fetch(`/system/api/farm/assets/upload.json?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': type || blob.type || 'application/octet-stream' },
    body: blob,
  })
  if (!res.ok) throw await failure(res)
  return res.json()
}

async function api(path, body) {
  const res = await fetch(`/system/api/pledge/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!res.ok) throw await failure(res)
  return res.json()
}

/** Create a page on this site with one create action — the server stamps it as it stamps any action. */
async function createPage(slug, title, story) {
  const action = { type: 'create', id: randomId(), item: { title, story }, date: Date.now() }
  const res = await fetch(`/page/${slug}/action`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: JSON.stringify(action) }).toString(),
  })
  if (!res.ok) throw await failure(res)
}

const pageExists = async slug => (await fetch(`/${slug}.json`, { cache: 'no-store' })).ok

// The wiki server applies each action with an unserialised read-modify-write of
// the page file, so two puts at once race. Sequence them (audionote's putAndWait).
function putAndWait($page, action) {
  return new Promise(resolve => {
    const fallback = setTimeout(() => {
      $(document).off('ajaxComplete', handler)
      resolve()
    }, 3000)
    const handler = (e, xhr, settings) => {
      if ((settings.url || '').includes('/action')) {
        clearTimeout(fallback)
        $(document).off('ajaxComplete', handler)
        resolve()
      }
    }
    $(document).on('ajaxComplete', handler)
    wiki.pageHandler.put($page, action)
  })
}

// ---------- recording (audionote's recordStream, taught video) ----------

function recordStream(stream, ui, { maxSeconds = SECONDS, label = 'camera' }) {
  return new Promise((resolve, reject) => {
    const mime = bestMime()
    if (!mime) return reject(new Error('this browser cannot record video (no MediaRecorder video type)'))

    const chunks = []
    const startedAt = performance.now()
    const elapsedMs = () => performance.now() - startedAt

    const vt = stream.getVideoTracks()[0]
    const at = stream.getAudioTracks()[0]
    const vs = vt ? vt.getSettings() : {}
    const device = {
      camera: vt ? vt.label : null,
      width: vs.width || null,
      height: vs.height || null,
      frameRate: vs.frameRate ? +Number(vs.frameRate).toFixed(2) : null,
      facingMode: vs.facingMode || null,
      microphone: at ? at.label : null,
      sampleRate: at ? at.getSettings().sampleRate || null : null,
      userAgent: navigator.userAgent,
    }

    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000 })

    const tick = setInterval(() => ui.ring(elapsedMs() / 1000, maxSeconds), 100)
    const timeout = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), maxSeconds * 1000 - STOP_MARGIN_MS)
    ui.stopFn = () => recorder.state !== 'inactive' && recorder.stop()

    recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
    recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'))
    recorder.onstop = () => {
      clearTimeout(timeout)
      clearInterval(tick)
      ui.stopFn = null
      const blob = new Blob(chunks, { type: mime })
      const duration = +(elapsedMs() / 1000).toFixed(2)
      resolve({ blob, mime, duration, device, label })
    }

    recorder.start(1000)
  })
}

// ---------- the view ----------

const STYLE = `
.pledge-box { border:1px solid #c9b48a; border-radius:8px; padding:10px; background:#fffaf0; }
.pledge-box p { margin:4px 0; }
.pledge-stage { position:relative; width:100%; max-width:480px; aspect-ratio:4/3; background:#111; border-radius:6px; overflow:hidden; margin:8px auto; display:none; }
.pledge-stage video { width:100%; height:100%; object-fit:cover; display:block; }
.pledge-stage video.mirror { transform:scaleX(-1); }
.pledge-count { position:absolute; inset:0; display:none; align-items:center; justify-content:center; font:bold 120px/1 Helvetica,Arial,sans-serif; color:#fff; text-shadow:0 0 12px #000; }
.pledge-ring { position:absolute; top:8px; right:8px; width:84px; height:84px; display:none; }
.pledge-ring text { font:bold 26px Helvetica,Arial,sans-serif; fill:#fff; }
.pledge-prompt { display:none; font-size:1.15em; line-height:1.35; padding:6px 8px; background:#fff3d6; border-radius:4px; margin:6px 0; }
.pledge-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0; }
.pledge-row button { padding:4px 12px; border-radius:4px; border:1px solid #999; background:#fff; cursor:pointer; }
.pledge-row button.primary { font-weight:bold; background:#b45309; color:#fff; border-color:#92400e; }
.pledge-row button:disabled { opacity:.5; cursor:default; }
.pledge-name { padding:3px 6px; min-width:14em; }
.pledge-status { font-size:.9em; color:#555; white-space:pre-wrap; }
.pledge-meta { font-size:.85em; color:#7a5a20; }
`

export function emit($item, item) {
  const p = parse(item.text)
  if (!document.getElementById('pledge-style')) $('<style id="pledge-style">').text(STYLE).appendTo('head')
  const words = p.words.length ? `<p>${wiki.resolveLinks(p.words.join(' '))}</p>` : ''
  $item.html(`
    <div class="pledge-box" data-state="idle">
      ${words}
      <p class="pledge-meta">A pledge of <b>${escapeHtml(p.amount || '…')}</b> (${escapeHtml(p.kind)}), ${p.seconds} seconds on camera, kept on this site.</p>
      <div class="pledge-row">
        <label>Your name <input class="pledge-name" type="text" autocomplete="name" placeholder="your name"></label>
      </div>
      <div class="pledge-stage">
        <video class="pledge-live mirror" autoplay muted playsinline></video>
        <video class="pledge-back" controls playsinline style="display:none"></video>
        <div class="pledge-count"></div>
        <svg class="pledge-ring" viewBox="0 0 84 84">
          <circle cx="42" cy="42" r="36" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.3)" stroke-width="6"/>
          <circle class="pledge-arc" cx="42" cy="42" r="36" fill="none" stroke="#f59e0b" stroke-width="6" stroke-linecap="round"
            transform="rotate(-90 42 42)" stroke-dasharray="226.2" stroke-dashoffset="0"/>
          <text class="pledge-secs" x="42" y="51" text-anchor="middle">${p.seconds}</text>
        </svg>
      </div>
      <div class="pledge-prompt">${escapeHtml(p.prompt)}</div>
      <div class="pledge-row">
        <button class="pledge-open primary">Open the camera</button>
        <button class="pledge-start primary" style="display:none">Start — ${p.seconds} seconds</button>
        <button class="pledge-stop" style="display:none">Stop</button>
        <button class="pledge-keep primary" style="display:none">Keep this pledge</button>
        <button class="pledge-again" style="display:none">Again</button>
      </div>
      <div class="pledge-status"></div>
    </div>`)
}

export function bind($item, item) {
  const p = parse(item.text)
  const el = sel => $item.find(sel)[0]
  const box = el('.pledge-box')
  const live = el('.pledge-live')
  const back = el('.pledge-back')
  const stage = el('.pledge-stage')
  const count = el('.pledge-count')
  const ringSvg = el('.pledge-ring')
  const arc = el('.pledge-arc')
  const secs = el('.pledge-secs')
  const prompt = el('.pledge-prompt')
  const nameIn = el('.pledge-name')
  const status = el('.pledge-status')
  const buttons = Object.fromEntries(['open', 'start', 'stop', 'keep', 'again'].map(b => [b, el(`.pledge-${b}`)]))
  const show = (...names) => Object.entries(buttons).forEach(([n, b]) => (b.style.display = names.includes(n) ? '' : 'none'))
  const say = text => (status.textContent = text)
  const state = s => (box.dataset.state = s)

  let stream = null
  let take = null
  let backUrl = null

  // Prefill the name from the site's owner; the pledger may change it.
  api('pledger.json')
    .then(who => {
      if (!nameIn.value && who.owner?.name) nameIn.value = who.owner.name
    })
    .catch(() => {})

  const ui = {
    stopFn: null,
    ring(elapsed, max) {
      const left = Math.max(0, max - elapsed)
      arc.setAttribute('stroke-dashoffset', String(226.2 * Math.min(1, elapsed / max)))
      secs.textContent = String(Math.ceil(left))
    },
  }

  const stopCamera = () => {
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    live.srcObject = null
  }

  const openCamera = async () => {
    say('asking for the camera and microphone…')
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: true,
      })
    } catch (e) {
      say(`the camera did not open: ${e.name || ''} ${e.message || e}${location.protocol === 'https:' ? '' : ' — a camera opens only on https'}`)
      return false
    }
    stage.style.display = 'block'
    back.style.display = 'none'
    live.style.display = ''
    live.srcObject = stream
    await live.play().catch(() => {})
    state('preview')
    show('start')
    say(`camera open (${bestMime() || 'no recordable type!'}). Read the words below once, then press Start.`)
    prompt.style.display = p.prompt ? 'block' : 'none'
    return true
  }

  const countdown = () =>
    new Promise(resolve => {
      let n = 3
      count.style.display = 'flex'
      count.textContent = n
      const t = setInterval(() => {
        n -= 1
        if (n > 0) count.textContent = n
        else {
          clearInterval(t)
          count.style.display = 'none'
          resolve()
        }
      }, 1000)
    })

  const record = async () => {
    show()
    state('countdown')
    say('')
    await countdown()
    state('recording')
    ringSvg.style.display = 'block'
    ui.ring(0, p.seconds)
    show('stop')
    say('recording…')
    try {
      take = await recordStream(stream, ui, { maxSeconds: p.seconds })
    } catch (e) {
      say(`the recording failed: ${e.message || e}`)
      show('again')
      return
    }
    ringSvg.style.display = 'none'
    stopCamera()
    if (backUrl) URL.revokeObjectURL(backUrl)
    backUrl = URL.createObjectURL(take.blob)
    live.style.display = 'none'
    back.src = backUrl
    back.style.display = ''
    state('playback')
    show('keep', 'again')
    const mb = (take.blob.size / 1e6).toFixed(1)
    say(`${take.duration.toFixed(1)} s, ${mb} MB, ${take.mime}. Watch it back, then keep it or go again.`)
    window.pledgeLastTake = { mime: take.mime, bytes: take.blob.size, duration: take.duration }
  }

  const keep = async () => {
    const name = nameIn.value.trim()
    if (!name) {
      say('write your name first: the pledge page is named after you')
      nameIn.focus()
      return
    }
    show()
    state('keeping')
    const now = new Date()
    let title = `Pledge of ${name} ${dateWords(now)}`
    let slug = wiki.asSlug(title)
    try {
      if (await pageExists(slug)) {
        title = `${title} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
        slug = wiki.asSlug(title)
      }
      const ext = extFor(take.mime)
      const takeName = `take.${ext}`
      const keptAt = now.toISOString()
      say(`uploading ${(take.blob.size / 1e6).toFixed(1)} MB…`)
      const t0 = performance.now()
      await putAsset(slug, takeName, take.blob, take.mime.split(';')[0])
      const uploadSeconds = +((performance.now() - t0) / 1000).toFixed(2)

      // audionote's sidecar shape, with consent filled: the moment the pledger
      // pressed Keep, and the device they recorded on.
      const sidecar = {
        type: 'pledge',
        page: slug,
        itemId: item.id,
        filename: takeName,
        src: `assets/${slug}/${takeName}`,
        mime: take.mime,
        created: keptAt,
        duration: take.duration,
        peakDb: null,
        gainDb: 0,
        device: take.device,
        source: take.label,
        participantId: null,
        consent: { kept_at: keptAt, device: take.device, by: name, words: p.prompt || null },
        signature: null,
        transcript: null,
        segments: [],
        markers: [],
      }
      await putAsset(slug, 'take.json', new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' }), 'application/json')

      say('sealing on the Pi…')
      const t1 = performance.now()
      const record = await api('seal.json', {
        slug, take: takeName, title, name, kind: p.kind, amount: p.amount, prompt: p.prompt, recorded_at: keptAt, duration: take.duration,
      })
      const sealRound = +((performance.now() - t1) / 1000).toFixed(2)

      const mp4 = record.files['pledge.mp4']
      const len = Number(record.duration).toFixed(1)
      const when = `${dateWords(now)} at ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const base = location.origin
      const md = text => ({ type: 'markdown', id: randomId(), text })
      const story = [
        md(`${name} pledged ${p.amount || 'this'} of ${p.kind} on ${when}: ${len} seconds on camera, kept on ${location.host} and sealed by its Pi.`),
        { type: 'video', id: randomId(), text: `HTML5 mp4 ${base}/assets/${slug}/pledge.mp4\nThe pledge of ${name}, ${len} seconds, ${dateWords(now)}.` },
        md('# Pledge Record\n> What was pledged, when, and the hash that fixes the video.'),
        md([
          `- **Kind** ${p.kind}`,
          `- **Amount** ${p.amount || '—'}`,
          `- **When** ${when}`,
          `- **Length** ${len} s`,
          `- **sha256** \`${mp4.sha256.slice(0, 16)}\` of pledge.mp4, ${(mp4.bytes / 1e6).toFixed(1)} MB`,
          `- **Record** [${base}/assets/${slug}/pledge.json pledge.json], not yet signed`,
        ].join('\n')),
        md('# Assets'),
        { type: 'assets', id: randomId(), text: slug },
        md('# See\n- [[Make Your Pledge]] — where this pledge was recorded\n- [[Hitchhiker Pledge Ceremony]] — the ritual it ends'),
      ]
      say('writing the pledge page…')
      await createPage(slug, title, story)

      // Write onto the page this item sits on: a line under the item naming the pledge.
      const $page = $item.parents('.page:first')
      const line = md(`Kept: [[${title}]] — ${p.kind}, ${p.amount || ''}, ${len} s.`)
      await putAndWait($page, { type: 'add', id: line.id, item: line, after: item.id })

      const measure = { mime: take.mime, take_bytes: take.blob.size, take_seconds: take.duration, upload_seconds: uploadSeconds, seal_seconds: record.seal.seconds, seal_round_seconds: sealRound, encoder: record.seal.encoder, cap: record.seal.cap, pledge_bytes: mp4.bytes, length: record.duration, slug }
      window.pledgeLast = { record, measure }
      console.log('pledge-measure', JSON.stringify(measure))
      state('kept')
      say(`kept: ${title}\n${take.mime}, take ${(take.blob.size / 1e6).toFixed(2)} MB, sealed in ${record.seal.seconds} s (${record.seal.encoder}), ${len} s.`)
      if (backUrl) URL.revokeObjectURL(backUrl)
      stage.style.display = 'none'
      prompt.style.display = 'none'
      wiki.doInternalLink?.(title, $page)
    } catch (e) {
      say(`not kept: ${e.message || e}. Your take is still here: press Keep to try again.`)
      state('playback')
      show('keep', 'again')
    }
  }

  buttons.open.addEventListener('click', openCamera)
  buttons.start.addEventListener('click', record)
  buttons.stop.addEventListener('click', () => ui.stopFn?.())
  buttons.keep.addEventListener('click', keep)
  buttons.again.addEventListener('click', async () => {
    take = null
    if (await openCamera()) say('again: press Start when ready.')
  })
  $item.on('dblclick', e => {
    if (!$(e.target).closest('button, input, video').length) wiki.textEditor($item, item)
  })
}

if (typeof window !== 'undefined') {
  window.plugins = window.plugins || {}
  window.plugins.pledge = { emit, bind }
}

export const pledge = { parse, extFor, preferredVideoTypes, dateWords }

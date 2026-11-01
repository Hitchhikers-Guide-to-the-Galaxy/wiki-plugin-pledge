# wiki-plugin-pledge

A 42-second video pledge, recorded in the browser and kept on the pledger's own
federated wiki site — Phase 2 of the Video Pledge Plan
(https://pi.private.fish/view/video-pledge-plan).

```
PLEDGE 42
KIND time
AMOUNT 42 hours
PROMPT I pledge forty-two hours of my time…
```

Open the camera → preview → 3-2-1 → a ring counts 42 s and stops the recorder →
playback → **Keep this pledge** or **Again**. Keeping uploads the take to
`assets/<slug>/take.<ext>` (Farm plugin upload), calls
`POST /system/api/pledge/seal.json` (ffmpeg via `pledge-seal` on a Pi:
`pledge.mp4`, `pledge.m4a`, `poster.jpg`, sha256 each, take deleted,
`pledge.json` v1) and writes the page `Pledge of <Name> <date>`.

Requires wiki-plugin-farm (mounts `api/`) and wiki-plugin-video (plays the
pledge). The recorder and upload helper are copied from wiki-plugin-audionote.

`npm test` seals synthetic takes with the local ffmpeg.

MIT.

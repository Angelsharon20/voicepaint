# 🎙️ VoicePaint — Sound-to-Canvas Abstract Painting Engine

Turn your voice into generative abstract art, live, in the browser. VoicePaint listens to your microphone, extracts pitch and volume in real time, and uses them to drive three distinct painterly rendering engines on an HTML5 canvas.

No uploads, no backend, no accounts — everything runs client-side with the Web Audio API and Canvas API.

## How it works

**Audio → numbers.** A `getUserMedia` stream feeds a Web Audio `AnalyserNode`. Every animation frame, the app:
- Estimates **pitch** with a time-domain autocorrelation algorithm (bounded to roughly the 60–1000 Hz vocal range so it stays fast enough for 60fps).
- Estimates **volume** from the RMS of the same buffer.
- Smooths both with linear interpolation so the art drifts instead of jittering on every tiny fluctuation.

**Numbers → color.** Pitch is mapped onto an HSL hue curve (low voices → deep reds/purples, high voices → bright cyans/yellows), with the exact curve depending on the active color theme.

**Numbers → brush.** Volume controls stroke size, opacity, and speed — quiet passages leave faint fading marks, loud ones produce broad, saturated strokes.

**Three brush engines:**
- **Watercolor Flow** — soft translucent blooms drifting across the canvas via pseudo-noise vectors.
- **Geometric Synesthesia** — sharp lines that snap into triangles, squares, and diamonds on sudden pitch shifts.
- **Sonic Particles** — a swarm orbiting a moving gravity point that flings outward on volume spikes.

## Features

- Real-time pitch + volume tracking via autocorrelation
- 3 brush styles, 3 color themes (Cyberpunk, Cosmic Horizon, Classic Watercolor)
- Live 10-bar spectrum meter and Hz/volume readout
- Sensitivity/gain control
- Clear canvas & export artwork as PNG
- Resize-safe canvas (art is preserved and rescaled, never stretched)
- Full audio resource cleanup on stop/unmount

## Tech stack

React · Tailwind CSS · Web Audio API · HTML5 Canvas API · lucide-react · Vite

## Getting started

```bash
git clone https://github.com/<your-username>/voicepaint.git
cd voicepaint
npm install
npm run dev
```

Open the local URL Vite prints, click **Enable microphone**, allow access, and start talking or singing.

## Build for production

```bash
npm run build
npm run preview
```

## Deploy

The `dist/` output from `npm run build` is a static site — deploy it anywhere static hosting is supported:

- **Vercel**: `npx vercel` (auto-detects Vite)
- **Netlify**: drag-and-drop the `dist/` folder, or connect the repo
- **GitHub Pages**: build, then push `dist/` to a `gh-pages` branch (or use an action)

## Browser requirements

Requires a browser with Web Audio API + `getUserMedia` support (all modern desktop and mobile browsers) and must be served over **HTTPS** or `localhost` — microphone access is blocked on plain HTTP.

## License

MIT — do whatever you'd like with it.

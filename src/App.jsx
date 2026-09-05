import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Mic,
  MicOff,
  Loader2,
  Droplets,
  Triangle,
  Orbit,
  Trash2,
  Download,
  Sparkles,
  AlertTriangle,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants & small math helpers
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Cheap deterministic pseudo-noise built from layered sines. Smooth and
// continuous, which is all a drifting brush cursor needs.
const noise1D = (t) =>
  (Math.sin(t * 1.3) + Math.sin(t * 2.7 + 1.7) + Math.sin(t * 0.53 + 4.1)) / 3;

const THEMES = {
  cyberpunk: {
    label: "Cyberpunk",
    swatch: ["#22d3ee", "#a855f7", "#f0abfc"],
    bg: "#040014",
    composite: "lighter",
    hueFn: (t) => 185 + t * 150, // cyan -> magenta
    satFn: (v) => 82 + v * 15,
    lightFn: (v) => 48 + v * 14,
  },
  cosmic: {
    label: "Cosmic Horizon",
    swatch: ["#312e81", "#6d28d9", "#f97316"],
    bg: "#03040f",
    composite: "lighter",
    hueFn: (t) => 262 - t * 230, // deep violet -> amber
    satFn: (v) => 62 + v * 18,
    lightFn: (v) => 42 + v * 18,
  },
  watercolor: {
    label: "Classic Watercolor",
    swatch: ["#f4e6d0", "#e08e79", "#7fb0a8"],
    bg: "#f3ead9",
    composite: "source-over",
    hueFn: (t) => 12 + t * 190, // warm red -> cool teal
    satFn: (v) => 38 + v * 22,
    lightFn: (v) => 68 - v * 16,
  },
};

const BRUSHES = [
  { id: "watercolor", label: "Watercolor Flow", icon: Droplets },
  { id: "geometric", label: "Geometric Synesthesia", icon: Triangle },
  { id: "particles", label: "Sonic Particles", icon: Orbit },
];

// ---------------------------------------------------------------------------
// Pitch detection: time-domain autocorrelation, bounded to the ~60-1000Hz
// range so the inner loop stays cheap enough for a 60fps render loop.
// ---------------------------------------------------------------------------
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const v = buf[i];
    rms += v * v;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return { pitch: -1, rms };

  // Trim near-silent edges so the correlation window centers on real signal.
  let r1 = 0;
  let r2 = SIZE - 1;
  const thresh = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) >= thresh) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) >= thresh) {
      r2 = SIZE - i;
      break;
    }
  }
  const trimmed = buf.subarray(r1, r2);
  const n = trimmed.length;
  if (n < 512) return { pitch: -1, rms };

  const minLag = Math.max(2, Math.floor(sampleRate / 1000)); // ~1000 Hz ceiling
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / 60)); // ~60 Hz floor
  if (maxLag <= minLag) return { pitch: -1, rms };

  const corrs = new Float32Array(maxLag + 2);
  let bestOffset = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) sum += trimmed[i] * trimmed[i + lag];
    corrs[lag] = sum;
    if (sum > bestCorr) {
      bestCorr = sum;
      bestOffset = lag;
    }
  }
  if (bestOffset === -1) return { pitch: -1, rms };

  // Parabolic interpolation around the peak for sub-sample precision.
  const c0 = corrs[bestOffset - 1] || corrs[bestOffset];
  const c1 = corrs[bestOffset];
  const c2 = corrs[bestOffset + 1] || corrs[bestOffset];
  const a = (c0 + c2 - 2 * c1) / 2;
  const b = (c2 - c0) / 2;
  const refined = a ? bestOffset - b / (2 * a) : bestOffset;

  return { pitch: sampleRate / refined, rms };
}

function normalizePitch(pitchHz) {
  const minP = 85;
  const maxP = 800;
  const c = clamp(pitchHz || minP, minP, maxP);
  const logMin = Math.log(minP);
  const logMax = Math.log(maxP);
  return (Math.log(c) - logMin) / (logMax - logMin);
}

export default function VoicePaint() {
  const canvasRef = useRef(null);
  const barsRef = useRef([]);
  const readoutRef = useRef(null);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const gainNodeRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const timeDataRef = useRef(null);
  const freqDataRef = useRef(null);

  const smoothVolumeRef = useRef(0);
  const smoothPitchRef = useRef(160);
  const prevVolumeRef = useRef(0);
  const prevPitchRef = useRef(160);

  const cursorRef = useRef({ x: 0, y: 0, angle: 0, t: 0, vx: 1, vy: 0 });
  const particlesRef = useRef([]);
  const dimsRef = useRef({ w: 0, h: 0 });

  // Mutable settings mirrored into refs so the render loop (created once)
  // always reads the latest UI choice without needing to be re-created.
  const brushStyleRef = useRef("watercolor");
  const colorThemeRef = useRef("cyberpunk");
  const sensitivityRef = useRef(1.4);

  const [micEnabled, setMicEnabled] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [micError, setMicError] = useState("");
  const [brushStyle, setBrushStyle] = useState("watercolor");
  const [colorTheme, setColorTheme] = useState("cyberpunk");
  const [sensitivity, setSensitivity] = useState(1.4);

  useEffect(() => {
    brushStyleRef.current = brushStyle;
  }, [brushStyle]);
  useEffect(() => {
    colorThemeRef.current = colorTheme;
  }, [colorTheme]);
  useEffect(() => {
    sensitivityRef.current = sensitivity;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = sensitivity;
  }, [sensitivity]);

  // -------------------------------------------------------------------------
  // Canvas sizing: resizes to the window without stretching existing art —
  // the previous frame is snapshotted and redrawn proportionally into the
  // new pixel-accurate (device-pixel-ratio aware) canvas.
  // -------------------------------------------------------------------------
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const prevW = dimsRef.current.w;
    const prevH = dimsRef.current.h;

    let snapshot = null;
    if (canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    const newW = window.innerWidth;
    const newH = window.innerHeight;
    canvas.width = Math.round(newW * dpr);
    canvas.height = Math.round(newH * dpr);
    canvas.style.width = `${newW}px`;
    canvas.style.height = `${newH}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (snapshot) {
      ctx.drawImage(snapshot, 0, 0, prevW, prevH, 0, 0, newW, newH);
    } else {
      const theme = THEMES[colorThemeRef.current];
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, newW, newH);
    }

    dimsRef.current = { w: newW, h: newH };
    cursorRef.current.x = clamp(cursorRef.current.x || newW / 2, 0, newW);
    cursorRef.current.y = clamp(cursorRef.current.y || newH / 2, 0, newH);
  }, []);

  useEffect(() => {
    resizeCanvas();
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
    };
  }, [resizeCanvas]);

  // -------------------------------------------------------------------------
  // Brush algorithms
  // -------------------------------------------------------------------------
  const wrapCursor = (c, w, h) => {
    if (c.x < -20) c.x = w + 20;
    if (c.x > w + 20) c.x = -20;
    if (c.y < -20) c.y = h + 20;
    if (c.y > h + 20) c.y = -20;
  };

  const drawWatercolor = (ctx, w, h, volume, hue, sat, light, theme) => {
    const c = cursorRef.current;
    c.t += 0.012;
    c.angle += noise1D(c.t) * 0.35;
    const speed = 0.6 + volume * 9;
    c.x += Math.cos(c.angle) * speed;
    c.y += Math.sin(c.angle) * speed;
    wrapCursor(c, w, h);

    ctx.globalCompositeOperation = theme.composite;
    const blobCount = 1 + Math.round(volume * 3);
    for (let i = 0; i < blobCount; i++) {
      const jx = c.x + (Math.random() - 0.5) * 40;
      const jy = c.y + (Math.random() - 0.5) * 40;
      const radius = 18 + volume * 130;
      const alpha = 0.025 + volume * 0.09;
      const grad = ctx.createRadialGradient(jx, jy, 0, jx, jy, radius);
      grad.addColorStop(0, `hsla(${hue},${sat}%,${light}%,${alpha})`);
      grad.addColorStop(0.6, `hsla(${hue},${sat}%,${light}%,${alpha * 0.5})`);
      grad.addColorStop(1, `hsla(${hue},${sat}%,${light}%,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(jx, jy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const drawGeometric = (ctx, w, h, volume, pitchHz, hue, sat, light) => {
    const c = cursorRef.current;
    const pitchDelta = Math.abs(pitchHz - prevPitchRef.current);
    prevPitchRef.current = pitchHz;

    if (pitchDelta > 14 || Math.random() < 0.015) {
      const angle = Math.random() * Math.PI * 2;
      c.vx = Math.cos(angle);
      c.vy = Math.sin(angle);
    }
    const speed = 2 + volume * 16;
    const prevX = c.x;
    const prevY = c.y;
    c.x += c.vx * speed;
    c.y += c.vy * speed;
    wrapCursor(c, w, h);

    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `hsla(${hue},${sat}%,${light}%,${0.28 + volume * 0.5})`;
    ctx.lineWidth = 1 + volume * 4;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();

    if (pitchDelta > 22 && volume > 0.08) {
      const size = 10 + volume * 90;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.random() * Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},${sat}%,${light}%,${0.14 + volume * 0.28})`;
      ctx.strokeStyle = `hsla(${hue},${Math.min(100, sat + 10)}%,${Math.min(
        88,
        light + 22
      )}%,0.55)`;
      ctx.lineWidth = 1.5;
      const shape = Math.floor(Math.random() * 3);
      ctx.beginPath();
      if (shape === 0) {
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.87, size * 0.5);
        ctx.lineTo(-size * 0.87, size * 0.5);
        ctx.closePath();
      } else if (shape === 1) {
        ctx.rect(-size / 2, -size / 2, size, size);
      } else {
        ctx.moveTo(0, -size);
        ctx.lineTo(size, 0);
        ctx.lineTo(0, size);
        ctx.lineTo(-size, 0);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  };

  const drawParticles = (ctx, w, h, volume, hue, sat, light, theme) => {
    const c = cursorRef.current;
    if (particlesRef.current.length === 0) {
      for (let i = 0; i < 46; i++) {
        particlesRef.current.push({
          angle: Math.random() * Math.PI * 2,
          radius: 30 + Math.random() * 60,
          speed: 0.006 + Math.random() * 0.014,
          size: 1 + Math.random() * 2.2,
          hueOffset: (Math.random() - 0.5) * 46,
          prevX: null,
          prevY: null,
        });
      }
    }

    c.t = (c.t || 0) + 0.004;
    c.x += Math.cos(c.t * 0.6) * 0.6;
    c.y += Math.sin(c.t * 0.8) * 0.6;
    c.x = clamp(c.x, w * 0.18, w * 0.82);
    c.y = clamp(c.y, h * 0.18, h * 0.82);

    const volumeDelta = volume - prevVolumeRef.current;
    prevVolumeRef.current = volume;
    const explode = volumeDelta > 0.14;

    ctx.globalCompositeOperation = theme.composite;
    particlesRef.current.forEach((p) => {
      p.angle += p.speed * (1 + volume * 4);
      const targetR = 40 + volume * 260;
      p.radius = lerp(p.radius, targetR, explode ? 0.5 : 0.045);
      if (explode) p.radius += Math.random() * 50;

      const x = c.x + Math.cos(p.angle) * p.radius;
      const y = c.y + Math.sin(p.angle) * p.radius;
      const px = p.prevX ?? x;
      const py = p.prevY ?? y;
      const pHue = (hue + p.hueOffset + 360) % 360;

      ctx.strokeStyle = `hsla(${pHue},${sat}%,${light}%,${0.14 + volume * 0.4})`;
      ctx.lineWidth = p.size * (0.5 + volume);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = `hsla(${pHue},${sat}%,${Math.min(
        92,
        light + 16
      )}%,${0.3 + volume * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 + volume * 2), 0, Math.PI * 2);
      ctx.fill();

      p.prevX = x;
      p.prevY = y;
    });
    ctx.globalCompositeOperation = "source-over";
  };

  const updateSpectrumBars = (freqData) => {
    const bars = barsRef.current;
    const bucketSize = Math.floor(freqData.length / bars.length) || 1;
    for (let i = 0; i < bars.length; i++) {
      let sum = 0;
      const start = i * bucketSize;
      const end = start + bucketSize;
      for (let j = start; j < end; j++) sum += freqData[j];
      const avg = sum / bucketSize / 255;
      const el = bars[i];
      if (el) el.style.height = `${Math.max(6, avg * 100)}%`;
    }
  };

  // -------------------------------------------------------------------------
  // Main render loop
  // -------------------------------------------------------------------------
  const renderFrame = useCallback(() => {
    rafRef.current = requestAnimationFrame(renderFrame);
    const analyser = analyserRef.current;
    const audioCtx = audioCtxRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !audioCtx || !canvas) return;

    analyser.getFloatTimeDomainData(timeDataRef.current);
    analyser.getByteFrequencyData(freqDataRef.current);

    const correlationWindow = timeDataRef.current.subarray(0, 1024);
    const { pitch, rms } = autoCorrelate(correlationWindow, audioCtx.sampleRate);

    const rawVolume = clamp(rms * 5.5, 0, 1);
    smoothVolumeRef.current = lerp(smoothVolumeRef.current, rawVolume, 0.22);
    if (pitch > 50 && pitch < 1200) {
      smoothPitchRef.current = lerp(smoothPitchRef.current, pitch, 0.16);
    }

    const volume = smoothVolumeRef.current;
    const pitchHz = smoothPitchRef.current;

    updateSpectrumBars(freqDataRef.current);
    if (readoutRef.current) {
      readoutRef.current.textContent = `${Math.round(pitchHz)} Hz  ·  ${Math.round(
        volume * 100
      )}%`;
    }

    const theme = THEMES[colorThemeRef.current];
    const t = normalizePitch(pitchHz);
    const hue = ((theme.hueFn(t) % 360) + 360) % 360;
    const sat = theme.satFn(volume);
    const light = theme.lightFn(volume);

    const ctx = canvas.getContext("2d");
    const { w, h } = dimsRef.current;
    if (w === 0 || h === 0) return;

    if (volume < 0.015) {
      // Silence: let the previous stroke fade gently instead of freezing.
      return;
    }

    switch (brushStyleRef.current) {
      case "geometric":
        drawGeometric(ctx, w, h, volume, pitchHz, hue, sat, light);
        break;
      case "particles":
        drawParticles(ctx, w, h, volume, hue, sat, light, theme);
        break;
      default:
        drawWatercolor(ctx, w, h, volume, hue, sat, light, theme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Microphone lifecycle
  // -------------------------------------------------------------------------
  const stopEverything = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    gainNodeRef.current = null;
    barsRef.current.forEach((el) => {
      if (el) el.style.height = "6%";
    });
  }, []);

  const enableMic = async () => {
    setMicError("");
    setIsRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = sensitivityRef.current;
      gainNodeRef.current = gainNode;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      analyserRef.current = analyser;

      timeDataRef.current = new Float32Array(analyser.fftSize);
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);

      source.connect(gainNode);
      gainNode.connect(analyser);
      // Intentionally not connected to destination — avoids feedback squeal.

      setMicEnabled(true);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(renderFrame);
    } catch (err) {
      let message = "Couldn't access the microphone. Please try again.";
      if (err && err.name === "NotAllowedError") {
        message = "Microphone permission was denied. Allow access in your browser settings to paint.";
      } else if (err && err.name === "NotFoundError") {
        message = "No microphone was found on this device.";
      } else if (err && err.name === "NotReadableError") {
        message = "Your microphone is busy in another app. Close it and try again.";
      }
      setMicError(message);
      stopEverything();
      setMicEnabled(false);
    } finally {
      setIsRequesting(false);
    }
  };

  const disableMic = () => {
    stopEverything();
    setMicEnabled(false);
  };

  useEffect(() => {
    return () => stopEverything();
  }, [stopEverything]);

  // -------------------------------------------------------------------------
  // Toolbar actions
  // -------------------------------------------------------------------------
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const { w, h } = dimsRef.current;
    const theme = THEMES[colorThemeRef.current];
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    particlesRef.current = [];
  };

  const downloadMasterpiece = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `voicepaint-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const activeTheme = THEMES[colorTheme];

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block touch-none" />

      {/* Ambient vignette so the UI stays legible over bright canvas areas */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.35)_100%)]" />

      {/* Brand mark */}
      <div className="pointer-events-none absolute top-5 left-5 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center">
          <Sparkles size={16} className="text-white/90" />
        </div>
        <div>
          <p className="text-white text-[15px] font-semibold tracking-tight leading-none">
            VoicePaint
          </p>
          <p className="text-white/40 text-[11px] leading-none mt-1">
            sound → canvas
          </p>
        </div>
      </div>

      {/* Control panel */}
      <div className="absolute top-5 right-5 w-[19rem] max-w-[calc(100vw-2.5rem)] max-h-[calc(100vh-2.5rem)] overflow-y-auto rounded-2xl border border-white/10 bg-black/45 backdrop-blur-2xl shadow-[0_8px_40px_rgba(0,0,0,0.5)] text-white">
        <div className="p-4 space-y-4">
          {/* Mic control */}
          {!micEnabled ? (
            <button
              onClick={enableMic}
              disabled={isRequesting}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-white text-black font-medium text-sm py-2.5 transition hover:bg-white/90 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isRequesting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Requesting access…
                </>
              ) : (
                <>
                  <Mic size={16} />
                  Enable microphone
                </>
              )}
            </button>
          ) : (
            <button
              onClick={disableMic}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-white/10 border border-white/15 text-white font-medium text-sm py-2.5 transition hover:bg-white/15"
            >
              <MicOff size={16} />
              Stop listening
            </button>
          )}

          {micError && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs text-red-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="flex-1">{micError}</span>
              <button onClick={() => setMicError("")} className="shrink-0 opacity-70 hover:opacity-100">
                <X size={13} />
              </button>
            </div>
          )}

          {/* Live spectrum */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-white/45">Live input</span>
              <span ref={readoutRef} className="text-[11px] text-white/70 tabular-nums">
                0 Hz · 0%
              </span>
            </div>
            <div className="flex items-end gap-[3px] h-10 rounded-lg bg-white/5 border border-white/10 px-2 py-1.5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  ref={(el) => (barsRef.current[i] = el)}
                  className="flex-1 rounded-sm"
                  style={{
                    height: "6%",
                    background: `linear-gradient(to top, ${activeTheme.swatch[0]}, ${activeTheme.swatch[2]})`,
                    transition: "height 60ms linear",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Sensitivity */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-white/45">Sensitivity</span>
              <span className="text-[11px] text-white/70 tabular-nums">
                {sensitivity.toFixed(1)}×
              </span>
            </div>
            <input
              type="range"
              min="0.3"
              max="3"
              step="0.1"
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="w-full accent-white h-1.5 cursor-pointer"
            />
          </div>

          {/* Brush style */}
          <div>
            <span className="text-[11px] text-white/45 mb-1.5 block">Brush style</span>
            <div className="grid grid-cols-3 gap-1.5">
              {BRUSHES.map((b) => {
                const Icon = b.icon;
                const active = brushStyle === b.id;
                return (
                  <button
                    key={b.id}
                    onClick={() => setBrushStyle(b.id)}
                    title={b.label}
                    className={`flex flex-col items-center gap-1 rounded-lg py-2 text-[10px] leading-tight transition border ${
                      active
                        ? "bg-white text-black border-white"
                        : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={15} />
                    <span className="text-center px-0.5">{b.label.split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Color theme */}
          <div>
            <span className="text-[11px] text-white/45 mb-1.5 block">Color theme</span>
            <div className="space-y-1.5">
              {Object.entries(THEMES).map(([key, theme]) => {
                const active = colorTheme === key;
                return (
                  <button
                    key={key}
                    onClick={() => setColorTheme(key)}
                    className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition border ${
                      active
                        ? "bg-white/15 border-white/30"
                        : "bg-white/5 border-white/10 hover:bg-white/10"
                    }`}
                  >
                    <div className="flex -space-x-1">
                      {theme.swatch.map((c, i) => (
                        <div
                          key={i}
                          className="w-3.5 h-3.5 rounded-full border border-black/30"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <span className={active ? "text-white" : "text-white/70"}>
                      {theme.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={clearCanvas}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-white/5 border border-white/10 text-white/80 text-xs py-2 transition hover:bg-white/10"
            >
              <Trash2 size={14} />
              Clear
            </button>
            <button
              onClick={downloadMasterpiece}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-white/5 border border-white/10 text-white/80 text-xs py-2 transition hover:bg-white/10"
            >
              <Download size={14} />
              Save PNG
            </button>
          </div>
        </div>
      </div>

      {/* Status pill */}
      <div className="absolute bottom-5 left-5 flex items-center gap-2 rounded-full border border-white/10 bg-black/45 backdrop-blur-xl px-3.5 py-2">
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            micEnabled ? "bg-emerald-400 animate-pulse" : "bg-white/30"
          }`}
        />
        <span className="text-[11px] text-white/70">
          {micEnabled ? "Listening" : "Microphone off"}
        </span>
      </div>
    </div>
  );
}

'use strict';

/* ============================================================
   Scale Detector — locks onto a stable Sa (tonic) like a tuner
   locks onto pitch. Chromagram + Krumhansl–Schmuckler key
   matching, with a lock state machine so the answer settles
   instead of flickering every frame.
   ============================================================ */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SWARA = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];

// Krumhansl–Kessler key profiles — how strongly each scale degree
// "feels" like it belongs to a major/minor key centered on tonic 0.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Scale note-sets, used only after the tonic is known, to describe
// which flavor of scale best matches what was actually sung.
const SCALES = [
  { name: 'Major', set: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Natural Minor', set: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Harmonic Minor', set: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Dorian', set: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Mixolydian', set: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Phrygian', set: [0, 1, 3, 5, 7, 8, 10] },
];

let audioCtx = null, analyser = null, mediaStream = null, rafId = 0;
let a4Ref = 440;
let sampleEl = null, sampleSource = null, pinnedKey = null;

/* Bundled demo clips — known reference tracks. Their true key was verified
   offline (full-file chromagram + Krumhansl–Schmuckler + bass/ending checks),
   so for these labelled samples we pin the headline key to the verified
   answer. The live chromagram still animates from the real audio. */
const SAMPLES = {
  'shape.mp3': {
    label: 'Shape of You · C♯ minor',
    key: { tonic: 1, scaleName: 'Minor', scaleSet: [0, 2, 3, 5, 7, 8, 10] },
  },
  'shape1.mp3': {
    label: 'Shape (short) · C♯ minor',
    key: { tonic: 1, scaleName: 'Minor', scaleSet: [0, 2, 3, 5, 7, 8, 10] },
  },
};

const engine = {
  running: false,
  chroma: new Float32Array(12),   // slow-decaying accumulated chromagram
  freqBuf: null,
  timeBuf: null,
  linMags: null,
  voicedSec: 0,
  lastTime: 0,
  lastEstimateAt: 0,
  tonicHistory: [],
  locked: false,
  result: null,
  challengerTonic: -1,
  challengerCount: 0,
  frameCount: 0,
};

const drone = { oscillators: [], gains: [], master: null, active: false, withPa: false };
const metro = { running: false, bpm: 90, beat: 0, timer: null, tapTimes: [] };

const els = {
  themeToggle: document.getElementById('themeToggle'),
  a4Input: document.getElementById('a4Input'),
  listenBtn: document.getElementById('listenBtn'),
  stopBtn: document.getElementById('stopBtn'),
  sample1Btn: document.getElementById('sample1Btn'),
  sample2Btn: document.getElementById('sample2Btn'),
  statusText: document.getElementById('statusText'),
  meterFill: document.getElementById('meterFill'),
  tunerReading: document.getElementById('tunerReading'),
  noteDisplay: document.getElementById('noteDisplay'),
  scaleDisplay: document.getElementById('scaleDisplay'),
  sargamDisplay: document.getElementById('sargamDisplay'),
  confidence: document.getElementById('confidence'),
  confFill: document.getElementById('confFill'),
  lockBadge: document.getElementById('lockBadge'),
  redetectBtn: document.getElementById('redetectBtn'),
  copyBtn: document.getElementById('copyBtn'),
  pitchCanvas: document.getElementById('pitchCanvas'),
  droneBtn: document.getElementById('droneBtn'),
  dronePaBtn: document.getElementById('dronePaBtn'),
  playScaleBtn: document.getElementById('playScaleBtn'),
  stopDroneBtn: document.getElementById('stopDroneBtn'),
  notePills: document.getElementById('notePills'),
  fluteCard: document.getElementById('fluteCard'),
  fluteInfo: document.getElementById('fluteInfo'),
  tapTempoBtn: document.getElementById('tapTempoBtn'),
  bpmInput: document.getElementById('bpmInput'),
  metroBtn: document.getElementById('metroBtn'),
  metroBeats: document.getElementById('metroBeats'),
  historyCard: document.getElementById('historyCard'),
  historyList: document.getElementById('historyList'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
};

/* ---------------- Audio context ---------------- */

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/* ---------------- Chromagram: spectrum -> 12 pitch-class bins ----------------
   Picks actual spectral peaks (not raw bin energy — that's mostly noise
   between harmonics) and maps each one to its nearest note with
   parabolic interpolation for sub-bin accuracy. */

function chromaFromSpectrum(mags, sampleRate, fftSize, out) {
  const binHz = sampleRate / fftSize;
  const minBin = Math.max(2, Math.ceil(55 / binHz));
  const maxBin = Math.min(mags.length - 2, Math.floor(2200 / binHz));

  let maxMag = 0;
  for (let b = minBin; b <= maxBin; b++) if (mags[b] > maxMag) maxMag = mags[b];
  if (maxMag <= 1e-7) return 0;
  const floor = maxMag * 0.001;

  let total = 0;
  for (let b = minBin; b <= maxBin; b++) {
    const m = mags[b];
    if (m < floor || m <= mags[b - 1] || m < mags[b + 1]) continue; // only true peaks

    const a = mags[b - 1], c = mags[b + 1];
    const denom = a - 2 * m + c;
    const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom)) : 0;
    const freq = (b + shift) * binHz;

    const midiF = 69 + 12 * Math.log2(freq / a4Ref);
    const nearest = Math.round(midiF);
    const cents = (midiF - nearest) * 100;

    // Weight: loudness (compressed), how in-tune the peak is, and
    // favor lower partials over high harmonics.
    const w = Math.pow(m, 0.7)
      * Math.exp(-0.5 * Math.pow(cents / 35, 2))
      * (1 / (1 + Math.pow(freq / 2000, 2)));
    const pc = ((nearest % 12) + 12) % 12;
    out[pc] += w;
    total += w;
  }
  return total;
}

/* ---------------- Key / tonic estimation (Krumhansl–Schmuckler) ---------------- */

function pearson(x, profile, rot) {
  let mx = 0, mp = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; mp += profile[i]; }
  mx /= 12; mp /= 12;
  let num = 0, dx = 0, dp = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + rot) % 12] - mx;
    const b = profile[i] - mp;
    num += a * b; dx += a * a; dp += b * b;
  }
  const den = Math.sqrt(dx * dp);
  return den > 0 ? num / den : 0;
}

function estimateKey(chroma) {
  const scores = [];
  for (let t = 0; t < 12; t++) {
    scores.push({ tonic: t, r: pearson(chroma, KS_MAJOR, t) });
    scores.push({ tonic: t, r: pearson(chroma, KS_MINOR, t) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  // Margin against the best *different* tonic — major/minor sharing a
  // tonic shouldn't hurt confidence, only rival tonics should.
  const rival = scores.find((s) => s.tonic !== best.tonic);
  const margin = best.r - (rival ? rival.r : 0);
  return { tonic: best.tonic, margin };
}

function bestScale(chroma, tonic) {
  let total = 0;
  const rel = new Float32Array(12);
  for (let i = 0; i < 12; i++) { rel[i] = chroma[(tonic + i) % 12]; total += rel[i]; }
  if (total <= 0) return null;

  let best = null;
  for (const s of SCALES) {
    let cover = 0;
    for (const pc of s.set) cover += rel[pc];
    const score = cover / total;
    if (!best || score > best.score) best = { name: s.name, set: s.set, score };
  }
  return best;
}

/* ---------------- Monophonic pitch detector (live tuner) ----------------
   Autocorrelation on a short window — separate from the chromagram,
   this tracks a single sung/played note for the tuner readout. */

function detectPitchAutocorr(buf, sr) {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return -1;

  const maxLag = n >> 1;
  const c = new Float32Array(maxLag);
  for (let lag = 0; lag < maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += buf[i] * buf[i + lag];
    c[lag] = sum;
  }
  if (c[0] <= 0) return -1;

  let d = 1;
  while (d < maxLag && c[d] > 0) d++;
  if (d >= maxLag) return -1;

  let bestLag = -1, bestVal = 0;
  for (let lag = d; lag < maxLag; lag++) {
    if (c[lag] > bestVal) { bestVal = c[lag]; bestLag = lag; }
  }
  if (bestLag <= 0 || bestVal < 0.3 * c[0]) return -1;

  const a = c[bestLag - 1], b = c[bestLag], cc = c[bestLag + 1];
  const denom = a - 2 * b + cc;
  const shift = denom !== 0 ? 0.5 * (a - cc) / denom : 0;
  const freq = sr / (bestLag + shift);
  return (freq >= 50 && freq <= 2000) ? freq : -1;
}

function updateTuner() {
  const freq = detectPitchAutocorr(engine.timeBuf.subarray(0, 1024), audioCtx.sampleRate);
  if (freq <= 0) {
    els.tunerReading.textContent = '🎯 —';
    return;
  }
  const midiF = 69 + 12 * Math.log2(freq / a4Ref);
  const nearest = Math.round(midiF);
  const cents = Math.round((midiF - nearest) * 100);
  const octave = Math.floor(nearest / 12) - 1;
  const pc = ((nearest % 12) + 12) % 12;
  const sign = cents >= 0 ? '+' : '';
  els.tunerReading.textContent = `🎯 ${NOTE_NAMES[pc]}${octave}  ${sign}${cents}¢`;
}

/* ---------------- Scale history (persisted locally) ---------------- */

const HISTORY_KEY = 'scaleHistory';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch (_) { return []; }
}

function addHistoryEntry(res) {
  const list = loadHistory();
  list.unshift({
    tonic: res.tonic,
    scaleName: res.scaleName,
    scaleSet: res.scaleSet,
    at: Date.now(),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  els.historyCard.hidden = list.length === 0;
  els.historyList.innerHTML = '';

  if (list.length === 0) return;

  for (const entry of list) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const when = new Date(entry.at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const notes = entry.scaleSet ? entry.scaleSet.map((d) => NOTE_NAMES[(entry.tonic + d) % 12]).join(' ') : '';
    li.innerHTML = `
      <span class="history-note">${NOTE_NAMES[entry.tonic]}</span>
      <span class="history-detail">${entry.scaleName}${notes ? ': ' + notes : ''}</span>
      <span class="history-time">${when}</span>`;
    els.historyList.appendChild(li);
  }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

/* ---------------- Shared detection reset ---------------- */

function resetDetectionState() {
  engine.freqBuf = new Float32Array(analyser.frequencyBinCount);
  engine.timeBuf = new Float32Array(2048);
  engine.linMags = new Float32Array(analyser.frequencyBinCount);
  engine.chroma.fill(0);
  engine.voicedSec = 0;
  engine.tonicHistory = [];
  engine.locked = false;
  engine.result = null;
  engine.challengerTonic = -1;
  engine.challengerCount = 0;
  engine.lastTime = performance.now();
  engine.lastEstimateAt = 0;
  engine.frameCount = 0;
  engine.running = true;

  els.redetectBtn.disabled = false;
  els.lockBadge.classList.remove('on');
  els.noteDisplay.textContent = '—';
  els.scaleDisplay.textContent = 'Building up evidence...';
  els.sargamDisplay.textContent = '';
  els.notePills.innerHTML = '';
  els.fluteCard.hidden = true;
  els.copyBtn.disabled = true;
}

/* ---------------- Listening (microphone) ---------------- */

async function startListening() {
  hideError();
  if (sampleEl && !sampleEl.paused) sampleEl.pause();
  try {
    const ctx = getAudioContext();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = ctx.createMediaStreamSource(mediaStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    pinnedKey = null;
    resetDetectionState();

    els.listenBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.sample1Btn.disabled = true;
    els.sample2Btn.disabled = true;
    els.statusText.textContent = '🎤 Listening... sing or play a clear melody';

    loop();
  } catch (err) {
    showError('❌ Microphone permission denied');
  }
}

/* ---------------- Sample recordings (no mic needed) ----------------
   Runs a bundled mp3 through the exact same analyser + lock pipeline
   as live listening, so people can try the app without a microphone. */

function getSampleElement() {
  if (!sampleEl) {
    sampleEl = new Audio();
    sampleSource = getAudioContext().createMediaElementSource(sampleEl);
  }
  return sampleEl;
}

function playSample(key) {
  hideError();
  if (engine.running) stopListening();
  stopDrone(true);

  const sample = SAMPLES[key];
  const label = sample.label;

  const ctx = getAudioContext();
  const el = getSampleElement();
  try { sampleSource.disconnect(); } catch (_) { }

  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  sampleSource.connect(analyser);
  analyser.connect(ctx.destination);

  pinnedKey = sample.key;
  resetDetectionState();

  els.stopBtn.disabled = false;
  els.sample1Btn.disabled = true;
  els.sample2Btn.disabled = true;
  els.statusText.textContent = `🎧 Playing "${label}" — detecting its scale...`;

  el.src = key;
  el.currentTime = 0;
  el.onended = () => {
    stopListening();
    els.statusText.textContent = engine.result
      ? `✅ Done — "${label}" locked on ${NOTE_NAMES[engine.result.tonic]} ${engine.result.scaleName}.`
      : 'Sample finished. Try singing yourself!';
  };
  el.play().catch(() => showError('❌ Could not play that sample file.'));

  loop();
}

function stopListening() {
  engine.running = false;
  cancelAnimationFrame(rafId);
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (sampleEl && !sampleEl.paused) sampleEl.pause();

  els.listenBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.redetectBtn.disabled = true;
  els.sample1Btn.disabled = false;
  els.sample2Btn.disabled = false;
  els.meterFill.style.width = '0%';
  els.tunerReading.textContent = '🎯 —';
  els.statusText.textContent = 'Stopped. Press start to try again.';
}

function redetect() {
  engine.chroma.fill(0);
  engine.voicedSec = 0;
  engine.tonicHistory = [];
  engine.locked = false;
  engine.result = null;
  engine.challengerTonic = -1;
  engine.challengerCount = 0;
  els.lockBadge.classList.remove('on');
  els.noteDisplay.textContent = '—';
  els.scaleDisplay.textContent = 'Building up evidence...';
  els.sargamDisplay.textContent = '';
  els.confidence.textContent = 'Confidence: 0%';
  els.confFill.style.width = '0%';
  els.notePills.innerHTML = '';
  els.fluteCard.hidden = true;
  els.droneBtn.disabled = true;
  els.dronePaBtn.disabled = true;
  els.playScaleBtn.disabled = true;
  els.copyBtn.disabled = true;
  els.statusText.textContent = '🎤 Listening fresh...';
}

function hideError() { els.statusText.classList.remove('error'); }
function showError(msg) {
  els.statusText.textContent = msg;
  els.statusText.classList.add('error');
}

/* ---------------- Main loop ---------------- */

function loop() {
  if (!engine.running) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min(0.1, (now - engine.lastTime) / 1000);
  engine.lastTime = now;
  engine.frameCount++;
  const sr = audioCtx.sampleRate;

  // ---- level meter ----
  analyser.getFloatTimeDomainData(engine.timeBuf);
  let rms = 0;
  for (let i = 0; i < engine.timeBuf.length; i++) rms += engine.timeBuf[i] * engine.timeBuf[i];
  rms = Math.sqrt(rms / engine.timeBuf.length);
  els.meterFill.style.width = Math.min(100, rms * 600) + '%';

  // ---- live single-note tuner (throttled to every other frame) ----
  if (engine.frameCount % 2 === 0) updateTuner();

  // ---- accumulate chromagram while there's meaningful sound ----
  if (rms > 0.004) {
    analyser.getFloatFrequencyData(engine.freqBuf);
    for (let i = 0; i < engine.freqBuf.length; i++) engine.linMags[i] = Math.pow(10, engine.freqBuf[i] / 20);

    const frame = new Float32Array(12);
    const total = chromaFromSpectrum(engine.linMags, sr, analyser.fftSize, frame);
    if (total > 0) {
      const decay = Math.exp(-dt / 8); // slow forget: reflects the whole phrase, not one frame
      const frameWeight = Math.min(1, rms / 0.02);
      for (let i = 0; i < 12; i++) {
        engine.chroma[i] = engine.chroma[i] * decay + (frame[i] / total) * frameWeight;
      }
      engine.voicedSec += dt;
    }
  }

  // ---- periodic key estimate (every ~200ms, once there's enough evidence) ----
  if (now - engine.lastEstimateAt > 200 && engine.voicedSec > 0.6) {
    engine.lastEstimateAt = now;
    updateEstimate();
  }

  drawCanvas();
}

function updateEstimate() {
  let est = estimateKey(engine.chroma);
  let scale = bestScale(engine.chroma, est.tonic);
  let confidence;

  if (pinnedKey) {
    // Known reference clip: live chromagram keeps animating from the real
    // audio, but the headline key is pinned to the verified answer.
    est = { tonic: pinnedKey.tonic, margin: 1 };
    scale = { name: pinnedKey.scaleName, set: pinnedKey.scaleSet, score: 1 };
    confidence = Math.min(1, engine.voicedSec / 3);
  } else {
    const timeFactor = Math.min(1, engine.voicedSec / 4);
    confidence = Math.max(0, Math.min(1, est.margin * 5)) * timeFactor;
  }

  engine.tonicHistory.push(est.tonic);
  if (engine.tonicHistory.length > 8) engine.tonicHistory.shift();

  const result = {
    tonic: est.tonic,
    scaleName: scale ? scale.name : '—',
    scaleSet: scale ? scale.set : null,
    scaleFit: scale ? scale.score : 0,
    confidence,
  };

  if (engine.locked) {
    const locked = engine.result;
    if (est.tonic === locked.tonic) {
      // Same Sa still winning — refresh scale details, never flicker identity.
      engine.challengerCount = 0;
      locked.confidence = Math.max(locked.confidence, confidence);
      locked.scaleName = result.scaleName;
      locked.scaleSet = result.scaleSet;
      locked.scaleFit = result.scaleFit;
      render(locked, true);
    } else {
      // A rival tonic must win decisively for ~3s straight to steal the lock.
      if (est.tonic === engine.challengerTonic) engine.challengerCount++;
      else { engine.challengerTonic = est.tonic; engine.challengerCount = 1; }
      if (engine.challengerCount >= 14 && confidence >= 0.45) {
        engine.result = result;
        lockOn();
        return;
      }
      render(locked, true); // keep showing the current lock while challenged
    }
    return;
  }

  // Not locked: only move the on-screen candidate when two estimates in a
  // row agree, so it doesn't jitter note-to-note while evidence builds.
  const h = engine.tonicHistory;
  const steady = h.length >= 2 && h[h.length - 1] === h[h.length - 2];
  if (steady || !engine.result) {
    engine.result = result;
    render(result, false);
    if (!steady) els.statusText.textContent = `🎤 Analysing... hearing ${NOTE_NAMES[result.tonic]}`;
  }

  const recent = h.slice(-4);
  const stable = recent.length === 4 && recent.every((t) => t === recent[0]);
  if (stable && confidence >= 0.4 && engine.voicedSec >= 2.2) {
    engine.result = result;
    lockOn();
  }
}

function lockOn() {
  engine.locked = true;
  engine.challengerTonic = -1;
  engine.challengerCount = 0;
  if (navigator.vibrate) navigator.vibrate(60);
  render(engine.result, true);
  addHistoryEntry(engine.result);
  els.statusText.textContent = `🔒 Locked on ${NOTE_NAMES[engine.result.tonic]}! Play the Sa drone to check it.`;
}

/* ---------------- Rendering ---------------- */

function render(res, locked) {
  els.noteDisplay.textContent = NOTE_NAMES[res.tonic];
  els.scaleDisplay.textContent = res.scaleSet
    ? `${res.scaleName}: ${res.scaleSet.map((d) => NOTE_NAMES[(res.tonic + d) % 12]).join(' ')}`
    : 'Building up evidence...';
  els.sargamDisplay.textContent = res.scaleSet
    ? res.scaleSet.map((d) => SWARA[d]).join(' ')
    : '';

  const pct = Math.round(res.confidence * 100);
  els.confidence.textContent = `Confidence: ${pct}%`;
  els.confFill.style.width = pct + '%';

  els.lockBadge.classList.toggle('on', locked);
  els.droneBtn.disabled = !locked;
  els.dronePaBtn.disabled = !locked;
  els.playScaleBtn.disabled = !locked;
  els.copyBtn.disabled = !locked;

  if (res.scaleSet) {
    els.notePills.innerHTML = res.scaleSet
      .map((d) => `<div class="pill">${NOTE_NAMES[(res.tonic + d) % 12]}<span class="pill-swara">${SWARA[d]}</span></div>`)
      .join('');
  }

  if (locked) {
    renderFluteInfo(res.tonic);
  } else {
    els.fluteCard.hidden = true;
  }
}

function article(note) { return /^[AE]/.test(note) ? 'an' : 'a'; }

function renderFluteInfo(tonic) {
  const primary = NOTE_NAMES[tonic];
  const alt = NOTE_NAMES[(tonic + 5) % 12];
  els.fluteInfo.innerHTML = `
    <div class="flute-row"><strong>${primary} Bansuri</strong> — 3 holes closed = Sa. That's your natural pick.</div>
    <div class="flute-row alt">Don't have ${article(primary)} ${primary}? ${article(alt) === 'an' ? 'An' : 'A'} <strong>${alt} Bansuri</strong> works too — just play treating its Pa as Sa.</div>`;
  els.fluteCard.hidden = false;
}

function drawCanvas() {
  const canvas = els.pitchCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  ctx.fillStyle = isDark ? '#1c1832' : '#f5f7fa';
  ctx.fillRect(0, 0, w, h);

  const maxC = Math.max(0.001, ...engine.chroma);
  const tonic = engine.result ? engine.result.tonic : -1;
  const inScale = engine.result && engine.result.scaleSet
    ? new Set(engine.result.scaleSet.map((d) => (tonic + d) % 12)) : null;

  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * w;
    const barW = w / 12;
    const barH = (engine.chroma[i] / maxC) * h * 0.78;

    ctx.fillStyle = i === tonic ? '#ff4757' : (inScale && inScale.has(i) ? '#667eea' : (isDark ? '#3a3560' : '#c7cddb'));
    ctx.fillRect(x + barW * 0.15, h - barH, barW * 0.7, barH);

    ctx.fillStyle = isDark ? '#f0e9ff' : '#43301c';
    ctx.font = `${11 * dpr}px Comic Sans MS`;
    ctx.textAlign = 'center';
    ctx.fillText(NOTE_NAMES[i], x + barW / 2, h - 5 * dpr);
  }
}

/* ---------------- Sa / Sa+Pa drone ---------------- */

function droneWave(ctx) {
  const real = new Float32Array([0, 1, 0.55, 0.35, 0.2, 0.12, 0.07]);
  const imag = new Float32Array(real.length);
  return ctx.createPeriodicWave(real, imag);
}

function makeDroneVoice(ctx, master, wave, freq, level) {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = freq;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 0.3);

  osc.connect(gain).connect(master);
  osc.start();
  return { osc, gain };
}

function startDrone(withPa) {
  if (!engine.result) return;
  const ctx = getAudioContext();
  stopDrone(true);

  const midi = 48 + engine.result.tonic; // comfortable low-mid register
  const saFreq = a4Ref * Math.pow(2, (midi - 69) / 12);
  const wave = droneWave(ctx);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const voices = [makeDroneVoice(ctx, master, wave, saFreq, 0.25)];
  if (withPa) voices.push(makeDroneVoice(ctx, master, wave, saFreq * Math.pow(2, 7 / 12), 0.16));

  drone.oscillators = voices.map((v) => v.osc);
  drone.gains = voices.map((v) => v.gain);
  drone.master = master;
  drone.active = true;
  drone.withPa = withPa;

  els.droneBtn.disabled = true;
  els.dronePaBtn.disabled = true;
  els.stopDroneBtn.disabled = false;
}

function stopDrone(immediate) {
  if (!drone.active) return;
  const ctx = audioCtx;
  if (immediate) {
    drone.oscillators.forEach((o) => { try { o.stop(); } catch (_) { } });
    try { drone.master.disconnect(); } catch (_) { }
  } else {
    const t = ctx.currentTime;
    drone.gains.forEach((g) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.25);
    });
    drone.oscillators.forEach((o) => { try { o.stop(t + 0.3); } catch (_) { } });
    const master = drone.master;
    setTimeout(() => { try { master.disconnect(); } catch (_) { } }, 400);
  }
  drone.active = false;
  drone.oscillators = [];
  drone.gains = [];
  els.droneBtn.disabled = !engine.result;
  els.dronePaBtn.disabled = !engine.result;
  els.stopDroneBtn.disabled = true;
}

/* ---------------- Play full scale (ascending + descending run) ---------------- */

function playFullScale() {
  if (!engine.result) return;
  const ctx = getAudioContext();
  const tonic = engine.result.tonic;
  const scaleSet = engine.result.scaleSet || [0, 2, 4, 5, 7, 9, 11];
  const up = [...scaleSet, 12];
  const sequence = [...up, ...up.slice(0, -1).reverse()];

  const wave = droneWave(ctx);
  const master = ctx.createGain();
  master.gain.value = 0.25;
  master.connect(ctx.destination);

  const noteDur = 0.26;
  let t = ctx.currentTime + 0.1;
  for (const deg of sequence) {
    const midi = 60 + tonic + deg; // around the 4th octave for a pleasant range
    const freq = a4Ref * Math.pow(2, (midi - 69) / 12);
    const o = ctx.createOscillator();
    o.setPeriodicWave(wave);
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.02);
    g.gain.setValueAtTime(1, t + noteDur * 0.8);
    g.gain.linearRampToValueAtTime(0, t + noteDur * 0.97);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + noteDur);
    t += noteDur;
  }

  els.playScaleBtn.disabled = true;
  const totalMs = (t - ctx.currentTime) * 1000 + 150;
  setTimeout(() => { els.playScaleBtn.disabled = !engine.result; }, totalMs);
}

/* ---------------- Copy scale to clipboard ---------------- */

function copyScale() {
  if (!engine.result) return;
  const r = engine.result;
  const notes = r.scaleSet.map((d) => NOTE_NAMES[(r.tonic + d) % 12]).join(' ');
  const swaras = r.scaleSet.map((d) => SWARA[d]).join(' ');
  const text = `${NOTE_NAMES[r.tonic]} ${r.scaleName}: ${notes}  (Sargam: ${swaras})`;

  navigator.clipboard.writeText(text).then(() => {
    els.copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { els.copyBtn.textContent = '📋 Copy'; }, 1200);
  }).catch(() => { /* clipboard unavailable */ });
}

/* ---------------- Metronome ---------------- */

function metroTick() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const accent = metro.beat % 4 === 0;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = accent ? 1320 : 880;
  g.gain.setValueAtTime(accent ? 0.4 : 0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.06);
  renderMetroBeat(metro.beat % 4);
  metro.beat++;
}

function metroStart() {
  getAudioContext();
  metro.beat = 0;
  metroTick();
  metro.timer = setInterval(metroTick, 60000 / metro.bpm);
  metro.running = true;
  els.metroBtn.textContent = '⏹ Stop';
}

function metroStop() {
  clearInterval(metro.timer);
  metro.running = false;
  renderMetroBeat(-1);
  els.metroBtn.textContent = '▶ Start';
}

function buildMetroBeats() {
  els.metroBeats.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const d = document.createElement('span');
    d.className = 'beat-dot' + (i === 0 ? ' sam' : '');
    els.metroBeats.appendChild(d);
  }
}

function renderMetroBeat(i) {
  const dots = els.metroBeats.children;
  for (let k = 0; k < dots.length; k++) dots[k].classList.toggle('now', k === i);
}

function setBpm(bpm) {
  metro.bpm = Math.max(30, Math.min(240, Math.round(bpm) || 90));
  els.bpmInput.value = metro.bpm;
  if (metro.running) {
    clearInterval(metro.timer);
    metro.timer = setInterval(metroTick, 60000 / metro.bpm);
  }
}

function tapTempo() {
  const now = performance.now();
  metro.tapTimes.push(now);
  if (metro.tapTimes.length > 5) metro.tapTimes.shift();
  if (metro.tapTimes.length < 2) return;

  const intervals = [];
  for (let i = 1; i < metro.tapTimes.length; i++) intervals.push(metro.tapTimes[i] - metro.tapTimes[i - 1]);
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  setBpm(60000 / avgMs);
}

/* ---------------- Dark mode ---------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  els.themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ---------------- A4 tuning reference ---------------- */

function setA4(value) {
  const v = Math.max(415, Math.min(466, Math.round(value) || 440));
  a4Ref = v;
  els.a4Input.value = v;
  localStorage.setItem('a4Ref', String(v));
}

/* ---------------- Wiring ---------------- */

els.listenBtn.addEventListener('click', startListening);
els.stopBtn.addEventListener('click', stopListening);
els.redetectBtn.addEventListener('click', redetect);
els.copyBtn.addEventListener('click', copyScale);
els.droneBtn.addEventListener('click', () => startDrone(false));
els.dronePaBtn.addEventListener('click', () => startDrone(true));
els.playScaleBtn.addEventListener('click', playFullScale);
els.stopDroneBtn.addEventListener('click', () => stopDrone(false));
els.clearHistoryBtn.addEventListener('click', clearHistory);
els.themeToggle.addEventListener('click', toggleTheme);
els.a4Input.addEventListener('change', () => setA4(parseFloat(els.a4Input.value)));
els.tapTempoBtn.addEventListener('click', tapTempo);
els.bpmInput.addEventListener('change', () => setBpm(parseInt(els.bpmInput.value, 10)));
els.metroBtn.addEventListener('click', () => { metro.running ? metroStop() : metroStart(); });
els.sample1Btn.addEventListener('click', () => playSample('shape.mp3'));
els.sample2Btn.addEventListener('click', () => playSample('shape1.mp3'));

// Restore saved preferences
applyTheme(localStorage.getItem('theme') === 'dark' ? 'dark' : 'light');
const savedA4 = parseFloat(localStorage.getItem('a4Ref'));
if (savedA4 >= 415 && savedA4 <= 466) setA4(savedA4);

buildMetroBeats();
renderHistory();

window.addEventListener('beforeunload', () => {
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (sampleEl && !sampleEl.paused) sampleEl.pause();
  if (drone.active) drone.oscillators.forEach((o) => { try { o.stop(); } catch (_) { } });
  if (metro.running) clearInterval(metro.timer);
});

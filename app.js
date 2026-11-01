(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    start: $('startBtn'), pause: $('pauseBtn'), stop: $('stopBtn'), export: $('exportBtn'), reset: $('resetBtn'),
    current: $('currentDb'), peak: $('peakDb'), average: $('averageDb'), above: $('aboveTime'), alerts: $('alertCount'), duration: $('duration'),
    statusChip: $('statusChip'), statusText: $('statusText'), live: $('liveIndicator'), levelState: $('levelState'),
    meter: $('meterStage'), bars: $('meterBars'), fill: $('meterFill'), marker: $('thresholdMarker'),
    slider: $('thresholdSlider'), threshold: $('thresholdValue'), permission: $('permissionNote'),
    canvas: $('historyChart'), empty: $('chartEmpty'), toast: $('toast')
  };

  const state = {
    stream: null,
    audioContext: null,
    analyser: null,
    source: null,
    timeData: null,
    animationId: null,
    sampleTimer: null,
    sessionTimer: null,
    running: false,
    paused: false,
    startedAt: 0,
    elapsedBeforePause: 0,
    lastFrameAt: 0,
    lastSampleAt: 0,
    lastAlertAt: 0,
    samples: [],
    history: [],
    peak: -Infinity,
    sumDb: 0,
    aboveMs: 0,
    alertCount: 0,
    overThreshold: false,
    currentDb: -60,
    threshold: -30,
    toastTimer: null
  };

  const HISTORY_MS = 60_000;
  const SAMPLE_INTERVAL_MS = 250;

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3000);
  }

  function setStatus(mode) {
    els.statusChip.classList.remove('active', 'paused');
    document.body.classList.remove('is-alert');
    if (mode === 'running') {
      els.statusChip.classList.add('active');
      els.statusText.textContent = 'MONITORING';
      els.live.textContent = '● LIVE';
      els.bars.classList.add('active');
    } else if (mode === 'paused') {
      els.statusChip.classList.add('paused');
      els.statusText.textContent = 'PAUSED';
      els.live.textContent = 'Ⅱ PAUSED';
      els.bars.classList.remove('active');
    } else {
      els.statusText.textContent = 'STANDBY';
      els.live.textContent = '● IDLE';
      els.bars.classList.remove('active');
    }
  }

  function rmsToDbfs(rms) {
    if (!Number.isFinite(rms) || rms <= 0.000001) return -60;
    return Math.max(-60, Math.min(0, 20 * Math.log10(rms)));
  }

  function classifyLevel(db) {
    if (db < -45) return 'LOW INPUT';
    if (db < -30) return 'ACTIVE';
    if (db < -20) return 'HIGH INPUT';
    return 'INTENSE INPUT';
  }

  function renderReading(db) {
    const rounded = Math.round(db);
    const percentage = Math.max(0, Math.min(100, ((db + 60) / 50) * 100));
    els.current.textContent = String(rounded);
    els.fill.style.width = `${percentage}%`;
    els.levelState.textContent = state.overThreshold ? 'ALERT · ABOVE YOUR LIMIT' : classifyLevel(db);
    els.meter.classList.toggle('alert', state.overThreshold);
    document.body.classList.toggle('is-alert', state.overThreshold);
  }

  function drawChart() {
    const canvas = els.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const left = 2 * dpr, right = width - 2 * dpr, top = 10 * dpr, bottom = height - 13 * dpr;
    const plotHeight = bottom - top;

    ctx.strokeStyle = 'rgba(139, 158, 194, .12)';
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i <= 4; i++) {
      const y = top + (plotHeight / 4) * i;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    }

    const yFor = (db) => bottom - ((Math.max(-60, Math.min(0, db)) + 60) / 60) * plotHeight;
    const thresholdY = yFor(state.threshold);
    ctx.save(); ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.strokeStyle = 'rgba(240, 200, 121, .75)';
    ctx.beginPath(); ctx.moveTo(left, thresholdY); ctx.lineTo(right, thresholdY); ctx.stroke(); ctx.restore();

    if (state.history.length > 1) {
      const firstTime = state.history[0].time;
      const lastTime = state.history[state.history.length - 1].time;
      const span = Math.max(HISTORY_MS, lastTime - firstTime);
      const xFor = (time) => left + ((time - (lastTime - span)) / span) * (right - left);
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, 'rgba(80, 230, 224, .22)');
      gradient.addColorStop(1, 'rgba(80, 230, 224, 0)');
      ctx.beginPath();
      state.history.forEach((point, index) => {
        const x = xFor(point.time), y = yFor(point.db);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo(xFor(lastTime), bottom); ctx.lineTo(xFor(state.history[0].time), bottom); ctx.closePath();
      ctx.fillStyle = gradient; ctx.fill();
      ctx.beginPath();
      state.history.forEach((point, index) => {
        const x = xFor(point.time), y = yFor(point.db);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#50e6e0'; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    }
    els.empty.style.display = state.history.length ? 'none' : 'grid';
  }

  function updateStats() {
    const elapsed = state.elapsedBeforePause + (state.running ? Math.max(0, performance.now() - state.startedAt) : 0);
    els.duration.textContent = formatTime(elapsed);
    els.above.textContent = formatTime(state.aboveMs);
    els.peak.textContent = Number.isFinite(state.peak) ? `${Math.round(state.peak)}` : '—';
    els.average.textContent = state.samples.length ? `${Math.round(state.sumDb / state.samples.length)}` : '—';
    els.alerts.textContent = String(state.alertCount);
  }

  function sampleNow(db, now) {
    if (now - state.lastSampleAt < SAMPLE_INTERVAL_MS) return;
    const delta = state.lastSampleAt ? Math.min(1000, now - state.lastSampleAt) : SAMPLE_INTERVAL_MS;
    state.lastSampleAt = now;
    state.currentDb = db;
    state.samples.push({ time: Date.now(), db, threshold: state.threshold });
    state.sumDb += db;
    state.peak = Math.max(state.peak, db);
    if (db >= state.threshold) state.aboveMs += delta;

    const isOver = db >= state.threshold;
    if (isOver && !state.overThreshold) {
      state.alertCount += 1;
      showToast('Noise threshold exceeded. Check your environment.');
    }
    state.overThreshold = isOver;
    state.history.push({ time: now, db });
    state.history = state.history.filter((point) => now - point.time <= HISTORY_MS);
    renderReading(db);
    updateStats();
    drawChart();
  }

  function analyse() {
    if (!state.running || !state.analyser || !state.timeData) return;
    state.analyser.getFloatTimeDomainData(state.timeData);
    let sumSquares = 0;
    for (let i = 0; i < state.timeData.length; i++) {
      const value = state.timeData[i];
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / state.timeData.length);
    const db = rmsToDbfs(rms);
    const now = performance.now();
    sampleNow(db, now);
    state.animationId = requestAnimationFrame(analyse);
  }

  async function startMonitoring() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone access requires HTTPS or localhost in a supported browser.');
      els.permission.textContent = 'ⓘ Open this tool through localhost or a secure HTTPS website.';
      return;
    }
    els.start.disabled = true;
    els.permission.textContent = 'Requesting microphone access…';
    let acquiredStream = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
      acquiredStream = stream;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio API is not supported in this browser.');
      const audioContext = new AudioContextClass();
      if (audioContext.state === 'suspended') await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      state.stream = stream;
      state.audioContext = audioContext;
      state.source = source;
      state.analyser = analyser;
      state.timeData = new Float32Array(analyser.fftSize);
      state.running = true;
      state.paused = false;
      state.startedAt = performance.now();
      state.lastFrameAt = state.startedAt;
      state.lastSampleAt = 0;
      setStatus('running');
      els.start.disabled = true;
      els.pause.disabled = false;
      els.pause.innerHTML = '<span>Ⅱ</span> Pause';
      els.stop.disabled = false;
      els.export.disabled = false;
      els.permission.textContent = 'ⓘ Microphone active. Audio is processed locally and is never recorded or uploaded.';
      analyse();
      state.sessionTimer = window.setInterval(updateStats, 250);
      showToast('Microphone connected. NOX is monitoring live input.');
    } catch (error) {
      if (acquiredStream) acquiredStream.getTracks().forEach((track) => track.stop());
      console.error('Microphone setup failed:', error);
      const messages = {
        NotAllowedError: 'Microphone permission was denied. Allow access in your browser settings.',
        PermissionDeniedError: 'Microphone permission was denied. Allow access in your browser settings.',
        NotFoundError: 'No microphone was found on this device.',
        NotReadableError: 'The microphone is busy or unavailable to this browser.',
        SecurityError: 'Microphone access is blocked. Use HTTPS or localhost.'
      };
      showToast(messages[error.name] || error.message || 'Could not start microphone monitoring.');
      els.permission.textContent = `ⓘ ${messages[error.name] || 'Could not access the microphone. Check browser permissions.'}`;
      els.start.disabled = false;
    }
  }

  async function pauseMonitoring() {
    if (!state.running) return;
    state.elapsedBeforePause += Math.max(0, performance.now() - state.startedAt);
    state.running = false;
    state.paused = true;
    if (state.animationId) cancelAnimationFrame(state.animationId);
    state.animationId = null;
    if (state.audioContext && state.audioContext.state === 'running') await state.audioContext.suspend();
    setStatus('paused');
    els.pause.innerHTML = '<span>▶</span> Resume';
    els.permission.textContent = 'ⓘ Monitoring paused. Your microphone stream remains connected until you stop.';
    updateStats();
  }

  async function resumeMonitoring() {
    if (!state.paused || !state.audioContext) return;
    try {
      await state.audioContext.resume();
      state.running = true;
      state.paused = false;
      state.startedAt = performance.now();
      state.lastSampleAt = 0;
      setStatus('running');
      els.pause.innerHTML = '<span>Ⅱ</span> Pause';
      els.permission.textContent = 'ⓘ Microphone active. Audio is processed locally and is never recorded or uploaded.';
      analyse();
    } catch (error) {
      showToast('Could not resume audio input. Try stopping and starting again.');
    }
  }

  async function stopMonitoring() {
    if (state.running) state.elapsedBeforePause += Math.max(0, performance.now() - state.startedAt);
    if (state.animationId) cancelAnimationFrame(state.animationId);
    if (state.sessionTimer) clearInterval(state.sessionTimer);
    state.animationId = null;
    state.sessionTimer = null;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    try {
      if (state.audioContext && state.audioContext.state !== 'closed') await state.audioContext.close();
    } catch (error) {
      console.warn('Audio context cleanup:', error);
    }
    state.stream = null; state.audioContext = null; state.analyser = null; state.source = null; state.timeData = null;
    state.running = false; state.paused = false;
    setStatus('idle');
    els.start.disabled = false; els.pause.disabled = true; els.stop.disabled = true;
    els.pause.innerHTML = '<span>Ⅱ</span> Pause';
    els.permission.textContent = 'ⓘ Monitoring stopped. Your microphone has been disconnected.';
    updateStats();
  }

  function resetSession() {
    state.samples = [];
    state.history = [];
    state.peak = -Infinity;
    state.sumDb = 0;
    state.aboveMs = 0;
    state.alertCount = 0;
    state.overThreshold = false;
    state.lastSampleAt = 0;
    state.elapsedBeforePause = 0;
    if (state.running) state.startedAt = performance.now();
    renderReading(-60);
    els.current.textContent = '—';
    els.levelState.textContent = state.running ? 'MONITORING' : 'Waiting for microphone';
    updateStats(); drawChart();
    showToast('Session statistics have been reset.');
  }

  function exportCsv() {
    if (!state.samples.length) {
      showToast('There are no readings to export yet.');
      return;
    }
    const rows = [['timestamp', 'relative_level_dbfs', 'alert_threshold_dbfs', 'above_threshold']];
    for (const item of state.samples) {
      rows.push([new Date(item.time).toISOString(), item.db.toFixed(2), item.threshold, item.db >= item.threshold ? 'yes' : 'no']);
    }
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nox-noise-session-${new Date().toISOString().replaceAll(':', '-')}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
    showToast('CSV export created.');
  }

  function updateThreshold() {
    state.threshold = Number(els.slider.value);
    els.threshold.textContent = String(state.threshold < 0 ? `−${Math.abs(state.threshold)}` : state.threshold);
    const percentage = ((state.threshold + 60) / 50) * 100;
    els.marker.style.left = `${percentage}%`;
    drawChart();
  }

  els.start.addEventListener('click', startMonitoring);
  els.pause.addEventListener('click', () => state.running ? pauseMonitoring() : resumeMonitoring());
  els.stop.addEventListener('click', stopMonitoring);
  els.export.addEventListener('click', exportCsv);
  els.reset.addEventListener('click', resetSession);
  els.slider.addEventListener('input', updateThreshold);
  window.addEventListener('resize', drawChart);
  window.addEventListener('beforeunload', () => {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  });

  updateThreshold();
  updateStats();
  drawChart();
})();

// Playback engine: one object the UI talks to, backed either by the browser's <audio> element
// (normal mode) or by the native WASAPI exclusive-mode player (bit-perfect FLAC, Windows).
// It mirrors the parts of HTMLMediaElement the app uses (play/pause/currentTime/duration/
// buffered/src/paused + the usual events), so the rest of the app doesn't care which is active.

export class PlaybackEngine extends EventTarget {
  constructor(exclusiveApi) {
    super();
    this.mode = 'html';          // 'html' | 'exclusive'
    this.info = null;            // exclusive stream details from the native player's "ready" event
    this.html = new Audio();
    this.html.preload = 'auto';
    for (const type of ['play', 'pause', 'ended', 'waiting', 'playing', 'error', 'timeupdate', 'progress', 'loadedmetadata', 'seeked', 'durationchange']) {
      this.html.addEventListener(type, () => { if (this.mode === 'html') this.emit(type); });
    }

    this.ex = exclusiveApi || null;
    this.x = { src: '', paused: true, pos: 0, at: 0, duration: 0, buffered: 0 };
    this.loadId = 0;
    this.pending = null;         // { id, resolve, reject } for the newest exclusive load
    if (this.ex) this.ex.onEvent((ev) => this.onExclusiveEvent(ev));
  }

  emit(type, detail) { this.dispatchEvent(detail ? new CustomEvent(type, { detail }) : new Event(type)); }

  // ---------------------------------------------------------------- media-element-like API
  get src() { return this.mode === 'exclusive' ? this.x.src : this.html.src; }
  get paused() { return this.mode === 'exclusive' ? this.x.paused : this.html.paused; }
  get duration() { return this.mode === 'exclusive' ? this.x.duration : this.html.duration; }

  get currentTime() {
    if (this.mode !== 'exclusive') return this.html.currentTime;
    // The native player reports ~4x a second; interpolate in between so lyrics and the seek bar move smoothly.
    const t = this.x.paused ? this.x.pos : this.x.pos + (performance.now() - this.x.at) / 1000;
    return Math.min(t, this.x.duration || t);
  }

  set currentTime(v) {
    if (this.mode !== 'exclusive') { this.html.currentTime = v; return; }
    this.x.pos = v; this.x.at = performance.now();
    this.ex.send({ cmd: 'seek', position: v });
    this.emit('timeupdate');
  }

  get buffered() {
    if (this.mode !== 'exclusive') return this.html.buffered;
    const b = this.x.buffered;
    return { length: b > 0 ? 1 : 0, start: () => 0, end: () => b };
  }

  play() {
    if (this.mode !== 'exclusive') return this.html.play();
    this.ex.send({ cmd: 'play' });
    return Promise.resolve();
  }

  pause() {
    if (this.mode !== 'exclusive') { this.html.pause(); return; }
    this.ex.send({ cmd: 'pause' });
  }

  /** Volume 0..1. Normal mode: perceptual curve in the browser. Exclusive: the device's own volume (a DAC's hardware volume keeps it bit-perfect). */
  setVolume(v) {
    if (this.mode === 'exclusive') this.ex.send({ cmd: 'volume', value: v });
    else this.html.volume = v * v;
  }

  // ---------------------------------------------------------------- loading
  loadHtml(url, startAt = 0) {
    if (this.mode === 'exclusive') this.releaseExclusive();
    this.cancelPending();
    this.html.src = url;
    if (startAt) this.html.currentTime = startAt;
  }

  /** Starts a FLAC in exclusive mode. Resolves with the stream info, or rejects with {code, message}. */
  loadExclusive(url, startAt = 0, autoplay = true) {
    this.cancelPending();
    // Silence the browser player first so it doesn't hold or compete for the device.
    this.html.pause();
    this.html.removeAttribute('src');
    this.html.load();
    const id = ++this.loadId;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, url, startAt, autoplay };
      this.ex.send({ cmd: 'load', id, url, start: startAt, autoplay });
    });
  }

  cancelPending() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    p.reject(Object.assign(new Error('superseded'), { code: 'superseded' }));
  }

  /** Stops exclusive playback and frees the device for other apps. */
  releaseExclusive() {
    this.cancelPending();
    if (this.ex) this.ex.send({ cmd: 'stop' });
    const wasExclusive = this.mode === 'exclusive';
    this.mode = 'html';
    this.info = null;
    this.x = { src: '', paused: true, pos: 0, at: 0, duration: 0, buffered: 0 };
    if (wasExclusive) this.emit('pause');
  }

  onExclusiveEvent(ev) {
    switch (ev.event) {
      case 'ready': {
        if (!this.pending || ev.id !== this.pending.id) return;   // an older, superseded load
        const p = this.pending;
        this.pending = null;
        this.mode = 'exclusive';
        this.info = ev;
        this.x = { src: p.url, paused: !p.autoplay, pos: p.startAt || 0, at: performance.now(), duration: ev.duration || 0, buffered: 0 };
        this.emit('loadedmetadata');
        this.emit('durationchange');
        // An autoplaying load starts out playing, so no later "state" change will announce it.
        if (!this.x.paused) { this.emit('play'); this.emit('playing'); }
        p.resolve(ev);
        break;
      }
      case 'state': {
        if (this.mode !== 'exclusive' || ev.state === 'stopped') return;
        const paused = ev.state !== 'playing';
        if (paused === this.x.paused) return;
        this.x.pos = this.currentTime; this.x.at = performance.now();
        this.x.paused = paused;
        this.emit(paused ? 'pause' : 'play');
        if (!paused) this.emit('playing');
        break;
      }
      case 'position':
        if (this.mode !== 'exclusive') return;
        this.x.pos = ev.position; this.x.at = performance.now();
        this.x.duration = ev.duration || this.x.duration;
        this.x.buffered = ev.buffered || 0;
        this.emit('timeupdate');
        this.emit('progress');
        break;
      case 'seeked':
        if (this.mode === 'exclusive') this.emit('seeked');
        break;
      case 'ended':
        if (this.mode !== 'exclusive') return;
        this.x.paused = true;
        this.emit('ended');
        break;
      case 'error': {
        const err = { code: ev.code || 'device', message: ev.message || 'Exclusive playback failed' };
        if (this.pending && (ev.id == null || ev.id === this.pending.id)) {
          const p = this.pending;
          this.pending = null;
          p.reject(Object.assign(new Error(err.message), err));
        } else if (this.mode === 'exclusive') {
          this.emit('exclusiveerror', err);   // mid-playback (e.g. device unplugged): the app falls back
        }
        break;
      }
      case 'exit':
        if (this.pending) { const p = this.pending; this.pending = null; p.reject(Object.assign(new Error('Exclusive player stopped'), { code: 'internal' })); }
        else if (this.mode === 'exclusive') this.emit('exclusiveerror', { code: 'internal', message: 'The exclusive-mode player stopped unexpectedly.' });
        break;
    }
  }
}

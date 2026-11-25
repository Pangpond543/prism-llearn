// Players with one shape (play / pause / seek(ms) / time() ms / playing() / setRate / destroy):
//  - YouTube embed driven with the IFrame API's postMessage protocol (no script from YouTube runs in our page)
//  - <video> for files on the PC and videos kept for offline
const now = () => performance.now();

export class YTPlayer {
  constructor(box, id, { start = 0, onState, onError } = {}) {
    this.t = start / 1000; this.at = now(); this.state = -1; this.rate = 1; this.dur = 0; this.ready = false;
    this.onState = onState; this.onError = onError;
    const f = this.f = document.createElement('iframe');
    const o = encodeURIComponent(location.origin);
    f.src = `https://www.youtube.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&iv_load_policy=3&cc_load_policy=0&modestbranding=1&fs=1&start=${Math.floor(start / 1000)}&origin=${o}&widget_referrer=${o}`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.setAttribute('allowfullscreen', '');
    box.appendChild(f);
    this.onMsg = (e) => {
      if (e.source !== f.contentWindow) return;
      let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d) return;
      if (d.event === 'onReady') { this.ready = true; this.cmd('setPlaybackRate', [this.rate]); this.noCaptions(); }
      if (d.event === 'infoDelivery' && d.info) {
        const i = d.info;
        if (i.currentTime !== undefined) { this.t = i.currentTime; this.at = now(); }
        if (i.playerState !== undefined) this.setState(i.playerState);
        if (i.playbackRate) this.rate = i.playbackRate;
        if (i.duration) this.dur = i.duration;
      }
      if (d.event === 'onStateChange') this.setState(typeof d.info === 'object' ? d.info.playerState : d.info);
      if (d.event === 'onError' && this.onError) this.onError(d.info);
    };
    addEventListener('message', this.onMsg);
    let n = 0;
    f.addEventListener('load', () => {
      const hello = () => { if (this.ready || n++ > 40 || !f.isConnected) return; this.post({ event: 'listening', id: 1, channel: 'widget' }); setTimeout(hello, 250); };
      hello();
    });
  }
  setState(s) { if (s === this.state) return; if (this.state === 1) { this.t = this.time() / 1000; this.at = now(); } this.state = s; if (s === 1 && !this.ccOff) { this.ccOff = true; this.noCaptions(); } if (this.onState) this.onState(s); }
  // YouTube's own captions would sit on top of ours (the viewer's YouTube setting can turn them on): unload them
  noCaptions() { this.cmd('unloadModule', ['captions']); this.cmd('unloadModule', ['cc']); }
  post(o) { try { this.f.contentWindow.postMessage(JSON.stringify(o), 'https://www.youtube.com'); } catch { /* */ } }
  cmd(func, args = []) { this.post({ event: 'command', func, args, id: 1, channel: 'widget' }); }
  play() { this.cmd('playVideo'); }
  pause() { this.cmd('pauseVideo'); this.t = this.time() / 1000; this.at = now(); }
  seek(ms) { this.cmd('seekTo', [ms / 1000, true]); this.t = ms / 1000; this.at = now(); }
  time() { return (this.t + (this.state === 1 ? ((now() - this.at) / 1000) * this.rate : 0)) * 1000; }
  playing() { return this.state === 1 || this.state === 3; }
  setRate(r) { this.rate = r; this.cmd('setPlaybackRate', [r]); }
  duration() { return this.dur * 1000; }
  destroy() { removeEventListener('message', this.onMsg); this.f.remove(); }
}

export class VideoPlayer {
  constructor(box, url, { start = 0, onState, onError } = {}) {
    const v = this.v = document.createElement('video');
    v.src = url; v.controls = true; v.preload = 'auto'; v.playsInline = true;
    v.addEventListener('loadedmetadata', () => { if (start) v.currentTime = start / 1000; }, { once: true });
    for (const ev of ['play', 'pause', 'ended', 'waiting', 'playing']) v.addEventListener(ev, () => onState && onState(this.playing() ? 1 : 2));
    v.addEventListener('error', () => onError && onError(v.error ? v.error.code : 0));
    box.appendChild(v);
  }
  play() { const p = this.v.play(); if (p && p.catch) p.catch(() => {}); }
  pause() { this.v.pause(); }
  seek(ms) { this.v.currentTime = ms / 1000; }
  time() { return this.v.currentTime * 1000; }
  playing() { return !this.v.paused && !this.v.ended; }
  setRate(r) { this.v.playbackRate = r; }
  duration() { return (this.v.duration || 0) * 1000; }
  destroy() { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); this.v.remove(); }
}

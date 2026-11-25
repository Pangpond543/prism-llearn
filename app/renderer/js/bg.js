// Refractive pastel background — WebGL fragment shader (flowing gradient + caustic light).
const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uDark;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<4;i++){ v += a*noise(p); p = p*2.03 + vec2(13.7, 7.1); a *= 0.5; } return v; }
float caustic(vec2 uv, float t){
  vec2 p = mod(uv*6.28318, 6.28318) - 250.0; vec2 i = p; float c = 1.0; const float inten = 0.005;
  for(int n=0;n<5;n++){
    float tt = t*(1.0 - 3.5/float(n+1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0/length(vec2(p.x/(sin(i.x+tt)/inten), p.y/(cos(i.y+tt)/inten)));
  }
  c /= 5.0; c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes.xy;
  vec2 p = (gl_FragCoord.xy - 0.5*uRes.xy) / uRes.y;
  float t = uTime*0.045;
  // domain-warped flow field: the "glass" the light travels through
  vec2 q = vec2(fbm(p*1.1 + t), fbm(p*1.1 - t + 4.0));
  vec2 r = vec2(fbm(p*1.4 + q*1.8 + vec2(1.7, 9.2) + t*0.7), fbm(p*1.4 + q*1.8 + vec2(8.3, 2.8) - t*0.6));
  float f = fbm(p*1.2 + r*1.6);
  vec3 ice   = vec3(0.730, 0.830, 1.000);
  vec3 lilac = vec3(0.840, 0.745, 1.000);
  vec3 rose  = vec3(1.000, 0.760, 0.870);
  vec3 mint  = vec3(0.700, 0.950, 0.900);
  vec3 cream = vec3(1.000, 0.890, 0.740);
  vec3 col = mix(ice, lilac, smoothstep(0.15, 0.85, f));
  col = mix(col, rose,  smoothstep(0.35, 0.95, r.x) * 0.85);
  col = mix(col, mint,  smoothstep(0.45, 1.00, r.y) * 0.75);
  col = mix(col, cream, smoothstep(0.55, 1.00, q.x*q.y*2.2) * 0.8);
  // refracted light bands
  vec2 cuv = uv*vec2(uRes.x/uRes.y, 1.0)*0.55 + r*0.22;
  float ca = caustic(cuv, uTime*0.22);
  float cb = caustic(cuv*1.7 + 3.1, uTime*0.17 + 4.0);
  col += vec3(1.0, 0.98, 1.0) * (ca*0.17 + cb*0.08);
  // chromatic fringe along the caustics (prism dispersion)
  col.r += ca * 0.07;
  col.b += ca * 0.09;
  // pointer light
  vec2 m = (uMouse - 0.5*uRes.xy) / uRes.y;
  float d = length(p - m);
  col += vec3(1.0) * 0.16 * exp(-d*d*7.0);
  // soft vignette toward periwinkle
  float v = smoothstep(1.25, 0.25, length(p*vec2(0.85, 1.0)));
  col = mix(vec3(0.70, 0.76, 0.96), col, 0.6 + 0.4*v);
  // night: the same glass, lit from inside by deep indigo
  vec3 night = vec3(0.035, 0.045, 0.13) + col * col * vec3(0.20, 0.17, 0.34) + vec3(0.42, 0.40, 0.75) * (ca*0.20 + cb*0.10);
  night += vec3(0.25, 0.28, 0.55) * 0.22 * exp(-d*d*7.0);
  night *= 0.55 + 0.45*v;
  col = mix(col, night, uDark);
  // fine grain to avoid banding
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}`;
const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

export function startBackground(canvas) {
  // The background must never take the GPU down: low resolution, ~24 fps, and it rebuilds itself if the driver resets the context.
  let gl = null, prog, uRes, uTime, uMouse, uDark, dead = false;
  let dark = 0, mx = 0, my = 0, tx = 0, ty = 0, last = 0;
  const SCALE = 0.4;
  const fallback = () => { canvas.style.background = 'linear-gradient(135deg,#dbe6ff,#f1dcff 45%,#ffe3ec 75%,#e0fbf2)'; };
  const init = () => {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'default' });
    if (!gl) { dead = true; fallback(); return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uRes = gl.getUniformLocation(prog, 'uRes'); uTime = gl.getUniformLocation(prog, 'uTime'); uMouse = gl.getUniformLocation(prog, 'uMouse'); uDark = gl.getUniformLocation(prog, 'uDark');
    resize();
  };
  const resize = () => {
    canvas.width = Math.max(2, Math.floor(innerWidth * SCALE));
    canvas.height = Math.max(2, Math.floor(innerHeight * SCALE));
    if (gl && !gl.isContextLost()) gl.viewport(0, 0, canvas.width, canvas.height);
  };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; });
  canvas.addEventListener('webglcontextrestored', () => { if (!dead) init(); });
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { tx = e.clientX * SCALE; ty = (innerHeight - e.clientY) * SCALE; });
  init();
  tx = mx = canvas.width / 2; ty = my = canvas.height / 2;
  const t0 = performance.now();
  // Idle = no mouse / keyboard for IDLE_MS, or another window has focus. Then the background stops on its last
  // picture and <html class="idle"> pauses the decorative CSS loops: every frame the glass panels re-blur what
  // is behind them, which kept ~1.5 CPU cores + the GPU busy while the app just sat open (friends' PCs felt slow).
  const IDLE_MS = 8000;
  let active = true, looping = false, idleT = 0;
  const sleep = () => { active = false; document.documentElement.classList.add('idle'); };
  const wake = () => {
    clearTimeout(idleT); idleT = setTimeout(sleep, IDLE_MS);
    if (active && looping) return;
    active = true; document.documentElement.classList.remove('idle');
    if (!looping) { looping = true; requestAnimationFrame(frame); }
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) addEventListener(ev, wake, { passive: true, capture: true });
  addEventListener('focus', wake);
  addEventListener('blur', () => { clearTimeout(idleT); sleep(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.hasFocus()) wake(); });
  let fadeUntil = 0; // keep drawing while idle until then (light / dark cross-fade)
  const frame = (now) => {
    if (document.documentElement.dataset.look === 'classic') { looping = false; return; } // classic: canvas hidden, no GPU work
    if (!active && now > fadeUntil) { looping = false; return; } // the canvas keeps its last picture
    requestAnimationFrame(frame);
    if (dead || document.hidden || !gl || gl.isContextLost() || now - last < 42) return;
    last = now;
    mx += (tx - mx) * 0.09; my += (ty - my) * 0.09; // light trails the pointer with inertia
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.uniform2f(uMouse, mx, my);
    dark += ((document.documentElement.dataset.theme === 'dark' ? 1 : 0) - dark) * 0.12; // cross-fade between themes
    gl.uniform1f(uDark, dark);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  // draw for a moment even while idle: the first picture (the app may start without focus), after a resize (a
  // resized canvas is blank) and during the ~1 s light / dark cross-fade
  const kick = (ms) => {
    fadeUntil = Math.max(fadeUntil, performance.now() + ms);
    if (!looping) { looping = true; requestAnimationFrame(frame); }
  };
  dark = document.documentElement.dataset.theme === 'dark' ? 1 : 0; // start on the right theme, no fade
  wake();
  kick(600);
  if (!document.hasFocus()) sleep();
  addEventListener('resize', () => { last = 0; kick(400); });
  new MutationObserver(() => kick(1500)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver(() => { dark = document.documentElement.dataset.theme === 'dark' ? 1 : 0; kick(600); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-look'] }); // back from classic
}

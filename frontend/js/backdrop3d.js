// Live 3D backdrop behind every page: a field of burn-in traces rolling toward the viewer.
//
// Each row is one component's current across the 168 h burn-in, left to right. Most rows
// stay flat; a few drift (cyan) and a few climb late like latent defects (lime). Ridges rise
// on both sides of a calm valley, dust drifts above the field, a scan line sweeps the burn-in
// clock across it, the camera leans with the pointer and the scroll position, and a ripple
// runs through the field whenever a batch finishes screening.
//
// Plain WebGL 1, no libraries. Without WebGL the canvas stays hidden and the CSS aurora is the
// background. With reduced motion, or when the viewer pauses it, it renders one still frame.

const ROWS = 72;           // rows on screen at once
const SEGMENTS = 150;      // line segments per row
const SPACING = 1.15;      // world units between rows
const NEAR = 1.4;          // distance from z = 0 to the first row
const HALF_WIDTH = 36;     // rows run from x = -36 to x = 36
const PERIOD = 1024;       // row ids wrap after this many rows; the terrain noise repeats to match
const DUST_DEPTH = 96;     // depth of the dust volume
const DUST_MAX = 720;
const BASE_SPEED = 1.05;   // world units per second on the home page
const MOTION_KEY = 'sentinel.motion';

// How busy the field is on each page: the data pages keep it calm so charts stay readable.
const MOODS = {
  home: { intensity: 1, speed: 1 },
  upload: { intensity: 0.85, speed: 0.75 },
  overview: { intensity: 0.5, speed: 0.4 },
  components: { intensity: 0.42, speed: 0.35 },
  simulator: { intensity: 0.5, speed: 0.4 },
  method: { intensity: 0.62, speed: 0.5 },
};

const PALETTES = {
  dark: { far: [0.32, 0.2, 0.66], near: [0.68, 0.57, 1], edge: [0.13, 0.83, 0.93], hot: [0.78, 0.96, 0.2], scan: [0.6, 0.96, 1], gain: 1 },
  light: { far: [0.7, 0.64, 0.93], near: [0.42, 0.16, 0.85], edge: [0.03, 0.57, 0.7], hot: [0.3, 0.5, 0.03], scan: [0.03, 0.57, 0.7], gain: 0.8 },
};

/* ---------- shaders ---------- */

const COMMON = `
#define ROWS ${ROWS.toFixed(1)}
#define SEGMENTS ${SEGMENTS.toFixed(1)}
#define SPACING ${SPACING.toFixed(2)}
#define NEAR ${NEAR.toFixed(2)}
#define HALF_WIDTH ${HALF_WIDTH.toFixed(1)}
#define PERIOD ${PERIOD.toFixed(1)}
#define DUST_DEPTH ${DUST_DEPTH.toFixed(1)}

// Sine-free hashes (Dave Hoskins), stable on mobile GPUs.
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
`;

const LINE_VS = `
precision highp float;
${COMMON}
attribute vec3 a_vert;   // u across the row (0..1), row slot, side of the ribbon (-1 or 1)
uniform mat4 u_vp;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_phase;   // 0..SPACING: how far the rows have rolled toward the camera
uniform float u_cycles;  // whole rows rolled so far, wrapped at PERIOD
uniform float u_sweep;   // scan line position across the row
uniform float u_intensity;
uniform vec4 u_pulse;    // ripple centre x, z, age in seconds, strength
uniform vec3 u_far, u_near, u_edge, u_hot, u_scan;
varying vec4 v_color;
varying float v_side, v_half, v_core, v_aa;

// Value noise that repeats every 'per' cells along y, so the rolling field never shows a seam.
float noise(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, per);
  float y1 = mod(i.y + 1.0, per);
  float a = hash21(vec2(i.x, y0));
  float b = hash21(vec2(i.x + 1.0, y0));
  float c = hash21(vec2(i.x, y1));
  float d = hash21(vec2(i.x + 1.0, y1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float rowId(float slot) { return mod(slot + u_cycles, PERIOD); }

// 0 healthy, 1 drifting edge part, 2 latent defect
float kindOf(float id) {
  float r = hash11(id * 1.618 + 0.5);
  return r > 0.955 ? 2.0 : (r > 0.885 ? 1.0 : 0.0);
}

// The component's own burn-in current over the run.
float signal(float u, float id, float kind) {
  float uc = clamp(u, 0.0, 1.0);
  float s = 0.05 * sin(uc * 41.0 + id * 1.7);
  if (kind > 1.5) {
    float onset = 0.16 + 0.3 * hash11(id + 5.1);
    float p = max(0.0, (uc - onset) / (1.0 - onset));
    s += (2.0 + 1.8 * hash11(id + 9.2)) * pow(p, 1.6);
  } else if (kind > 0.5) {
    s += (0.7 + 0.6 * hash11(id + 2.3)) * pow(uc, 1.3);
  }
  return s;
}

// Ridges either side of a calm valley, so the middle of the screen stays quiet.
float terrain(float x, float id) {
  float side = smoothstep(4.0, 26.0, abs(x));
  float z = id * 0.125;
  float hills = noise(vec2(x * 0.08, z), PERIOD * 0.125) * 3.6
              + noise(vec2(x * 0.22 + 11.0, z * 2.0), PERIOD * 0.25) * 1.1;
  float swell = (noise(vec2(x * 0.05 + 3.0, z * 0.5), PERIOD * 0.0625) - 0.5) * 0.7;
  return hills * side * side + swell;
}

float ripple(vec2 xz) {
  if (u_pulse.w <= 0.0) return 0.0;
  float d = distance(xz, u_pulse.xy) - u_pulse.z * 16.0;
  return u_pulse.w * 1.4 * exp(-d * d * 0.06) * exp(-u_pulse.z * 0.7);
}

vec3 worldPos(float u, float slot, float id, float kind) {
  float x = (u * 2.0 - 1.0) * HALF_WIDTH;
  float z = -(NEAR + slot * SPACING - u_phase);
  return vec3(x, terrain(x, id) + signal(u, id, kind) + ripple(vec2(x, z)), z);
}

void main() {
  float u = a_vert.x;
  float slot = a_vert.y;
  float side = a_vert.z;
  float id = rowId(slot);
  float kind = kindOf(id);
  float du = 1.0 / SEGMENTS;

  vec3 p = worldPos(u, slot, id, kind);
  vec4 c = u_vp * vec4(p, 1.0);
  vec4 c0 = u_vp * vec4(worldPos(u - du, slot, id, kind), 1.0);
  vec4 c2 = u_vp * vec4(worldPos(u + du, slot, id, kind), 1.0);
  vec2 halfRes = 0.5 * u_res;
  vec2 dir = c2.xy / c2.w * halfRes - c0.xy / c0.w * halfRes;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  float depth = slot - u_phase / SPACING;                 // 0 is the nearest row
  float nearness = 1.0 - clamp(depth / (ROWS - 1.0), 0.0, 1.0);
  float near2 = nearness * nearness;
  float fade = smoothstep(-1.0, 1.5, depth) * (1.0 - smoothstep(ROWS - 16.0, ROWS - 1.0, depth));
  float ends = 1.0 - smoothstep(0.7, 1.0, abs(u * 2.0 - 1.0));
  float scan = exp(-pow((u - u_sweep) * 24.0, 2.0));
  float hot = step(1.5, kind);
  float edge = step(0.5, kind) * (1.0 - hot);

  vec3 col = mix(u_far, u_near, near2);
  col = mix(col, u_edge, edge * 0.85);
  col = mix(col, u_hot, hot * smoothstep(0.12, 0.55, u));
  col = mix(col, u_scan, scan * 0.7);

  float alpha = (0.08 + 0.55 * near2) * (1.0 + 0.8 * edge + 1.6 * hot);
  alpha *= 0.8 + 0.5 * clamp(p.y / 3.5, 0.0, 1.0);        // ridges catch more light
  alpha *= 1.0 + 1.4 * scan;
  alpha *= fade * ends * u_intensity;

  float core = (0.45 + 0.75 * nearness + 0.35 * hot) * u_dpr;
  float glow = (1.0 + hot * (3.0 + 6.0 * nearness) + scan * 2.5) * u_dpr;
  float halfW = core + glow;
  c.xy += normal * side * halfW / halfRes * c.w;

  gl_Position = c;
  v_color = vec4(col, min(alpha, 1.0));
  v_side = side;
  v_half = halfW;
  v_core = core;
  v_aa = 0.5 * u_dpr;
}
`;

const LINE_FS = `
precision mediump float;
varying vec4 v_color;
varying float v_side, v_half, v_core, v_aa;
void main() {
  float d = abs(v_side) * v_half;                            // px from the centre of the line
  float core = 1.0 - smoothstep(v_core - v_aa, v_core + v_aa, d);
  float glow = exp(-6.0 * d * d / (v_half * v_half)) * 0.45;
  float a = v_color.a * max(core, glow);
  gl_FragColor = vec4(v_color.rgb * a, a);
}
`;

const DUST_VS = `
precision highp float;
${COMMON}
attribute vec4 a_vert;   // x, y, z within the dust volume, seed
uniform mat4 u_vp;
uniform float u_time, u_roll, u_dpr, u_intensity;
uniform vec3 u_near, u_edge, u_hot;
varying vec4 v_color;
void main() {
  float seed = a_vert.w;
  float z = mod(a_vert.z + u_roll, DUST_DEPTH);            // 0 far, DUST_DEPTH near
  vec3 p = vec3(
    a_vert.x + sin(u_time * 0.07 + seed * 40.0) * 0.6,
    a_vert.y + sin(u_time * 0.21 + seed * 17.0) * 0.35,
    z - DUST_DEPTH + 6.0);
  vec4 c = u_vp * vec4(p, 1.0);
  gl_Position = c;
  float t = z / DUST_DEPTH;
  float fade = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(0.88, 1.0, t));
  float twinkle = 0.55 + 0.45 * sin(u_time * (0.6 + seed * 1.7) + seed * 50.0);
  vec3 col = seed < 0.07 ? u_hot : (seed < 0.4 ? u_edge : u_near);
  float size = (1.0 + 2.6 * fract(seed * 7.13)) * clamp(9.0 / max(c.w, 0.1), 0.35, 2.6);
  gl_PointSize = max(1.0, size * u_dpr * 2.0);
  v_color = vec4(col, fade * twinkle * u_intensity * 0.75);
}
`;

const DUST_FS = `
precision mediump float;
varying vec4 v_color;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = v_color.a * exp(-d * d * 4.5) * (1.0 - smoothstep(0.8, 1.0, d));
  gl_FragColor = vec4(v_color.rgb * a, a);
}
`;

/* ---------- small matrix kit (column-major, like WebGL) ---------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, target) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

/* ---------- WebGL helpers ---------- */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader did not compile');
  return shader;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_vert');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program did not link');
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const { name } = gl.getActiveUniform(p, i);
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function lineGeometry() {
  const verts = new Float32Array(ROWS * (SEGMENTS + 1) * 2 * 3);
  const index = new Uint16Array(ROWS * SEGMENTS * 6);
  let v = 0;
  let n = 0;
  for (let slot = 0; slot < ROWS; slot += 1) {
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const u = i / SEGMENTS;
      verts.set([u, slot, -1, u, slot, 1], v);
      v += 6;
      if (i < SEGMENTS) {
        const b = (slot * (SEGMENTS + 1) + i) * 2;
        index.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], n);
        n += 6;
      }
    }
  }
  return { verts, index };
}

function dustGeometry() {
  let a = 2463534242;
  const rand = () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return (a >>> 0) / 4294967296; };
  const verts = new Float32Array(DUST_MAX * 4);
  for (let i = 0; i < DUST_MAX; i += 1) {
    verts.set([(rand() * 2 - 1) * 34, 0.4 + rand() ** 1.6 * 15, rand() * DUST_DEPTH, rand()], i * 4);
  }
  return verts;
}

/* ---------- the backdrop ---------- */

export function createBackdrop(canvas) {
  const idle = { supported: false, setView() {}, setBusy() {}, pulse() {}, moving: () => false, setMotion: () => false };
  if (!canvas) return idle;

  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
    });
  } catch { gl = null; }
  if (!gl) { canvas.hidden = true; return idle; }

  let scene = null;
  const build = () => {
    const lines = program(gl, LINE_VS, LINE_FS);
    const dust = program(gl, DUST_VS, DUST_FS);
    const { verts, index } = lineGeometry();
    const lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const indexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    const dustBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, dustBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dustGeometry(), gl.STATIC_DRAW);
    scene = { lines, dust, lineBuf, indexBuf, dustBuf, indexCount: index.length };
  };

  try { build(); } catch (error) {
    console.warn('3D backdrop disabled:', error.message);
    canvas.hidden = true;
    return idle;
  }

  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let stored = null;
  try { stored = localStorage.getItem(MOTION_KEY); } catch { /* storage blocked */ }
  let moving = stored ? stored === 'on' : !reduce.matches;

  const state = {
    roll: 0, time: 0, sweep: 0, intro: 1,
    intensity: 0, speed: 0, target: MOODS.home, busy: false,
    px: 0, py: 0, scroll: 0,
    pulse: { age: 0, strength: 0 },
  };
  const pointer = { x: 0, y: 0 };
  let palette = PALETTES.dark;
  let raf = 0;
  let last = 0;
  let lost = false;
  let width = 0;
  let height = 0;
  let dpr = 1;

  const readTheme = () => { palette = document.documentElement.dataset.theme === 'light' ? PALETTES.light : PALETTES.dark; };
  readTheme();

  function resize() {
    const small = window.innerWidth < 640;
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (w !== width || h !== height) {
      width = w; height = h;
      canvas.width = w; canvas.height = h;
    }
  }

  function viewProjection() {
    const aspect = width / height;
    const fov = (aspect < 0.75 ? 70 : aspect < 1.25 ? 60 : 50) * Math.PI / 180;
    const ease = state.intro * state.intro * (3 - 2 * state.intro);
    const eye = [state.px * 1.8, 3.6 + state.scroll * 0.9 - state.py * 0.5 + ease * 7, 8 + ease * 6];
    const target = [state.px * 0.5, -0.6 - state.scroll * 1.3 + ease * 2, -44];
    return multiply(perspective(fov, aspect, 0.1, 220), lookAt(eye, target));
  }

  function draw() {
    if (lost || !scene) return;
    resize();
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const vp = viewProjection();
    // Past the first screen the field calms down, so section text and charts stay easy to read.
    const intensity = state.intensity * palette.gain * (1 - 0.45 * Math.min(1, state.scroll));
    const phase = state.roll % SPACING;
    const cycles = Math.floor(state.roll / SPACING) % PERIOD;
    const sweep = moving ? ((state.sweep % 7) / 7) * 1.5 - 0.25 : -1;
    const smallScreen = window.innerWidth < 640;

    const { dust, lines } = scene;
    gl.useProgram(dust.p);
    gl.uniformMatrix4fv(dust.u.u_vp, false, vp);
    gl.uniform1f(dust.u.u_time, state.time % 3600);
    gl.uniform1f(dust.u.u_roll, state.roll % DUST_DEPTH);
    gl.uniform1f(dust.u.u_dpr, dpr);
    gl.uniform1f(dust.u.u_intensity, intensity);
    gl.uniform3fv(dust.u.u_near, palette.near);
    gl.uniform3fv(dust.u.u_edge, palette.edge);
    gl.uniform3fv(dust.u.u_hot, palette.hot);
    gl.bindBuffer(gl.ARRAY_BUFFER, scene.dustBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, smallScreen ? 320 : DUST_MAX);

    gl.useProgram(lines.p);
    gl.uniformMatrix4fv(lines.u.u_vp, false, vp);
    gl.uniform2f(lines.u.u_res, width, height);
    gl.uniform1f(lines.u.u_dpr, dpr);
    gl.uniform1f(lines.u.u_phase, phase);
    gl.uniform1f(lines.u.u_cycles, cycles);
    gl.uniform1f(lines.u.u_sweep, sweep);
    gl.uniform1f(lines.u.u_intensity, intensity);
    gl.uniform4f(lines.u.u_pulse, 0, -18, state.pulse.age, state.pulse.strength);
    gl.uniform3fv(lines.u.u_far, palette.far);
    gl.uniform3fv(lines.u.u_near, palette.near);
    gl.uniform3fv(lines.u.u_edge, palette.edge);
    gl.uniform3fv(lines.u.u_hot, palette.hot);
    gl.uniform3fv(lines.u.u_scan, palette.scan);
    gl.bindBuffer(gl.ARRAY_BUFFER, scene.lineBuf);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.indexBuf);
    gl.drawElements(gl.TRIANGLES, scene.indexCount, gl.UNSIGNED_SHORT, 0);

    if (!canvas.classList.contains('is-ready')) canvas.classList.add('is-ready');
  }

  function step(dt) {
    const k = 1 - Math.exp(-dt * 2.2);
    const speedTarget = state.target.speed * (state.busy ? 4.5 : 1);
    state.intensity += (state.target.intensity - state.intensity) * k;
    state.speed += (speedTarget - state.speed) * k;
    state.roll += state.speed * BASE_SPEED * dt;
    state.sweep += dt * (state.busy ? 3 : 1);
    state.time += dt;
    state.intro = Math.max(0, state.intro - dt / 2.6);

    const kp = 1 - Math.exp(-dt * 2.5);
    state.px += (pointer.x - state.px) * kp;
    state.py += (pointer.y - state.py) * kp;
    const scrollTarget = Math.min(2.5, window.scrollY / Math.max(1, window.innerHeight));
    state.scroll += (scrollTarget - state.scroll) * (1 - Math.exp(-dt * 4));

    if (state.pulse.strength > 0) {
      state.pulse.age += dt;
      if (state.pulse.age > 7) state.pulse.strength = 0;
    }
  }

  function frame(now) {
    raf = 0;
    if (!moving || lost) return;
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / 62) return;   // hold to about 60 fps on high-refresh screens
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
  }

  // One still frame: settled camera, no scan line, mood applied at once.
  function still() {
    state.intro = 0;
    state.intensity = state.target.intensity;
    state.speed = state.target.speed;
    state.px = 0; state.py = 0; state.scroll = 0;
    state.pulse.strength = 0;
    draw();
  }

  function kick() {
    if (lost) return;
    if (moving) {
      if (!raf) { last = performance.now() - 16; raf = requestAnimationFrame(frame); }
    } else {
      cancelAnimationFrame(raf);
      raf = 0;
      still();
    }
  }

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { pointer.x = 0; pointer.y = 0; });
  window.addEventListener('resize', () => { if (!moving) still(); });
  new MutationObserver(() => { readTheme(); if (!moving) still(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  reduce.addEventListener('change', () => {
    if (stored) return;   // the viewer's own choice wins over the system setting
    moving = !reduce.matches;
    kick();
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    try { build(); kick(); } catch { canvas.hidden = true; }
  });

  kick();

  return {
    supported: true,
    moving: () => moving,
    setMotion(on) {
      moving = Boolean(on);
      stored = moving ? 'on' : 'off';
      try { localStorage.setItem(MOTION_KEY, stored); } catch { /* storage blocked */ }
      kick();
      return moving;
    },
    setView(view) {
      state.target = MOODS[view] || MOODS.home;
      if (!moving) still();
    },
    setBusy(on) { state.busy = Boolean(on); },
    pulse(strength = 1) {
      if (!moving) return;
      state.pulse.age = 0;
      state.pulse.strength = strength;
    },
  };
}

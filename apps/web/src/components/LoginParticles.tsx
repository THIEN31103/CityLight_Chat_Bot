import { useEffect, useRef } from 'react';

// Sign-in backdrop: a 3D point cloud that holds a street lamp, then melts into a light
// bulb and back. Plain WebGL, so the first page anyone loads pulls in no 3D library.

const COUNT_WIDE = 16000;
const COUNT_NARROW = 9000;
const FLOATS = 12; // lamp xyz + heat, bulb xyz + heat, scatter xyz + seed
const CYCLE = 16; // lamp 6 s, melt 2 s, bulb 6 s, melt 2 s
const INTRO = 1.8;
const BACKGROUND = [6 / 255, 8 / 255, 14 / 255] as const;

type Point = [x: number, y: number, z: number, heat: number];
type Rand = () => number;

function mulberry32(seed: number): Rand {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const POLE_X = -0.42;
const ARM_R = 0.34;
const HEAD_X = POLE_X + ARM_R + 0.36;
const HEAD_Y = 0.86;
const PANEL_Y = 0.79;

function ring(cx: number, r: number, a: number): [number, number] {
  return [cx + Math.cos(a) * r, Math.sin(a) * r];
}

function streetLamp(r: Rand): Point {
  const roll = r();
  if (roll < 0.3) {
    // pole, slightly tapered
    const y = lerp(-1.02, 0.5, r());
    const [x, z] = ring(POLE_X, lerp(0.05, 0.03, (y + 1.02) / 1.52), r() * TAU);
    return [x, y, z, 0.24];
  }
  if (roll < 0.34) {
    // foot of the pole
    const [x, z] = ring(POLE_X, 0.1, r() * TAU);
    return [x, lerp(-1.02, -0.9, r()), z, 0.3];
  }
  if (roll < 0.46) {
    // curved arm
    const th = lerp(Math.PI, Math.PI / 2, r());
    const a = r() * TAU;
    const off = Math.cos(a) * 0.028;
    return [POLE_X + ARM_R + Math.cos(th) * (ARM_R + off), 0.5 + Math.sin(th) * (ARM_R + off), Math.sin(a) * 0.028, 0.28];
  }
  if (roll < 0.62) {
    // lamp head
    const th = r() * TAU;
    const u = r() * 2 - 1;
    const s = Math.sqrt(1 - u * u);
    return [HEAD_X + s * Math.cos(th) * 0.42, HEAD_Y + u * 0.075, s * Math.sin(th) * 0.17, 0.42];
  }
  if (roll < 0.72) {
    // LED chips under the head
    const ix = Math.floor(r() * 9);
    const iz = Math.floor(r() * 3);
    const jit = () => (r() - 0.5) * 0.022;
    return [HEAD_X - 0.3 + ix * 0.075 + jit(), PANEL_Y, -0.09 + iz * 0.09 + jit(), 1];
  }
  const a = r() * TAU;
  const d = Math.sqrt(r());
  const gx = HEAD_X + Math.cos(a) * d * 1.05;
  const gz = Math.sin(a) * d * 0.8;
  if (roll < 0.93) {
    // beam reaching the road
    const t = Math.pow(r(), 0.8);
    const px = HEAD_X + (r() - 0.5) * 0.6;
    const pz = (r() - 0.5) * 0.2;
    return [lerp(px, gx, t), lerp(PANEL_Y, -1.02, t), lerp(pz, gz, t), 0.08 + 0.5 * Math.pow(1 - t, 1.4)];
  }
  // pool of light on the road
  return [gx, -1.02, gz, 0.1 + 0.3 * (1 - d)];
}

function lightBulb(r: Rand): Point {
  const roll = r();
  const a = r() * TAU;
  if (roll < 0.44) {
    // glass globe
    const u = Math.acos(lerp(1, -0.588, r()));
    const rad = Math.sin(u) * 0.68;
    return [Math.cos(a) * rad, 0.3 + Math.cos(u) * 0.68, Math.sin(a) * rad, 0.3];
  }
  if (roll < 0.52) {
    // glass neck, from the globe down to the cap
    const y = lerp(-0.5, -0.1, r());
    const rad = lerp(0.25, 0.55, Math.pow((y + 0.5) / 0.4, 1.5));
    return [Math.cos(a) * rad, y, Math.sin(a) * rad, 0.3];
  }
  if (roll < 0.7) {
    // screw cap, with its thread
    const y = lerp(-0.5, -0.92, r());
    const rad = lerp(0.25, 0.2, (-0.5 - y) / 0.42) + Math.sin(y * 62) * 0.018;
    return [Math.cos(a) * rad, y, Math.sin(a) * rad, 0.2];
  }
  if (roll < 0.86) {
    // filament coil
    const t = r();
    const turn = t * TAU * 14;
    return [lerp(-0.24, 0.24, t) + Math.cos(turn) * 0.018, 0.2 + Math.sin(t * Math.PI) * 0.1 + Math.sin(turn) * 0.03, Math.cos(turn + 1) * 0.03, 1];
  }
  if (roll < 0.9) {
    // filament supports
    const t = r();
    const side = r() < 0.5 ? -1 : 1;
    return [side * lerp(0.24, 0.09, t), lerp(0.2, -0.45, t), 0, 0.5];
  }
  // glow around the filament
  const d = Math.pow(r(), 2) * 0.44;
  const th = Math.acos(r() * 2 - 1);
  return [Math.sin(th) * Math.cos(a) * d, 0.24 + Math.cos(th) * d, Math.sin(th) * Math.sin(a) * d, 0.42 * (1 - d / 0.44) + 0.06];
}

function buildPoints(count: number): Float32Array {
  const r = mulberry32(20261107);
  const data = new Float32Array(count * FLOATS);
  for (let i = 0; i < count; i++) {
    const a = streetLamp(r);
    const b = lightBulb(r);
    const th = r() * TAU;
    const u = r() * 2 - 1;
    const s = Math.sqrt(1 - u * u);
    data.set([...a, ...b, s * Math.cos(th), u, s * Math.sin(th), r()], i * FLOATS);
  }
  return data;
}

const VERTEX = `
attribute vec4 aLamp;
attribute vec4 aBulb;
attribute vec4 aDrift;
uniform mat3 uRotation;
uniform vec2 uCentre;
uniform vec2 uPointer;
uniform float uScale;
uniform float uAspect;
uniform float uMorph;
uniform float uScatter;
uniform float uTime;
uniform float uPointSize;
uniform float uPointerOn;
varying float vHeat;
varying float vDepth;

void main() {
  float seed = aDrift.w;
  float m = smoothstep(seed * 0.4, 0.6 + seed * 0.4, uMorph);
  float melt = sin(m * 3.14159);
  vec3 p = mix(aLamp.xyz, aBulb.xyz, m);
  p += aDrift.xyz * (uScatter * 2.4 + melt * 0.28 + 0.006 * sin(uTime * (0.8 + seed) + seed * 6.28));
  vec3 q = uRotation * p;
  float persp = 3.0 / (3.6 + q.z);
  vec2 ndc = q.xy * persp * uScale;
  ndc.x /= uAspect;
  ndc += uCentre;

  vec2 away = (ndc - uPointer) * vec2(uAspect, 1.0);
  float near = uPointerOn * smoothstep(0.34, 0.0, length(away));
  ndc += normalize(away + 0.00001) * near * 0.09 / vec2(uAspect, 1.0);

  vHeat = mix(aLamp.w, aBulb.w, m);
  vDepth = clamp((1.0 - q.z) * 0.5, 0.0, 1.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = max(1.0, uPointSize * (1.0 + vHeat * 1.5) * persp);
}`;

const FRAGMENT = `
precision mediump float;
varying float vHeat;
varying float vDepth;

void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  vec3 colour = mix(vec3(0.66, 0.44, 0.17), vec3(1.0, 0.82, 0.48), vHeat);
  colour = mix(colour, vec3(1.0, 0.97, 0.9), smoothstep(0.8, 1.0, vHeat));
  float alpha = smoothstep(0.5, 0.08, d) * (0.3 + 0.7 * vHeat) * mix(0.4, 1.0, vDepth);
  gl_FragColor = vec4(colour, alpha);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** mat3 for yaw then pitch, column-major as WebGL wants it. */
function rotation(yaw: number, pitch: number) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return new Float32Array([cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
}

function morphAt(t: number) {
  const c = t % CYCLE;
  const step = (x: number) => x * x * (3 - 2 * x);
  if (c < 6) return 0;
  if (c < 8) return step((c - 6) / 2);
  if (c < 14) return 1;
  return 1 - step((c - 14) / 2);
}

export function LoginParticles() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
    if (!canvas || !gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const total = window.innerWidth < 1024 ? COUNT_NARROW : COUNT_WIDE;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, buildPoints(total), gl.STATIC_DRAW);
    (['aLamp', 'aBulb', 'aDrift'] as const).forEach((name, i) => {
      const at = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 4, gl.FLOAT, false, FLOATS * 4, i * 16);
    });

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRotation = u('uRotation');
    const uCentre = u('uCentre');
    const uPointer = u('uPointer');
    const uScale = u('uScale');
    const uAspect = u('uAspect');
    const uMorph = u('uMorph');
    const uScatter = u('uScatter');
    const uTime = u('uTime');
    const uPointSize = u('uPointSize');
    const uPointerOn = u('uPointerOn');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fit = () => {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const wide = w >= 1024;
      gl.uniform1f(uAspect, w / h);
      gl.uniform2f(uCentre, wide ? 0.1 : 0, wide ? -0.02 : 0.55);
      gl.uniform1f(uScale, wide ? 0.9 : 0.44);
      gl.uniform1f(uPointSize, dpr * (wide ? 2 : 1.7));
    };

    let raf = 0;
    let count = total;
    let start = 0;
    let last = 0;
    let slowFrames = 0;
    let frames = 0;
    let lost = false;
    const target = { x: 0, y: 0, on: 0 };
    const eased = { x: 0, y: 0, on: 0 };

    const paint = (t: number, intro: number) => {
      eased.x += (target.x - eased.x) * 0.06;
      eased.y += (target.y - eased.y) * 0.06;
      eased.on += (target.on - eased.on) * 0.08;
      gl.uniformMatrix3fv(uRotation, false, rotation(Math.sin(t * 0.32) * 0.75 + eased.x * 0.35, 0.1 + eased.y * 0.18));
      gl.uniform2f(uPointer, eased.x, eased.y);
      gl.uniform1f(uPointerOn, eased.on);
      gl.uniform1f(uMorph, morphAt(t));
      gl.uniform1f(uScatter, intro);
      gl.uniform1f(uTime, t);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, count);
    };

    const frame = (now: number) => {
      if (lost) return;
      if (!start) start = now;
      const dt = now - last;
      last = now;
      // A weak machine still gets a smooth page: the points are in random order, so half of them keep the shape.
      if (frames < 90 && dt < 200 && dt > 0) {
        frames++;
        if (dt > 34) slowFrames++;
        if (frames === 90 && slowFrames > 45) count = Math.floor(total / 2);
      }
      const t = (now - start) / 1000;
      const k = Math.min(t / INTRO, 1);
      paint(t, Math.pow(1 - k, 3));
      raf = requestAnimationFrame(frame);
    };

    const render = () => {
      fit();
      if (still) paint(1.2, 0);
    };
    const resize = new ResizeObserver(render);
    resize.observe(canvas);
    render();

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = 1 - (e.clientY / window.innerHeight) * 2;
      target.on = 1;
    };
    const onLeave = () => {
      target.on = 0;
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      cancelAnimationFrame(raf);
    };
    canvas.addEventListener('webglcontextlost', onLost);

    if (!still) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
    };
  }, []);

  return <canvas ref={ref} className="login-canvas" aria-hidden="true" />;
}

// Production U3D encoder adapted from the repository’s verified U3D test writer.
const STATIC_FULL = 0x400;
const MAX_RANGE = STATIC_FULL + 0x3fff;
const ELEPHANT = 0x1fff;

const SWAP8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b);
  SWAP8[i] = r;
}

class NaiveHistogram {
  constructor() { this.c = [1]; this.total = 1; }
  range(sym) {
    let lo = 0;
    for (let s = 0; s < sym; s++) lo += this.c[s] || 0;
    return [lo, lo + (this.c[sym] || 0)];
  }
  add(sym) {
    if (sym > 0xffff) return;
    if (this.total >= ELEPHANT) {
      let t = 0;
      for (let i = 0; i < this.c.length; i++) { this.c[i] >>= 1; t += this.c[i]; }
      this.c[0] += 1;
      this.total = t + 1;
    }
    while (this.c.length <= sym) this.c.push(0);
    this.c[sym] += 1;
    this.total += 1;
  }
}

/** Bit writer for one block: plain values until the first compressed one. */
class BitWriter {
  constructor() {
    this.bits = [];
    this.ac = false;
    this.hist = new Map();
  }

  bit(b) { this.bits.push(b & 1); }

  startAc() {
    this.ac = true;
    this.low = 0;
    this.high = 0xffff;
    this.pending = 0;
  }

  out(b) {
    this.bit(b);
    for (; this.pending > 0; this.pending--) this.bit(1 - b);
  }

  encode(lo, hi, total) {
    const rng = this.high - this.low + 1;
    this.high = this.low + Math.floor((rng * hi) / total) - 1;
    this.low = this.low + Math.floor((rng * lo) / total);
    for (;;) {
      if (this.high < 0x8000) {
        this.out(0);
      } else if (this.low >= 0x8000) {
        this.out(1);
        this.low -= 0x8000; this.high -= 0x8000;
      } else if (this.low >= 0x4000 && this.high < 0xc000) {
        this.pending++;
        this.low -= 0x4000; this.high -= 0x4000;
      } else {
        break;
      }
      this.low <<= 1;
      this.high = (this.high << 1) | 1;
    }
  }

  u8(v) {
    if (!this.ac) { for (let k = 0; k < 8; k++) this.bit(v >> k); return; }
    const s = SWAP8[v & 0xff];
    this.encode(s, s + 1, 256);
  }
  u16(v) { this.u8(v & 0xff); this.u8((v >> 8) & 0xff); }
  u32(v) { this.u16(v & 0xffff); this.u16(Math.floor(v / 0x10000) & 0xffff); }
  u64(v) { this.u32(v % 0x100000000); this.u32(Math.floor(v / 0x100000000)); }
  f32(v) { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, true); this.u32(dv.getUint32(0, true)); }
  f64(v) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v, true); this.u32(dv.getUint32(0, true)); this.u32(dv.getUint32(4, true)); }
  string(s) {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    for (const x of b) this.u8(x);
  }

  cu32(ctx, v) {
    if (!(ctx && ctx < MAX_RANGE)) { this.u32(v); return; }
    if (!this.ac) this.startAc();
    if (ctx > STATIC_FULL) {
      const n = ctx - STATIC_FULL;
      if (!(v >= 0 && v < n)) throw new Error(`value ${v} outside static range ${n}`);
      this.encode(v, v + 1, n);
      return;
    }
    let h = this.hist.get(ctx);
    if (!h) { h = new NaiveHistogram(); this.hist.set(ctx, h); }
    const sym = v + 1;
    if (sym <= 0xffff && (h.c[sym] || 0) > 0) {
      const [lo, hi] = h.range(sym);
      this.encode(lo, hi, h.total);
      h.add(sym);
    } else {
      const [lo, hi] = h.range(0);
      this.encode(lo, hi, h.total);
      h.add(0);
      this.u32(v);
      h.add(sym);
    }
  }

  /** The block's data bytes (the arithmetic coder flushed, padded to a byte). */
  bytes() {
    if (this.ac) {
      this.pending++;
      this.out(this.low < 0x4000 ? 0 : 1);
      this.ac = false;
    }
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 1 << (i & 7); });
    return out;
  }
}

/** One block: type, data size, meta size, data, padding to 4 bytes. */
function block(type, data) {
  const pad = (4 - (data.length % 4)) % 4;
  const out = new Uint8Array(12 + data.length + pad);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, type >>> 0, true);
  dv.setUint32(4, data.length, true);
  dv.setUint32(8, 0, true);
  out.set(data, 12);
  return out;
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function chain(name, chainType, inner) {
  const w = new BitWriter();
  w.string(name);
  w.u32(chainType);
  w.u32(0); // no bounds
  let head = w.bytes();
  const pad = (4 - (head.length % 4)) % 4;
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, inner.length, true);
  return block(0xffffff14, concat([head, new Uint8Array(pad), count, ...inner]));
}


const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function parents(w, list) {
  w.u32(list.length);
  for (const p of list) {
    w.string(p.name);
    for (const v of p.matrix || IDENTITY) w.f32(v);
  }
}
/**
 * Build a real ECMA-363 U3D stream from an array of triangle meshes.
 * This is limited to CLOD base meshes and diffuse-color materials. It does
 * not implement PRC, CAD solids, line primitives, progressive meshes or PBR.
 * Coordinates are the model coordinates supplied by the 3D equipment palette.
 */
export function encodeU3D(mesh, name = 'Equipment') {
  if (!mesh || !Array.isArray(mesh.triangles) || !mesh.triangles.length) throw new Error('Model has no 3D triangles');
  if (mesh.triangles.length > 3500) throw new Error('Model has too many triangles for lightweight U3D encoder');
  const counts = new Map();
  for (const t of mesh.triangles) counts.set(t.color || '#8a99a6', (counts.get(t.color || '#8a99a6') || 0) + 1);
  // Palette cylinders may generate dozens of slightly different shades.
  // Keep the 48 most common colors and map rarer tones to the nearest color.
  const colors = [...counts].sort((a,b) => b[1]-a[1]).slice(0,48).map(([c]) => c);
  const colorIndex = new Map(colors.map((c, i) => [c, i]));
  const rgbOf = hex => /^#[a-fA-F0-9]{6}$/.test(hex) ? [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)) : [138,153,166];
  function indexForColor(hex) {
    if (colorIndex.has(hex)) return colorIndex.get(hex);
    const rgb = rgbOf(hex);
    let best = 0, distance = Infinity;
    for(let i=0; i<colors.length; i++) {
      const candidate = rgbOf(colors[i]);
      const d = rgb.reduce((sum,v,k)=>sum+(v-candidate[k])**2,0);
      if(d<distance){distance=d;best=i;}
    }
    return best;
  }
  const vertices = [];
  const indices = [];
  const groups = [];
  const positionIndex = new Map();
  function vert(p) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new Error('Invalid 3D vertex');
    const key = p.map(x => Number(x).toPrecision(8)).join(',');
    let i = positionIndex.get(key);
    if (i == null) { i = vertices.length; vertices.push(p.map(Number)); positionIndex.set(key, i); }
    return i;
  }
  for (const t of mesh.triangles) {
    indices.push([vert(t.a), vert(t.b), vert(t.c)]);
    groups.push(indexForColor(t.color || '#8a99a6'));
  }
  if (vertices.length > 0x3fff) throw new Error('Model exceeds U3D lightweight vertex limit');
  const meshName = 'EquipmentMesh';
  const shaderNames = colors.map((c, i) => `Shader${i}`);
  const materialNames = colors.map((c, i) => `Material${i}`);
  const header = (() => {
    const w = new BitWriter(); w.u32(0); w.u32(0); w.u32(0); w.u64(0); w.u32(106);
    return block(0x00443355, w.bytes());
  })();
  const modelNode = (() => {
    const w = new BitWriter(); w.string(name); parents(w, [{ name:'', matrix: IDENTITY }]);
    w.string(meshName); w.u32(3); return block(0xffffff22, w.bytes());
  })();
  const shading = (() => {
    const w = new BitWriter(); w.string(name); w.u32(0); w.u32(0); w.u32(colors.length);
    for (const shader of shaderNames) { w.u32(1); w.string(shader); }
    return block(0xffffff45, w.bytes());
  })();
  const decl = (() => {
    const w = new BitWriter(); w.string(meshName); w.u32(0); w.u32(1); // no normals
    w.u32(indices.length); w.u32(vertices.length); w.u32(0); w.u32(0); w.u32(0); w.u32(0);
    w.u32(colors.length);
    for (let g = 0; g < colors.length; g++) { w.u32(0); w.u32(0); w.u32(g); }
    return block(0xffffff31, w.bytes());
  })();
  const shader = (name, material) => {
    const w = new BitWriter(); w.string(name); w.u32(0); w.f32(0); w.u32(0); w.u32(0);
    w.u32(1); w.u32(0); w.u32(0); w.string(material);
    return block(0xffffff53, w.bytes());
  };
  const material = (name, hex) => {
    const color = /^#[a-fA-F0-9]{6}$/.test(hex) ? hex : '#8a99a6';
    const rgb = [1,3,5].map(i => parseInt(color.slice(i, i+2), 16) / 255);
    const w = new BitWriter(); w.string(name); w.u32(0x3f);
    for (const x of [0.1,0.1,0.1,...rgb,0,0,0,0,0,0]) w.f32(x);
    w.f32(0); w.f32(1); return block(0xffffff54, w.bytes());
  };
  const baseMesh = (() => {
    const w = new BitWriter(); w.string(meshName); w.u32(0);
    w.u32(indices.length); w.u32(vertices.length); w.u32(0); w.u32(0); w.u32(0); w.u32(0);
    for (const p of vertices) for (const v of p) w.f32(v);
    for (let i=0; i<indices.length; i++) {
      w.cu32(1, groups[i]);
      for (const idx of indices[i]) w.cu32(STATIC_FULL + vertices.length, idx);
    }
    return block(0xffffff3b, w.bytes());
  })();
  return concat([
    header, chain(name, 0, [modelNode, shading]), chain(meshName, 1, [decl]),
    ...shaderNames.map((n,i) => shader(n,materialNames[i])),
    ...colors.map((c,i) => material(materialNames[i],c)),
    baseMesh,
  ]);
}

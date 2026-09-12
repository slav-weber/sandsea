import { CHUNK, STRIDE, bakeChunk } from './dunes.js';

const MAX_DIST = 3600;
const MAX_IN_FLIGHT = 4;

function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

/**
 * Manages the heightmap chunks around the camera. Bakes asynchronously in a
 * Web Worker when available, with a synchronous fallback for environments
 * where Workers aren't usable (e.g. SSR, tests).
 */
export class ChunkManager {
  constructor(getParams, { worker } = {}) {
    this.getParams = getParams;
    this.chunks = new Map(); // key → Float32Array
    this.queue = []; // pending [cx, cz]
    this.requested = new Set(); // keys awaiting bake (queued or in-flight)
    this.camera = { x: 0, z: 0 };
    this.version = 0; // bumps on rebuild — stale worker results ignored

    this.worker = worker ?? null;
    this.inFlight = new Map(); // key → version
    if (this.worker) {
      this.worker.onmessage = (e) => this._onWorkerResult(e.data);
    }
  }

  setCamera(x, z) {
    this.camera.x = x;
    this.camera.z = z;
  }

  request(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.requested.has(key)) return;
    this.requested.add(key);
    this.queue.push([cx, cz]);
  }

  ensureVisible() {
    const half = MAX_DIST;
    const cx = this.camera.x;
    const cz = this.camera.z;
    const minCx = Math.floor((cx - half) / CHUNK);
    const maxCx = Math.floor((cx + half) / CHUNK);
    const minCz = Math.floor((cz - half * 0.3) / CHUNK);
    const maxCz = Math.floor((cz + half) / CHUNK);
    for (let z = minCz; z <= maxCz; z++) {
      for (let x = minCx; x <= maxCx; x++) {
        const ccx = x * CHUNK + CHUNK / 2;
        const ccz = z * CHUNK + CHUNK / 2;
        const dx = ccx - cx;
        const dz = ccz - cz;
        if (dx * dx + dz * dz > half * half) continue;
        this.request(x, z);
      }
    }
  }

  sortQueueByDistance() {
    const cx = this.camera.x;
    const cz = this.camera.z;
    this.queue.sort((a, b) => {
      const dxA = a[0] * CHUNK + CHUNK / 2 - cx,
        dzA = a[1] * CHUNK + CHUNK / 2 - cz;
      const dxB = b[0] * CHUNK + CHUNK / 2 - cx,
        dzB = b[1] * CHUNK + CHUNK / 2 - cz;
      return dxA * dxA + dzA * dzA - (dxB * dxB + dzB * dzB);
    });
  }

  processQueue(budgetMs = 12) {
    if (this.queue.length === 0) return;
    if (this.worker) {
      this._dispatchToWorker();
    } else {
      this._processSync(budgetMs);
    }
  }

  _dispatchToWorker() {
    this.sortQueueByDistance();
    while (this.queue.length > 0 && this.inFlight.size < MAX_IN_FLIGHT) {
      const [cx, cz] = this.queue.shift();
      const key = chunkKey(cx, cz);
      this.inFlight.set(key, this.version);
      this.worker.postMessage({
        version: this.version,
        cx,
        cz,
        params: this.getParams(),
      });
    }
  }

  _onWorkerResult({ version, cx, cz, buffer }) {
    const key = chunkKey(cx, cz);
    this.inFlight.delete(key);
    if (version !== this.version) {
      // Stale: a rebuild happened while this chunk was baking.
      this.requested.delete(key);
      return;
    }
    this.chunks.set(key, new Float32Array(buffer));
    this.requested.delete(key);
  }

  _processSync(budgetMs) {
    this.sortQueueByDistance();
    const t0 = performance.now();
    const params = this.getParams();
    while (this.queue.length > 0 && performance.now() - t0 < budgetMs) {
      const [cx, cz] = this.queue.shift();
      const key = chunkKey(cx, cz);
      this.requested.delete(key);
      this.chunks.set(key, bakeChunk(cx, cz, params));
    }
  }

  evictFar() {
    const r = MAX_DIST * 1.4;
    const r2 = r * r;
    const cx = this.camera.x;
    const cz = this.camera.z;
    for (const key of this.chunks.keys()) {
      const [cxs, czs] = key.split(',');
      const ccx = parseInt(cxs, 10) * CHUNK + CHUNK / 2 - cx;
      const ccz = parseInt(czs, 10) * CHUNK + CHUNK / 2 - cz;
      if (ccx * ccx + ccz * ccz > r2) this.chunks.delete(key);
    }
  }

  rebuild() {
    this.version++;
    this.chunks.clear();
    this.queue.length = 0;
    this.requested.clear();
    this.inFlight.clear();
    this.ensureVisible();
    if (!this.worker) {
      // Sync mode: bake a burst right away so first frame isn't empty.
      this.sortQueueByDistance();
      const t0 = performance.now();
      const params = this.getParams();
      while (this.queue.length > 0 && performance.now() - t0 < 200) {
        const [cx, cz] = this.queue.shift();
        const key = chunkKey(cx, cz);
        this.requested.delete(key);
        this.chunks.set(key, bakeChunk(cx, cz, params));
      }
    }
  }

  heightAt(x, z) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const arr = this.chunks.get(chunkKey(cx, cz));
    if (!arr) return 0;
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    const ix = lx | 0,
      iz = lz | 0;
    const fx = lx - ix,
      fz = lz - iz;
    const h00 = arr[iz * STRIDE + ix];
    const h10 = arr[iz * STRIDE + ix + 1];
    const h01 = arr[(iz + 1) * STRIDE + ix];
    const h11 = arr[(iz + 1) * STRIDE + ix + 1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  get pendingCount() {
    return this.queue.length + this.inFlight.size;
  }
}

export { CHUNK, STRIDE, MAX_DIST };

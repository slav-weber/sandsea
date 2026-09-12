import { hash2, vnoise } from './noise.js';

export const CHUNK = 128;
export const STRIDE = CHUNK + 1;
const TAU = Math.PI * 2;

function duneContribAdd(arr, baseX, baseZ, dCx, dCz, ca, sa, length, width, heightAmp, asym) {
  const reach = length * 1.05;
  const xMin = Math.max(0, Math.floor(dCx - baseX - reach));
  const xMax = Math.min(CHUNK, Math.ceil(dCx - baseX + reach));
  const zMin = Math.max(0, Math.floor(dCz - baseZ - reach));
  const zMax = Math.min(CHUNK, Math.ceil(dCz - baseZ + reach));
  if (xMin > xMax || zMin > zMax) return;
  const invL = 1 / length;
  const invW = 1 / width;
  const asym1 = 1 + asym;
  for (let pz = zMin; pz <= zMax; pz++) {
    const rdz = baseZ + pz - dCz;
    for (let px = xMin; px <= xMax; px++) {
      const rdx = baseX + px - dCx;
      const lrx = rdx * ca + rdz * sa;
      const lrz = -rdx * sa + rdz * ca;
      const nx = lrx * invL;
      const nz = lrz * invW;
      const r2 = nx * nx + nz * nz;
      if (r2 >= 1) continue;
      let bell = 1 - r2;
      bell = bell * bell * bell;
      if (nx > 0) {
        const drop = 1 - nx * asym1;
        if (drop <= 0) continue;
        bell *= drop;
      }
      arr[pz * STRIDE + px] += bell * heightAmp;
    }
  }
}

/**
 * Bake the heightmap for a single chunk into a Float32Array of size STRIDE*STRIDE.
 * params: { cellSize, emptyRate, duneLengthMin/Max, duneHeightMin/Max, seed }
 */
export function bakeChunk(cx, cz, params) {
  const arr = new Float32Array(STRIDE * STRIDE);
  const baseX = cx * CHUNK;
  const baseZ = cz * CHUNK;
  const CS = params.cellSize;
  const emptyT = params.emptyRate / 100;
  const lMin = Math.min(params.duneLengthMin, params.duneLengthMax);
  const lMax = Math.max(params.duneLengthMin, params.duneLengthMax);
  const lRange = lMax - lMin;
  const hMin = Math.min(params.duneHeightMin, params.duneHeightMax);
  const hMax = Math.max(params.duneHeightMin, params.duneHeightMax);
  const hRange = hMax - hMin;
  const seedOff = params.seed * 17;

  const reach = Math.ceil((lMax * 1.1) / CS) + 1;
  const cellCXMin = Math.floor(baseX / CS) - reach;
  const cellCXMax = Math.floor((baseX + CHUNK) / CS) + reach;
  const cellCZMin = Math.floor(baseZ / CS) - reach;
  const cellCZMax = Math.floor((baseZ + CHUNK) / CS) + reach;

  for (let ccz = cellCZMin; ccz <= cellCZMax; ccz++) {
    for (let ccx = cellCXMin; ccx <= cellCXMax; ccx++) {
      const r6 = hash2(ccx + 37 + seedOff, ccz + 41);
      if (r6 < emptyT) continue;
      const r1 = hash2(ccx + seedOff, ccz);
      const r2v = hash2(ccx + 7 + seedOff, ccz + 7);
      const r3 = hash2(ccx + 13 + seedOff, ccz + 17);
      const r4 = hash2(ccx + 19 + seedOff, ccz + 23);
      const r5 = hash2(ccx + 29 + seedOff, ccz + 31);
      const dCx = ccx * CS + r1 * CS;
      const dCz = ccz * CS + r2v * CS;
      const angle = r3 * TAU;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const length = lMin + r4 * lRange;
      const width = (lMin + r5 * lRange) * 0.7;
      const heightAmp = hMin + r6 * hRange;
      const asym = 0.4 + r4 * 0.6;
      duneContribAdd(arr, baseX, baseZ, dCx, dCz, ca, sa, length, width, heightAmp, asym);
    }
  }

  // Base relief under the dunes: gentle swells plus ripples
  for (let z = 0; z <= CHUNK; z++) {
    for (let x = 0; x <= CHUNK; x++) {
      const wx = baseX + x;
      const wz = baseZ + z;
      const ground =
        (Math.sin(wx * 0.003) * 0.3 +
          Math.sin(wz * 0.0025) * 0.3 +
          Math.sin((wx + wz) * 0.0017) * 0.2) *
        4;
      const ripple = (vnoise(wx * 0.15, wz * 0.12) - 0.5) * 1.5;
      arr[z * STRIDE + x] += ground + ripple;
    }
  }

  return arr;
}

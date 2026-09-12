export function hash2(x, z) {
  let n = ((x | 0) * 374761393 + (z | 0) * 668265263) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  n = n ^ (n >>> 16);
  return ((n >>> 0) & 65535) / 65535;
}

export function vnoise(x, z) {
  const ix = Math.floor(x),
    iz = Math.floor(z);
  const fx = x - ix,
    fz = z - iz;
  const h00 = hash2(ix, iz);
  const h10 = hash2(ix + 1, iz);
  const h01 = hash2(ix, iz + 1);
  const h11 = hash2(ix + 1, iz + 1);
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = h00 + (h10 - h00) * sx;
  const b = h01 + (h11 - h01) * sx;
  return a + (b - a) * sz;
}

import { bakeChunk } from './dunes.js';

self.onmessage = (e) => {
  const { id, version, cx, cz, params } = e.data;
  const arr = bakeChunk(cx, cz, params);
  self.postMessage({ id, version, cx, cz, buffer: arr.buffer }, [arr.buffer]);
};

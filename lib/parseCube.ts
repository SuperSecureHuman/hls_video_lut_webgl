export interface CubeData {
  size: number;
  data: Float32Array; // flat R,G,B,R,G,B... in R-fastest order (same as .cube spec)
}

export async function parseCube(url: string): Promise<CubeData> {
  const text = await fetch(url).then((r) => r.text());
  const lines = text.split(/\r?\n/);

  let size = 0;
  const floats: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (line.startsWith('DOMAIN_MIN') || line.startsWith('DOMAIN_MAX')) continue;
    if (line.startsWith('TITLE') || line.startsWith('LUT_1D_SIZE')) continue;

    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const r = parseFloat(parts[0]);
      const g = parseFloat(parts[1]);
      const b = parseFloat(parts[2]);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        floats.push(r, g, b);
      }
    }
  }

  if (size === 0) throw new Error('LUT_3D_SIZE not found in .cube file');
  const expected = size * size * size;
  if (floats.length !== expected * 3) {
    throw new Error(`Expected ${expected * 3} floats, got ${floats.length}`);
  }

  return { size, data: new Float32Array(floats) };
}

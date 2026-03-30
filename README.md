# webgl-hls-video-lut

A Next.js / React component that plays an HLS video stream and applies a 3D CUBE color lookup table (LUT) in real-time using WebGL2.

No Three.js, no heavy rendering frameworks — just HLS.js, raw WebGL2, and a GLSL fragment shader.

---

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000
```

---

## Project structure

```
components/
  HlsLutPlayer.tsx   — React component: HLS.js wiring + WebGL render loop + slider UI
lib/
  parseCube.ts       — .cube file parser → Float32Array
  lutShader.ts       — GLSL 300 es vertex and fragment shader source strings
pages/
  index.tsx          — Demo page (SSR disabled via next/dynamic)
public/
  BW1.cube           — 32×32×32 LUT (Catch-A-Fire warm colour grade, AdobeRGB1998)
```

---

## How it works

### Pipeline overview

```
HLS .m3u8 stream
      │
      ▼
  <video> element (hidden, in DOM)
   └─ HLS.js feeds segments via Media Source Extensions
      │
      ▼ every frame (requestAnimationFrame)
  gl.texImage2D(video) ──► TEXTURE_2D  (slot 0)
  BW1.cube (parsed once) ─► TEXTURE_3D  (slot 1)
      │
      ▼
  GLSL fragment shader
   ├─ sample video texture at UV coordinate
   ├─ use RGB value as 3D texture coordinate into LUT
   └─ mix(original, graded, uLutStrength) → fragColor
      │
      ▼
  <canvas> (what the user sees)
```

### 1. HLS playback — `HlsLutPlayer.tsx`

HLS.js attaches to a hidden `<video>` element and feeds MPEG-TS segments via the browser's [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) API. The video element stays in the DOM (required by HLS.js) but is hidden with CSS (`width: 0; height: 0; opacity: 0`).

Safari supports HLS natively, so HLS.js is bypassed there:

```ts
if (Hls.isSupported()) {
  hls = new Hls();
  hls.loadSource(url);
  hls.attachMedia(video);
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = url; // Safari native HLS
}
```

`crossOrigin="anonymous"` is required on the `<video>` element whenever the HLS stream is cross-origin. Without it the browser taints the WebGL canvas and `texImage2D` will throw a security error.

---

### 2. .cube file format — `lib/parseCube.ts`

The `.cube` format is a plain-text 3D LUT defined by Adobe/Autodesk:

```
# comment
LUT_3D_SIZE 32          ← grid is 32×32×32 = 32,768 entries
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.142824 0.133608 0.164614   ← one output RGB per line, normalized [0,1]
0.143954 0.134676 0.165713
...
```

Iteration order is **R-fastest**: the red axis increments first, then green, then blue. This matches the axis layout of a WebGL `TEXTURE_3D` when uploaded with `texImage3D` (width=R, height=G, depth=B).

The parser:
1. Skips comment (`#`) and header lines.
2. Reads each data line as three floats.
3. Returns `{ size: 32, data: Float32Array }` with `size³ × 3` elements.

Floats are then quantised to `Uint8` (×255) before upload — `RGB8` is sufficient for a 32-point grid with trilinear interpolation.

---

### 3. GLSL shaders — `lib/lutShader.ts`

Both shaders target **GLSL ES 3.00** (`#version 300 es`), which requires WebGL2.

#### Vertex shader

Draws a fullscreen quad (two triangles, 6 vertices) covering clip space `[-1, 1]²`. Maps to UV `[0, 1]²` with Y flipped to match video orientation:

```glsl
vTexCoord = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
```

#### Fragment shader

```glsl
uniform sampler2D uVideo;      // current video frame  (slot 0)
uniform sampler3D uLut;        // 32×32×32 LUT         (slot 1)
uniform float     uLutSize;    // 32.0
uniform float     uLutStrength; // 0.0 – 1.0

void main() {
  vec4 raw   = texture(uVideo, vTexCoord);
  vec3 color = raw.rgb;

  // Remap [0,1] to LUT texel centres
  float scale   = (uLutSize - 1.0) / uLutSize;   // 31/32
  float offset  = 0.5 / uLutSize;                  // 0.5/32
  vec3  lutCoord = color * scale + offset;

  vec3 graded = texture(uLut, lutCoord).rgb;
  fragColor   = vec4(mix(color, graded, uLutStrength), raw.a);
}
```

**Texel centre remapping** is the critical correctness detail. A 32-point LUT stored in a 32-texel-wide texture has each grid point at the *centre* of a texel (e.g. grid point 0 is at UV 0.5/32, not 0.0). Without this remap, samples at the edges of the colour space are slightly biased.

**Trilinear interpolation** is handled for free by the GPU: `TEXTURE_3D` with `LINEAR` filtering performs trilinear interpolation automatically. There is no need to manually sample 8 corners in the shader.

**LUT strength** is a simple `mix` between the original and graded colour, giving a smooth blend from 0 (bypass) to 1 (full grade).

---

### 4. WebGL2 setup — `HlsLutPlayer.tsx`

#### Geometry

A VAO holds a 6-vertex fullscreen quad in clip space:

```
(-1,+1) ──── (+1,+1)
   │    ╲   │
   │     ╲  │
(-1,-1) ──── (+1,-1)
```

Two triangles: `[-1,-1]→[+1,-1]→[-1,+1]` and `[-1,+1]→[+1,-1]→[+1,+1]`.

#### Texture slots

| Slot | Target | Content | Updated |
|------|--------|---------|---------|
| `TEXTURE0` | `TEXTURE_2D` | Video frame | Every RAF tick |
| `TEXTURE1` | `TEXTURE_3D` | LUT (RGB8, 32³) | Once on mount |

#### Render loop

```ts
const draw = () => {
  raf = requestAnimationFrame(draw);
  if (video.readyState < 2) return; // HAVE_CURRENT_DATA not yet reached

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  gl.uniform1f(uLutSizeLoc, lutSize);
  gl.uniform1f(uStrengthLoc, lutStrengthRef.current);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};
```

`readyState < 2` guards against uploading an empty texture while the video is buffering.

`lutStrengthRef` is a ref kept in sync with the React state via `useEffect`. The RAF closure captures the ref, not the state, so the slider always takes effect on the next frame without restarting the loop.

#### Resource cleanup

All WebGL objects are deleted on component unmount:

```ts
return () => {
  cancelAnimationFrame(raf);
  gl.deleteTexture(videoTex);
  gl.deleteTexture(lutTex);
  gl.deleteBuffer(buf);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(prog);
};
```

---

## Component API

```tsx
<HlsLutPlayer
  url="https://example.com/stream.m3u8"  // HLS stream URL (required)
  lutUrl="/BW1.cube"                       // Path to .cube file (required)
  width={1280}                             // Canvas pixel width  (default: 1280)
  height={720}                             // Canvas pixel height (default: 720)
/>
```

The LUT strength slider (0–1) is rendered directly below the canvas. It is controlled component state — no extra props needed.

---

## Browser requirements

| Requirement | Notes |
|-------------|-------|
| WebGL2 | Chrome 56+, Firefox 51+, Safari 15+, Edge 79+ |
| Media Source Extensions | All modern browsers; Safari since v8 |
| HLS.js | Handles MSE-based HLS; falls back to native on Safari |
| CORS on HLS origin | Required when stream is cross-origin (`crossOrigin="anonymous"` on `<video>`) |

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `hls.js` | ^1.6 | HLS stream playback via MSE |
| `next` | 16.2 | SSR framework (component uses `ssr: false`) |
| `react` | 19 | UI / hooks |

No WebGL abstraction library (Three.js, regl, babylon.js) is used. The WebGL2 context is driven directly for minimal bundle size.

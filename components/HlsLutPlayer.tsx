import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { parseCube } from '@/lib/parseCube';
import { vertexShaderSrc, fragmentShaderSrc } from '@/lib/lutShader';

interface Props {
  url: string;
  lutUrl: string;
  width?: number;
  height?: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile error: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

export default function HlsLutPlayer({ url, lutUrl, width = 1280, height = 720 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [lutStrength, setLutStrength] = useState(1.0);
  const lutStrengthRef = useRef(1.0);
  const [error, setError] = useState<string | null>(null);

  // Keep ref in sync so the RAF loop always reads the latest value
  useEffect(() => {
    lutStrengthRef.current = lutStrength;
  }, [lutStrength]);

  // HLS setup
  useEffect(() => {
    const video = videoRef.current!;
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(`HLS error: ${data.details}`);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = url;
    } else {
      setError('HLS is not supported in this browser.');
    }

    return () => {
      hls?.destroy();
    };
  }, [url]);

  // WebGL + LUT setup + render loop
  useEffect(() => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      setError('WebGL2 is not supported in this browser.');
      return;
    }

    let prog: WebGLProgram;
    let videoTex: WebGLTexture;
    let lutTex: WebGLTexture;
    let raf: number;

    try {
      prog = createProgram(gl, vertexShaderSrc, fragmentShaderSrc);
    } catch (e) {
      setError(String(e));
      return;
    }

    // Fullscreen quad: two triangles covering clip space
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Video texture (TEXTURE_2D, slot 0)
    videoTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Placeholder 1×1 pixel until video is ready
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));

    // LUT texture (TEXTURE_3D, slot 1) — uploaded async after parse
    lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // LINEAR gives us trilinear interpolation for free
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let lutSize = 1; // updated after parse

    parseCube(lutUrl)
      .then(({ size, data }) => {
        lutSize = size;
        // Convert Float32 → Uint8 (0–255) for TEXTURE_3D upload
        // We use RGB8 internal format; convert normalized floats to bytes
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          bytes[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lutTex);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
      })
      .catch((e) => setError('LUT load error: ' + e.message));

    // Uniforms
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVideo'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uLut'), 1);
    const uLutSizeLoc = gl.getUniformLocation(prog, 'uLutSize');
    const uStrengthLoc = gl.getUniformLocation(prog, 'uLutStrength');

    gl.viewport(0, 0, canvas.width, canvas.height);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (video.readyState < 2) return;

      // Update video frame texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

      gl.useProgram(prog);
      gl.uniform1f(uLutSizeLoc, lutSize);
      gl.uniform1f(uStrengthLoc, lutStrengthRef.current);

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteTexture(videoTex);
      gl.deleteTexture(lutTex);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    };
  }, [lutUrl]);

  return (
    <div style={{ position: 'relative', width, maxWidth: '100%' }}>
      {/* Hidden video — HLS.js needs it in the DOM */}
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        autoPlay
        muted
        playsInline
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />

      {/* WebGL canvas — what the user sees */}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />

      {/* LUT strength slider */}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'monospace', fontSize: 13 }}>
        <label htmlFor="lut-strength">LUT strength</label>
        <input
          id="lut-strength"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={lutStrength}
          onChange={(e) => setLutStrength(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ width: 36, textAlign: 'right' }}>{lutStrength.toFixed(2)}</span>
      </div>

      {error && (
        <div style={{ marginTop: 8, color: 'red', fontFamily: 'monospace', fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

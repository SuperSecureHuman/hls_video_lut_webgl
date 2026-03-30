export const vertexShaderSrc = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
  // aPosition is in clip space [-1, 1]; map to UV [0, 1] with Y flipped for video
  vTexCoord = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const fragmentShaderSrc = /* glsl */ `#version 300 es
precision mediump float;
precision mediump sampler3D;

uniform sampler2D uVideo;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutStrength;

in vec2 vTexCoord;
out vec4 fragColor;

void main() {
  vec4 raw = texture(uVideo, vTexCoord);
  vec3 color = raw.rgb;

  // Map [0,1] to LUT texel centres so GPU trilinear interpolation is accurate
  float scale  = (uLutSize - 1.0) / uLutSize;
  float offset = 0.5 / uLutSize;
  vec3 lutCoord = color * scale + offset;

  vec3 graded = texture(uLut, lutCoord).rgb;

  fragColor = vec4(mix(color, graded, uLutStrength), raw.a);
}
`;

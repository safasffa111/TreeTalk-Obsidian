import type { RelationshipGraphCamera } from "./camera";
import type { RelationshipGraphRenderFrame } from "./render-model";
import {
  relationshipGraphSharedPositionPages,
  type RelationshipGraphSharedMemoryDescriptor
} from "./shared-memory";
import type { RelationshipGraphThemeColors } from "./pixi-view";

type RenderNode = RelationshipGraphRenderFrame["nodes"][number];
type RenderEdge = RelationshipGraphRenderFrame["edges"][number];
type GraphGl = WebGLRenderingContext | WebGL2RenderingContext;

export interface RelationshipGraphSharedEdgeEndpoint {
  id: string;
  sourceIndex: number;
  targetIndex: number;
}

export interface RelationshipGraphNodeMeshData {
  corners: Float32Array;
  positionUvs: Float32Array;
  radii: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface RelationshipGraphEdgeMeshData {
  alongSide: Float32Array;
  sourceUvs: Float32Array;
  targetUvs: Float32Array;
  thickness: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
}

function textureUv(index: number, width: number, height: number): [number, number] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const x = index % safeWidth;
  const y = Math.floor(index / safeWidth);
  return [(x + 0.5) / safeWidth, (y + 0.5) / safeHeight];
}

function colorComponents(color: number, alpha: number): [number, number, number, number] {
  return [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
    alpha
  ];
}

function indexArray(vertexCount: number, indexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65_535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
}

function writeQuadIndices(target: Uint16Array | Uint32Array, offset: number, vertex: number): void {
  target[offset] = vertex;
  target[offset + 1] = vertex + 1;
  target[offset + 2] = vertex + 2;
  target[offset + 3] = vertex;
  target[offset + 4] = vertex + 2;
  target[offset + 5] = vertex + 3;
}

function nodeColor(node: RenderNode, theme: RelationshipGraphThemeColors): [number, number, number, number] {
  const color = node.highlighted || node.focused ? theme.accent : theme.node;
  const alpha = node.dimmed ? (node.excluded ? 0.12 : 0.16) : 1;
  return colorComponents(color, alpha);
}

function edgeColor(edge: RenderEdge, theme: RelationshipGraphThemeColors): [number, number, number, number] {
  const color = edge.highlighted ? theme.accent : theme.edge;
  const baseAlpha = edge.kind === "parent-child" ? 0.72 : edge.kind === "source-note" ? 0.42 : 0.24;
  const alpha = edge.dimmed ? 0.08 : edge.excluded ? 0.16 : baseAlpha;
  return colorComponents(color, alpha);
}

export function buildRelationshipGraphNodeMeshData(
  nodes: readonly RenderNode[],
  nodeIndexById: ReadonlyMap<string, number>,
  textureWidth: number,
  textureHeight: number,
  theme: RelationshipGraphThemeColors
): RelationshipGraphNodeMeshData {
  const vertexCount = nodes.length * 4;
  const corners = new Float32Array(vertexCount * 2);
  const positionUvs = new Float32Array(vertexCount * 2);
  const radii = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 4);
  const indices = indexArray(vertexCount, nodes.length * 6);
  const quadCorners: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  nodes.forEach((node, nodeOffset) => {
    const index = nodeIndexById.get(node.id) ?? nodeOffset;
    const [u, v] = textureUv(index, textureWidth, textureHeight);
    const color = nodeColor(node, theme);
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = nodeOffset * 4 + corner;
      const pair = quadCorners[corner] as readonly [number, number];
      corners[vertex * 2] = pair[0];
      corners[vertex * 2 + 1] = pair[1];
      positionUvs[vertex * 2] = u;
      positionUvs[vertex * 2 + 1] = v;
      radii[vertex] = node.radius;
      colors.set(color, vertex * 4);
    }
    writeQuadIndices(indices, nodeOffset * 6, nodeOffset * 4);
  });
  return { corners, positionUvs, radii, colors, indices };
}

export function buildRelationshipGraphEdgeMeshData(
  edges: readonly RenderEdge[],
  endpoints: readonly RelationshipGraphSharedEdgeEndpoint[],
  textureWidth: number,
  textureHeight: number,
  theme: RelationshipGraphThemeColors
): RelationshipGraphEdgeMeshData {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const vertexCount = edges.length * 4;
  const alongSide = new Float32Array(vertexCount * 2);
  const sourceUvs = new Float32Array(vertexCount * 2);
  const targetUvs = new Float32Array(vertexCount * 2);
  const thickness = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 4);
  const indices = indexArray(vertexCount, edges.length * 6);
  const quad: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [1, 1], [1, -1]];
  edges.forEach((edge, edgeOffset) => {
    const endpoint = endpointById.get(edge.id);
    const [sourceU, sourceV] = textureUv(endpoint?.sourceIndex ?? 0, textureWidth, textureHeight);
    const [targetU, targetV] = textureUv(endpoint?.targetIndex ?? 0, textureWidth, textureHeight);
    const color = edgeColor(edge, theme);
    const baseWidth = edge.kind === "parent-child" ? 1.55 : edge.kind === "source-note" ? 1.05 : 0.8;
    const width = edge.highlighted ? 2.35 : baseWidth;
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = edgeOffset * 4 + corner;
      const pair = quad[corner] as readonly [number, number];
      alongSide[vertex * 2] = pair[0];
      alongSide[vertex * 2 + 1] = pair[1];
      sourceUvs[vertex * 2] = sourceU;
      sourceUvs[vertex * 2 + 1] = sourceV;
      targetUvs[vertex * 2] = targetU;
      targetUvs[vertex * 2 + 1] = targetV;
      thickness[vertex] = width;
      colors.set(color, vertex * 4);
    }
    writeQuadIndices(indices, edgeOffset * 6, edgeOffset * 4);
  });
  return { alongSide, sourceUvs, targetUvs, thickness, colors, indices };
}

const NODE_VERTEX_100 = `
precision highp float;
attribute vec2 aCorner;
attribute vec2 aPositionUv;
attribute float aRadius;
attribute vec4 aColor;
uniform vec2 uViewport;
uniform vec3 uCamera;
uniform sampler2D uPositionTexture;
varying vec2 vCorner;
varying vec4 vColor;
void main(void) {
  vec2 center = texture2D(uPositionTexture, aPositionUv).xy;
  vec2 screen = (center + aCorner * aRadius) * uCamera.z + uCamera.xy;
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vCorner = aCorner;
  vColor = aColor;
}`;

const NODE_FRAGMENT_100 = `
precision mediump float;
varying vec2 vCorner;
varying vec4 vColor;
void main(void) {
  float distanceSquared = dot(vCorner, vCorner);
  if (distanceSquared > 1.0) discard;
  float edge = 1.0 - smoothstep(0.88, 1.0, distanceSquared);
  float alpha = vColor.a * edge;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}`;

const EDGE_VERTEX_100 = `
precision highp float;
attribute vec2 aAlongSide;
attribute vec2 aSourceUv;
attribute vec2 aTargetUv;
attribute float aThickness;
attribute vec4 aColor;
uniform vec2 uViewport;
uniform vec3 uCamera;
uniform sampler2D uPositionTexture;
varying vec4 vColor;
void main(void) {
  vec2 source = texture2D(uPositionTexture, aSourceUv).xy;
  vec2 target = texture2D(uPositionTexture, aTargetUv).xy;
  vec2 delta = target - source;
  float edgeLength = max(length(delta), 0.0001);
  vec2 normal = vec2(-delta.y, delta.x) / edgeLength;
  vec2 world = mix(source, target, aAlongSide.x) + normal * aAlongSide.y * aThickness * 0.5 / max(uCamera.z, 0.0001);
  vec2 screen = world * uCamera.z + uCamera.xy;
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
}`;

const EDGE_FRAGMENT_100 = `
precision mediump float;
varying vec4 vColor;
void main(void) { gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a); }
`;

const NODE_VERTEX_300 = `#version 300 es
precision highp float;
in vec2 aCorner;
in vec2 aPositionUv;
in float aRadius;
in vec4 aColor;
uniform vec2 uViewport;
uniform vec3 uCamera;
uniform sampler2D uPositionTexture;
out vec2 vCorner;
out vec4 vColor;
void main(void) {
  vec2 center = texture(uPositionTexture, aPositionUv).xy;
  vec2 screen = (center + aCorner * aRadius) * uCamera.z + uCamera.xy;
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vCorner = aCorner;
  vColor = aColor;
}`;

const NODE_FRAGMENT_300 = `#version 300 es
precision mediump float;
in vec2 vCorner;
in vec4 vColor;
out vec4 outputColor;
void main(void) {
  float distanceSquared = dot(vCorner, vCorner);
  if (distanceSquared > 1.0) discard;
  float edge = 1.0 - smoothstep(0.88, 1.0, distanceSquared);
  float alpha = vColor.a * edge;
  outputColor = vec4(vColor.rgb * alpha, alpha);
}`;

const EDGE_VERTEX_300 = `#version 300 es
precision highp float;
in vec2 aAlongSide;
in vec2 aSourceUv;
in vec2 aTargetUv;
in float aThickness;
in vec4 aColor;
uniform vec2 uViewport;
uniform vec3 uCamera;
uniform sampler2D uPositionTexture;
out vec4 vColor;
void main(void) {
  vec2 source = texture(uPositionTexture, aSourceUv).xy;
  vec2 target = texture(uPositionTexture, aTargetUv).xy;
  vec2 delta = target - source;
  float edgeLength = max(length(delta), 0.0001);
  vec2 normal = vec2(-delta.y, delta.x) / edgeLength;
  vec2 world = mix(source, target, aAlongSide.x) + normal * aAlongSide.y * aThickness * 0.5 / max(uCamera.z, 0.0001);
  vec2 screen = world * uCamera.z + uCamera.xy;
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
}`;

const EDGE_FRAGMENT_300 = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outputColor;
void main(void) { outputColor = vec4(vColor.rgb * vColor.a, vColor.a); }
`;

interface ProgramInfo {
  program: WebGLProgram;
  attributes: Record<string, number>;
  viewport: WebGLUniformLocation;
  camera: WebGLUniformLocation;
  positionTexture: WebGLUniformLocation;
}

interface MeshInfo {
  buffers: WebGLBuffer[];
  indexBuffer: WebGLBuffer;
  indexCount: number;
  indexType: number;
}

function compileShader(gl: GraphGl, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("Unable to create relationship graph shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`Relationship graph shader failed: ${message}`);
  }
  return shader;
}

function createProgram(gl: GraphGl, vertex: string, fragment: string, attributes: readonly string[]): ProgramInfo {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (program === null) throw new Error("Unable to create relationship graph program");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown program link error";
    gl.deleteProgram(program);
    throw new Error(`Relationship graph program failed: ${message}`);
  }
  const locations: Record<string, number> = {};
  for (const name of attributes) locations[name] = gl.getAttribLocation(program, name);
  const viewport = gl.getUniformLocation(program, "uViewport");
  const camera = gl.getUniformLocation(program, "uCamera");
  const positionTexture = gl.getUniformLocation(program, "uPositionTexture");
  if (viewport === null || camera === null || positionTexture === null) throw new Error("Relationship graph shader uniforms are unavailable");
  return { program, attributes: locations, viewport, camera, positionTexture };
}

function createBuffer(
  gl: GraphGl,
  data: ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
  target: number = gl.ARRAY_BUFFER
): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (buffer === null) throw new Error("Unable to allocate relationship graph GPU buffer");
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data as BufferSource, gl.STATIC_DRAW);
  return buffer;
}

function deleteMesh(gl: GraphGl, mesh: MeshInfo | undefined): void {
  if (mesh === undefined) return;
  for (const buffer of mesh.buffers) gl.deleteBuffer(buffer);
  gl.deleteBuffer(mesh.indexBuffer);
}

export function relationshipGraphWebGlSupported(gl: GraphGl): boolean {
  const vertexTextureUnits = Number(gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS));
  if (vertexTextureUnits <= 0) return false;
  if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) return true;
  return gl.getExtension("OES_texture_float") !== null;
}

export class RelationshipGraphGpuGeometry {
  private readonly isWebGl2: boolean;
  private readonly positionTexture: WebGLTexture;
  private readonly nodeProgram: ProgramInfo;
  private readonly edgeProgram: ProgramInfo;
  private nodeMesh: MeshInfo | undefined;
  private edgeMesh: MeshInfo | undefined;
  private topologyKey = "";
  private selectedSequence = -1;
  private destroyed = false;
  private lastFrame: RelationshipGraphRenderFrame | undefined;
  private lastNodeIds: readonly string[] = [];
  private lastEndpoints: readonly RelationshipGraphSharedEdgeEndpoint[] = [];

  constructor(
    private readonly gl: GraphGl,
    private readonly pages: readonly Float32Array[],
    readonly textureWidth: number,
    readonly textureHeight: number,
    private theme: RelationshipGraphThemeColors
  ) {
    this.isWebGl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    if (!relationshipGraphWebGlSupported(gl)) throw new Error("Vertex float textures are unavailable");
    this.nodeProgram = createProgram(gl, this.isWebGl2 ? NODE_VERTEX_300 : NODE_VERTEX_100, this.isWebGl2 ? NODE_FRAGMENT_300 : NODE_FRAGMENT_100, ["aCorner", "aPositionUv", "aRadius", "aColor"]);
    this.edgeProgram = createProgram(gl, this.isWebGl2 ? EDGE_VERTEX_300 : EDGE_VERTEX_100, this.isWebGl2 ? EDGE_FRAGMENT_300 : EDGE_FRAGMENT_100, ["aAlongSide", "aSourceUv", "aTargetUv", "aThickness", "aColor"]);
    const texture = gl.createTexture();
    if (texture === null) throw new Error("Unable to allocate relationship graph position texture");
    this.positionTexture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.isWebGl2) {
      (gl as WebGL2RenderingContext).texImage2D(gl.TEXTURE_2D, 0, (gl as WebGL2RenderingContext).RGBA32F, textureWidth, textureHeight, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textureWidth, textureHeight, 0, gl.RGBA, gl.FLOAT, null);
    }
  }

  setTheme(theme: RelationshipGraphThemeColors): void {
    if (this.destroyed) return;
    this.theme = { ...theme };
    this.topologyKey = "";
    if (this.lastFrame !== undefined) this.update(this.lastFrame, this.lastNodeIds, this.lastEndpoints);
  }

  update(frame: RelationshipGraphRenderFrame, nodeIds: readonly string[], endpoints: readonly RelationshipGraphSharedEdgeEndpoint[]): void {
    if (this.destroyed) return;
    this.lastFrame = frame;
    this.lastNodeIds = nodeIds;
    this.lastEndpoints = endpoints;
    const topologyKey = `${nodeIds.join("\u0000")}|${endpoints.map((edge) => `${edge.id}:${edge.sourceIndex}:${edge.targetIndex}`).join("\u0000")}|${frame.nodes.map((node) => `${node.id}:${node.radius}:${node.highlighted ? 1 : 0}:${node.dimmed ? 1 : 0}`).join("\u0000")}|${frame.edges.map((edge) => `${edge.id}:${edge.highlighted ? 1 : 0}:${edge.dimmed ? 1 : 0}`).join("\u0000")}`;
    if (topologyKey === this.topologyKey) return;
    this.topologyKey = topologyKey;
    deleteMesh(this.gl, this.nodeMesh);
    deleteMesh(this.gl, this.edgeMesh);
    const nodeData = buildRelationshipGraphNodeMeshData(frame.nodes, new Map(nodeIds.map((id, index) => [id, index])), this.textureWidth, this.textureHeight, this.theme);
    const edgeData = buildRelationshipGraphEdgeMeshData(frame.edges, endpoints, this.textureWidth, this.textureHeight, this.theme);
    this.nodeMesh = this.createNodeMesh(nodeData);
    this.edgeMesh = this.createEdgeMesh(edgeData);
  }

  render(pageIndex: number, sequence: number, camera: RelationshipGraphCamera, viewport: { width: number; height: number }): void {
    if (this.destroyed) return;
    const page = this.pages[pageIndex];
    if (page === undefined) return;
    if (sequence !== this.selectedSequence) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.positionTexture);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, page);
      this.selectedSequence = sequence;
    }
    this.draw(camera, viewport);
  }

  renderValues(values: Float32Array, sequence: number, camera: RelationshipGraphCamera, viewport: { width: number; height: number }): void {
    if (this.destroyed || values.length < this.textureWidth * this.textureHeight * 4) return;
    if (sequence !== this.selectedSequence) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.positionTexture);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, values);
      this.selectedSequence = sequence;
    }
    this.draw(camera, viewport);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    deleteMesh(this.gl, this.nodeMesh);
    deleteMesh(this.gl, this.edgeMesh);
    this.gl.deleteTexture(this.positionTexture);
    this.gl.deleteProgram(this.nodeProgram.program);
    this.gl.deleteProgram(this.edgeProgram.program);
  }

  private createNodeMesh(data: RelationshipGraphNodeMeshData): MeshInfo {
    const gl = this.gl;
    const buffers = [
      createBuffer(gl, data.corners),
      createBuffer(gl, data.positionUvs),
      createBuffer(gl, data.radii),
      createBuffer(gl, data.colors)
    ];
    const indexBuffer = createBuffer(gl, data.indices, gl.ELEMENT_ARRAY_BUFFER);
    return { buffers, indexBuffer, indexCount: data.indices.length, indexType: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  private createEdgeMesh(data: RelationshipGraphEdgeMeshData): MeshInfo {
    const gl = this.gl;
    const buffers = [
      createBuffer(gl, data.alongSide),
      createBuffer(gl, data.sourceUvs),
      createBuffer(gl, data.targetUvs),
      createBuffer(gl, data.thickness),
      createBuffer(gl, data.colors)
    ];
    const indexBuffer = createBuffer(gl, data.indices, gl.ELEMENT_ARRAY_BUFFER);
    return { buffers, indexBuffer, indexCount: data.indices.length, indexType: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  private bindAttribute(program: ProgramInfo, name: string, buffer: WebGLBuffer, size: number): void {
    const location = program.attributes[name] ?? -1;
    if (location < 0) return;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, size, this.gl.FLOAT, false, 0, 0);
  }

  private draw(camera: RelationshipGraphCamera, viewport: { width: number; height: number }): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    if (this.edgeMesh !== undefined && this.edgeMesh.indexCount > 0) {
      const mesh = this.edgeMesh;
      const program = this.edgeProgram;
      gl.useProgram(program.program);
      gl.uniform2f(program.viewport, Math.max(1, viewport.width), Math.max(1, viewport.height));
      gl.uniform3f(program.camera, camera.panX, camera.panY, camera.scale);
      gl.uniform1i(program.positionTexture, 0);
      this.bindAttribute(program, "aAlongSide", mesh.buffers[0] as WebGLBuffer, 2);
      this.bindAttribute(program, "aSourceUv", mesh.buffers[1] as WebGLBuffer, 2);
      this.bindAttribute(program, "aTargetUv", mesh.buffers[2] as WebGLBuffer, 2);
      this.bindAttribute(program, "aThickness", mesh.buffers[3] as WebGLBuffer, 1);
      this.bindAttribute(program, "aColor", mesh.buffers[4] as WebGLBuffer, 4);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
    }
    if (this.nodeMesh !== undefined && this.nodeMesh.indexCount > 0) {
      const mesh = this.nodeMesh;
      const program = this.nodeProgram;
      gl.useProgram(program.program);
      gl.uniform2f(program.viewport, Math.max(1, viewport.width), Math.max(1, viewport.height));
      gl.uniform3f(program.camera, camera.panX, camera.panY, camera.scale);
      gl.uniform1i(program.positionTexture, 0);
      this.bindAttribute(program, "aCorner", mesh.buffers[0] as WebGLBuffer, 2);
      this.bindAttribute(program, "aPositionUv", mesh.buffers[1] as WebGLBuffer, 2);
      this.bindAttribute(program, "aRadius", mesh.buffers[2] as WebGLBuffer, 1);
      this.bindAttribute(program, "aColor", mesh.buffers[3] as WebGLBuffer, 4);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
    }
  }
}

export class RelationshipGraphSharedGeometry extends RelationshipGraphGpuGeometry {
  constructor(gl: GraphGl, descriptor: RelationshipGraphSharedMemoryDescriptor, theme: RelationshipGraphThemeColors) {
    super(gl, relationshipGraphSharedPositionPages(descriptor), descriptor.textureWidth, descriptor.textureHeight, theme);
  }
}

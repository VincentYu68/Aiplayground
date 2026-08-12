/**
 * The interactive 3D manual, shot like a product photograph.
 *
 * Everything already built is drawn solid, the parts for the current step drop
 * into place with a short animation and glow, and the rest of the model can be
 * ghosted in so you can see where you are heading. That combination — solid /
 * highlighted / ghosted — is what makes a step-by-step manual readable.
 *
 * The rest of this file is about making the solid state look like a photograph
 * of a real build rather than a diagram of one: a neutral studio environment, a
 * key light that casts real shadows between parts, cavity occlusion read from
 * the model's own occupancy grid, and a studded baseplate on a seamless sweep.
 * Chamfered geometry does the rest — see brickGeometry.ts.
 *
 * Draw calls are kept low by batching every placement of the same footprint
 * into one InstancedMesh with per-instance colour.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { brickGeometry, slabGeometry, studOnlyGeometry } from './brickGeometry';
import { buildCavityVolume, type CavityVolume } from './cavity';
import {
  createBrickMaterials,
  createCavityUniforms,
  emptyVolume,
  setCavityVolume,
  type BrickMaterials,
  type CavityUniforms,
} from './brickMaterial';
import { pickQuality, QUALITY, type Quality, type QualityTier } from './quality';
import { backdropTexture, groundFadeTexture, studioEnvironment } from './studio';
import { COLOR_BY_LDRAW } from '../core/lego/colors';
import { PLATE_MM, STUD_MM } from '../core/lego/units';
import type { BuildResult, Placement } from '../types';

interface Entry {
  placement: Placement;
  step: number;
  color: THREE.Color;
}

interface Batch {
  entries: Entry[];
  /** Half the part's height, mm: the pivot the outline shell grows about. */
  centreY: number;
  /** Per-axis scale that pushes the shell out by OUTLINE_MM on every face. */
  shell: THREE.Vector3;
  placed: THREE.InstancedMesh;
  current: THREE.InstancedMesh;
  ghost: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
}

const SUPPORT_TINT = new THREE.Color(0x9aa4ad);
const DROP_HEIGHT_MM = 26;
const DROP_DURATION_MS = 420;

/** How far the current-step shell stands off the part, mm — about 3 screen px. */
const OUTLINE_MM = 1.1;

/** Real baseplates are thinner than a plate and have no tubes underneath. */
const BASEPLATE_MM = 1.4;
/** Light Bluish Gray, the colour every modern baseplate comes in. */
const BASEPLATE_COLOR = 0xa0a5a9;

export interface SceneOptions {
  showGhost: boolean;
  highlightSupports: boolean;
  followStep: boolean;
}

export class BrickScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private stage = new THREE.Group();
  private batches: Batch[] = [];
  private frameHandle = 0;
  private disposed = false;

  private result: BuildResult | null = null;
  private step = 0;
  private options: SceneOptions = { showGhost: true, highlightSupports: false, followStep: false };
  private animStart = 0;
  private animating = false;
  /** Once the user has taken the camera, stop re-framing it for them. */
  private userMovedCamera = false;
  private modelCenter = new THREE.Vector3();
  private modelSize = new THREE.Vector3(100, 100, 100);

  private quality: Quality = QUALITY.high;
  /** Set once someone asks for a tier by hand; stops the model overriding it. */
  private qualityPinned = false;
  private stageGeometry: THREE.BufferGeometry[] = [];
  private stageDisposable: Array<{ dispose(): void }> = [];
  private cavity: CavityUniforms = createCavityUniforms();
  private cavityFallback = emptyVolume();
  private volume: CavityVolume | null = null;
  private materials: BrickMaterials;
  private key: THREE.DirectionalLight;
  private environment: THREE.Texture;
  private backdrop: THREE.Texture;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The palette is fixed and has to survive the trip to the screen, so this
    // needs a curve that leaves the mid-tones alone. NoToneMapping used to be
    // the answer, but it clips: under a key light bright enough to shape the
    // studs, Red 4 and Yellow 14 both flattened into a solid saturated patch
    // with no form left in it. Khronos PBR Neutral is near-identity below ~0.8
    // and only rolls the highlights off, which keeps the flat faces honest and
    // still leaves headroom for a specular hit on a chamfer.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Nothing in the scene moves except when a step changes, so re-rasterising
    // the shadow map every frame would be paying for the same picture 60 times
    // a second. It is refreshed explicitly instead.
    this.renderer.shadowMap.autoUpdate = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.root);
    this.scene.add(this.stage);

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
    this.camera.position.set(300, 260, 420);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true;
    });
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 8000;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.environment = studioEnvironment(this.renderer);
    this.scene.environment = this.environment;
    this.backdrop = backdropTexture();
    this.scene.background = this.backdrop;

    // A three-light studio. The key is the only one that casts: a second set of
    // shadows from a fill is a thing you only ever see in renders.
    this.key = new THREE.DirectionalLight(0xfff6ec, 1.15);
    this.key.position.set(-300, 550, 360);
    this.key.castShadow = true;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.24);
    fill.position.set(0.9, 0.35, 0.4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.4);
    rim.position.set(-0.35, 0.5, -1);
    this.scene.add(rim);

    this.cavity.aoVolume.value = this.cavityFallback;
    this.materials = createBrickMaterials(this.cavity, this.quality.cavityAO);
    this.applyQualityToRenderer();

    this.loop = this.loop.bind(this);
    this.frameHandle = requestAnimationFrame(this.loop);
  }

  setOptions(options: Partial<SceneOptions>): void {
    this.options = { ...this.options, ...options };
    this.refreshInstances();
    if (this.options.followStep) this.focusCurrentStep();
  }

  /** Swap render tier. Everything downstream of the tier has to be rebuilt. */
  setQuality(tier: QualityTier): void {
    this.qualityPinned = true;
    if (tier === this.quality.tier) return;
    const result = this.result;
    this.clearModel();
    this.adoptQuality(QUALITY[tier]);
    this.result = null;
    if (result) this.setModel(result);
  }

  getQuality(): QualityTier {
    return this.quality.tier;
  }

  private adoptQuality(quality: Quality): void {
    this.quality = quality;
    for (const m of this.materials.all()) m.dispose();
    this.materials = createBrickMaterials(this.cavity, this.quality.cavityAO);
    this.applyQualityToRenderer();
  }

  private applyQualityToRenderer(): void {
    this.renderer.shadowMap.enabled = this.quality.shadowMapSize > 0;
    this.renderer.shadowMap.type = this.quality.softShadows
      ? THREE.PCFSoftShadowMap
      : THREE.PCFShadowMap;
    this.key.castShadow = this.quality.shadowMapSize > 0;
    if (this.quality.shadowMapSize > 0) {
      this.key.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    for (const m of this.materials.all()) m.needsUpdate = true;
  }

  setModel(result: BuildResult | null): void {
    this.clearModel();
    this.result = result;
    this.step = 0;
    this.userMovedCamera = false;
    if (!result) return;

    const chosen = pickQuality(result.totalParts);
    if (!this.qualityPinned && chosen.tier !== this.quality.tier) this.adoptQuality(chosen);

    const stepOf = new Map<Placement, number>();
    for (const s of result.steps) for (const p of s.placements) stepOf.set(p, s.index);

    const covered = coverage(result);
    const grouped = new Map<string, Entry[]>();
    for (const p of result.placements) {
      const studs = !studsBuried(p, covered, result);
      const key = `${p.w}x${p.d}x${p.height}x${studs ? 1 : 0}`;
      const hex = COLOR_BY_LDRAW.get(p.color)?.hex ?? '#999999';
      const entry: Entry = { placement: p, step: stepOf.get(p) ?? 0, color: new THREE.Color(hex) };
      const arr = grouped.get(key);
      if (arr) arr.push(entry);
      else grouped.set(key, [entry]);
    }

    for (const [key, entries] of grouped) {
      const [w, d, h, studs] = key.split('x').map(Number);
      const geo = brickGeometry(w, d, h, this.quality, studs === 1);
      const make = (mat: THREE.Material, shadows: boolean) => {
        const mesh = new THREE.InstancedMesh(geo, mat, entries.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        this.root.add(mesh);
        return mesh;
      };
      const bw = w * STUD_MM - 0.2;
      const bd = d * STUD_MM - 0.2;
      const bh = h * PLATE_MM;
      this.batches.push({
        entries,
        centreY: bh / 2,
        shell: new THREE.Vector3(
          (bw + OUTLINE_MM * 2) / bw,
          (bh + OUTLINE_MM * 2) / bh,
          (bd + OUTLINE_MM * 2) / bd,
        ),
        placed: make(this.materials.placed, true),
        current: make(this.materials.current, true),
        ghost: make(this.materials.ghost, false),
        outline: make(this.materials.outline, false),
      });
    }

    this.measure(result);
    this.buildStage(result, covered);

    if (this.quality.cavityAO) {
      this.volume = buildCavityVolume(result.placements, result.gridX, result.gridY, result.gridZ);
      setCavityVolume(this.cavity, this.volume);
    } else {
      this.cavity.aoVolume.value = this.cavityFallback;
    }

    this.aimKeyLight();
    this.refreshInstances();
    this.frameAll();
  }

  /**
   * True bounds of the placed parts. The grid is a bounding box the model does
   * not necessarily fill — framing on the grid leaves a band of empty studio
   * down one side and shrinks the subject for no reason.
   */
  private measure(result: BuildResult): void {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of result.placements) {
      lo.x = Math.min(lo.x, p.x * STUD_MM);
      lo.y = Math.min(lo.y, p.y * PLATE_MM);
      lo.z = Math.min(lo.z, p.z * STUD_MM);
      hi.x = Math.max(hi.x, (p.x + p.w) * STUD_MM);
      hi.y = Math.max(hi.y, (p.y + p.height) * PLATE_MM);
      hi.z = Math.max(hi.z, (p.z + p.d) * STUD_MM);
    }
    if (!Number.isFinite(lo.x)) {
      lo.set(0, 0, 0);
      hi.set(result.gridX * STUD_MM, result.gridY * PLATE_MM, result.gridZ * STUD_MM);
    }
    this.modelCenter.copy(lo).add(hi).multiplyScalar(0.5);
    this.modelSize.copy(hi).sub(lo);
  }

  /** Baseplate and sweep: everything the model stands on. */
  private buildStage(result: BuildResult, covered: Set<number>): void {
    // Baseplates come in fixed sizes, so this one does too — snapping the
    // footprint out to a multiple of 8 studs reads as a part rather than as a
    // rectangle cut to fit.
    const studsX = Math.max(8, roundUpTo(this.modelSize.x / STUD_MM + 2, 8));
    const studsZ = Math.max(8, roundUpTo(this.modelSize.z / STUD_MM + 2, 8));
    const w = studsX * STUD_MM;
    const d = studsZ * STUD_MM;
    // Keep the plate on the stud grid the model is built on, or every stud on
    // it lands half a stud out from the parts standing on top.
    const cx = Math.round(this.modelCenter.x / STUD_MM) * STUD_MM;
    const cz = Math.round(this.modelCenter.z / STUD_MM) * STUD_MM;

    this.materials.plate.color.setHex(BASEPLATE_COLOR);

    const slab = new THREE.Mesh(slabGeometry(w, BASEPLATE_MM, d), this.materials.plate);
    slab.position.set(cx, -BASEPLATE_MM, cz);
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.stage.add(slab);
    this.stageGeometry.push(slab.geometry);

    // Studs only where nothing is standing on them. On a covered cell the stud
    // is inside the brick above it: invisible, and a few thousand triangles.
    const x0 = cx - w / 2;
    const z0 = cz - d / 2;
    const positions: Array<[number, number]> = [];
    for (let iz = 0; iz < studsZ; iz++) {
      for (let ix = 0; ix < studsX; ix++) {
        const gx = Math.round(x0 / STUD_MM) + ix;
        const gz = Math.round(z0 / STUD_MM) + iz;
        const inside = gx >= 0 && gx < result.gridX && gz >= 0 && gz < result.gridZ;
        if (inside && covered.has(cell(gx, 0, gz, result))) continue;
        positions.push([(gx + 0.5) * STUD_MM, (gz + 0.5) * STUD_MM]);
      }
    }
    if (positions.length > 0) {
      const studs = new THREE.InstancedMesh(
        studOnlyGeometry(this.quality),
        this.materials.plate,
        positions.length,
      );
      studs.frustumCulled = false;
      studs.castShadow = true;
      studs.receiveShadow = true;
      const m = new THREE.Matrix4();
      positions.forEach(([px, pz], i) => {
        m.makeTranslation(px, 0, pz);
        studs.setMatrixAt(i, m);
      });
      studs.instanceMatrix.needsUpdate = true;
      this.stage.add(studs);
    }

    // The sweep. Faded out with an alpha disc so it has no visible horizon —
    // a hard edge halfway up the frame is the tell that this is a 3D widget.
    const reach = Math.max(w, d) * 4;
    const groundGeo = new THREE.PlaneGeometry(reach, reach);
    groundGeo.rotateX(-Math.PI / 2);
    const fade = groundFadeTexture();
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x3c424a,
      roughness: 0.95,
      metalness: 0,
      alphaMap: fade,
      transparent: true,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.set(cx, -BASEPLATE_MM - 0.05, cz);
    ground.receiveShadow = true;
    this.stage.add(ground);
    this.stageGeometry.push(groundGeo);
    this.stageDisposable.push(groundMat, fade);
  }

  private aimKeyLight(): void {
    const radius = Math.max(this.modelSize.length() * 0.65, 60);
    const dir = new THREE.Vector3(-0.55, 1, 0.65).normalize();
    this.key.position.copy(this.modelCenter).addScaledVector(dir, radius * 3);
    this.key.target.position.copy(this.modelCenter);
    this.key.target.updateMatrixWorld();

    const cam = this.key.shadow.camera;
    // The sweep is much wider than the model; only the model and its baseplate
    // need to be inside the shadow frustum, so it is fitted to those.
    const half = radius * 1.5;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = radius;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    // Millimetres, and the model is a couple of hundred across: this is a
    // fraction of a plate, enough to kill acne on the flat top faces without
    // lifting shadows off the parts casting them.
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.25;
    this.shadowsDirty();
  }

  setStep(index: number): void {
    if (!this.result) return;
    const clamped = Math.max(0, Math.min(this.result.steps.length - 1, index));
    if (clamped === this.step) return;
    this.step = clamped;
    this.animStart = performance.now();
    this.animating = true;
    this.refreshInstances();
    if (this.options.followStep) this.focusCurrentStep();
  }

  getStep(): number {
    return this.step;
  }

  /**
   * On the last step there is nothing left to point at — the build is finished
   * and what you want to look at is the model, not an annotation on it.
   */
  private outlineWanted(): boolean {
    return this.result !== null && this.step < this.result.steps.length - 1;
  }

  /** Rebuild the instance buffers for the current step. */
  private refreshInstances(): void {
    const matrix = new THREE.Matrix4();
    const outline = this.outlineWanted();
    for (const batch of this.batches) {
      let nPlaced = 0;
      let nCurrent = 0;
      let nGhost = 0;
      for (const entry of batch.entries) {
        const p = entry.placement;
        const x = (p.x + p.w / 2) * STUD_MM;
        const y = p.y * PLATE_MM;
        const z = (p.z + p.d / 2) * STUD_MM;
        const color = this.options.highlightSupports && p.support ? SUPPORT_TINT : entry.color;

        if (entry.step < this.step) {
          matrix.makeTranslation(x, y, z);
          batch.placed.setMatrixAt(nPlaced, matrix);
          batch.placed.setColorAt(nPlaced, color);
          nPlaced++;
        } else if (entry.step === this.step) {
          matrix.makeTranslation(x, y, z);
          batch.current.setMatrixAt(nCurrent, matrix);
          batch.current.setColorAt(nCurrent, color);
          if (outline) {
            shellMatrix(matrix, batch, x, y, z);
            batch.outline.setMatrixAt(nCurrent, matrix);
            batch.outline.setColorAt(nCurrent, color);
          }
          nCurrent++;
        } else if (this.options.showGhost) {
          matrix.makeTranslation(x, y, z);
          batch.ghost.setMatrixAt(nGhost, matrix);
          batch.ghost.setColorAt(nGhost, color);
          nGhost++;
        }
      }
      batch.placed.count = nPlaced;
      batch.current.count = nCurrent;
      batch.ghost.count = nGhost;
      batch.outline.count = outline ? nCurrent : 0;
      for (const mesh of [batch.placed, batch.current, batch.ghost, batch.outline]) {
        mesh.visible = mesh.count > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.shadowsDirty();
  }

  /**
   * Animate the current step's parts dropping into place.
   *
   * The shadow map is not refreshed while they fall — it already shows them
   * landed, so each part descends onto its own shadow, which reads as a target
   * rather than as a mistake and saves re-rasterising the whole model 25 times
   * over a 420ms animation.
   */
  private applyDropAnimation(t: number): void {
    const eased = 1 - Math.pow(1 - t, 3);
    const offset = (1 - eased) * DROP_HEIGHT_MM;
    const matrix = new THREE.Matrix4();
    const outline = this.outlineWanted();
    for (const batch of this.batches) {
      let n = 0;
      for (const entry of batch.entries) {
        if (entry.step !== this.step) continue;
        const p = entry.placement;
        const x = (p.x + p.w / 2) * STUD_MM;
        const y = p.y * PLATE_MM + offset;
        const z = (p.z + p.d / 2) * STUD_MM;
        matrix.makeTranslation(x, y, z);
        batch.current.setMatrixAt(n, matrix);
        if (outline) {
          shellMatrix(matrix, batch, x, y, z);
          batch.outline.setMatrixAt(n, matrix);
        }
        n++;
      }
      if (n > 0) {
        batch.current.instanceMatrix.needsUpdate = true;
        if (outline) batch.outline.instanceMatrix.needsUpdate = true;
      }
    }
    // A brief lift as the part lands, gone by the time it settles: the outline
    // is what marks the step, this only draws the eye to the movement.
    this.materials.current.emissiveIntensity = 0.22 * (1 - eased);
  }

  /**
   * Distance at which the whole model fits the viewport, accounting for both
   * the vertical field of view and the aspect ratio. A tall narrow model is
   * limited by height and a wide one by width, so both have to be checked —
   * fitting on the bounding sphere alone leaves a lot of empty frame.
   */
  private fitDistance(): number {
    const halfHeight = this.modelSize.y / 2;
    const halfWidth = Math.max(this.modelSize.x, this.modelSize.z) / 2;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const distForHeight = halfHeight / Math.tan(vFov / 2);
    const distForWidth = halfWidth / (Math.tan(vFov / 2) * Math.max(0.35, this.camera.aspect));
    return Math.max(60, Math.max(distForHeight, distForWidth) * 1.28);
  }

  frameAll(): void {
    const dist = this.fitDistance();
    this.controls.target.copy(this.modelCenter);
    // Three-quarter view: enough of the side and top to read the form.
    const dir = new THREE.Vector3(0.45, 0.36, 0.82).normalize().multiplyScalar(dist);
    this.camera.position.copy(this.modelCenter).add(dir);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  focusCurrentStep(): void {
    if (!this.result) return;
    const step = this.result.steps[this.step];
    if (!step || step.placements.length === 0) return;
    let y = 0;
    for (const p of step.placements) y += p.y * PLATE_MM;
    y /= step.placements.length;

    // Pan rather than pivot. Moving only the orbit target swings the camera's
    // aim without moving the camera, which on a tall model tips the build right
    // out of frame; shifting both by the same amount keeps the framing and just
    // rides up the model as the build grows. Only the height is followed —
    // chasing the step sideways as well would make the view lurch about.
    const wanted = new THREE.Vector3(this.modelCenter.x, y, this.modelCenter.z);
    const delta = wanted.sub(this.controls.target).multiplyScalar(0.5);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.controls.update();
  }

  setView(view: 'front' | 'side' | 'top' | 'iso'): void {
    const dist = this.fitDistance();
    const c = this.modelCenter;
    const positions: Record<string, [number, number, number]> = {
      front: [c.x, c.y + dist * 0.12, c.z + dist],
      side: [c.x + dist, c.y + dist * 0.12, c.z],
      top: [c.x, c.y + dist, c.z + 0.001],
      iso: [c.x + dist * 0.5, c.y + dist * 0.42, c.z + dist * 0.85],
    };
    const [px, py, pz] = positions[view];
    this.camera.position.set(px, py, pz);
    this.controls.target.copy(c);
    this.controls.update();
    // Draw it now. On a slow machine the next animation frame can be hundreds
    // of milliseconds away, and a screenshot taken in that window catches the
    // previous view — which is how a bench gallery ends up with two identical
    // "different" angles.
    this.renderer.render(this.scene, this.camera);
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    const aspectChanged = Math.abs(this.camera.aspect - width / height) > 1e-3;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // The first real size usually arrives after the model does, so the initial
    // framing was computed against a placeholder aspect. Re-frame once.
    if (aspectChanged && this.result && !this.userMovedCamera) this.frameAll();
  }

  private shadowsDirty(): void {
    if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
  }

  private loop(): void {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.loop);

    if (this.animating) {
      const t = Math.min(1, (performance.now() - this.animStart) / DROP_DURATION_MS);
      this.applyDropAnimation(t);
      if (t >= 1) this.animating = false;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private clearModel(): void {
    for (const batch of this.batches) {
      for (const mesh of [batch.placed, batch.current, batch.ghost, batch.outline]) {
        this.root.remove(mesh);
        mesh.dispose();
      }
    }
    this.batches = [];

    // The stage borrows the shared brick materials and the cached stud
    // geometry, so only what it made itself is disposed here.
    for (const child of [...this.stage.children]) {
      this.stage.remove(child);
      const mesh = child as THREE.InstancedMesh;
      if (mesh.isInstancedMesh) mesh.dispose();
    }
    for (const geo of this.stageGeometry) geo.dispose();
    for (const d of this.stageDisposable) d.dispose();
    this.stageGeometry = [];
    this.stageDisposable = [];

    this.volume?.texture.dispose();
    this.volume = null;
    this.cavity.aoVolume.value = this.cavityFallback;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.clearModel();
    this.controls.dispose();
    for (const m of this.materials.all()) m.dispose();
    this.cavityFallback.dispose();
    this.environment.dispose();
    this.backdrop.dispose();
    this.renderer.dispose();
  }
}

/** Occupied grid cells, so the renderer can tell which studs are buried. */
function coverage(result: BuildResult): Set<number> {
  const set = new Set<number>();
  for (const p of result.placements)
    for (let y = p.y; y < p.y + p.height; y++)
      for (let z = p.z; z < p.z + p.d; z++)
        for (let x = p.x; x < p.x + p.w; x++) set.add(cell(x, y, z, result));
  return set;
}

function cell(x: number, y: number, z: number, result: BuildResult): number {
  return (y * result.gridZ + z) * result.gridX + x;
}

/**
 * Every stud on this part sits under something. In a solid model that is most
 * of them, and each one costs ~90 triangles that never reach a pixel.
 */
function studsBuried(p: Placement, covered: Set<number>, result: BuildResult): boolean {
  const above = p.y + p.height;
  for (let z = p.z; z < p.z + p.d; z++)
    for (let x = p.x; x < p.x + p.w; x++)
      if (!covered.has(cell(x, above, z, result))) return false;
  return true;
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Place the outline shell for one part. Growing it about the part's own centre
 * rather than pushing vertices along their normals keeps it watertight: a
 * chamfered box has a different normal on every facet, and displacing along
 * those splits the shell open at every corner.
 */
function shellMatrix(matrix: THREE.Matrix4, batch: Batch, x: number, y: number, z: number): void {
  const s = batch.shell;
  matrix.makeScale(s.x, s.y, s.z);
  matrix.setPosition(x, y + batch.centreY * (1 - s.y), z);
}

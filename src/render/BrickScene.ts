/**
 * The interactive 3D manual.
 *
 * Everything already built is drawn solid, the parts for the current step drop
 * into place with a short animation and glow, and the rest of the model can be
 * ghosted in so you can see where you are heading. That combination — solid /
 * highlighted / ghosted — is what makes a step-by-step manual readable, and it
 * is the reason this renders real brick geometry with studs instead of cubes.
 *
 * Draw calls are kept low by batching every placement of the same footprint
 * into one InstancedMesh with per-instance colour.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { brickGeometry } from './brickGeometry';
import { COLOR_BY_LDRAW } from '../core/lego/colors';
import { PLATE_MM, STUD_MM } from '../core/lego/units';
import type { BuildResult, Placement } from '../types';

interface Entry {
  placement: Placement;
  step: number;
  color: THREE.Color;
}

interface Batch {
  key: string;
  entries: Entry[];
  placed: THREE.InstancedMesh;
  current: THREE.InstancedMesh;
  ghost: THREE.InstancedMesh;
}

const SUPPORT_TINT = new THREE.Color(0x9aa4ad);
const DROP_HEIGHT_MM = 26;
const DROP_DURATION_MS = 420;

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
  private batches: Batch[] = [];
  private baseplate: THREE.Mesh | null = null;
  private contactShadow: THREE.Mesh | null = null;
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

  private materialPlaced: THREE.MeshStandardMaterial;
  private materialCurrent: THREE.MeshStandardMaterial;
  private materialGhost: THREE.MeshStandardMaterial;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Brick colours are the whole point, so no tone mapping: what the palette
    // says is what gets drawn.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.add(this.root);

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
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

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.1);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.6, 1, 0.75);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-0.8, 0.4, -0.6);
    this.scene.add(fill);

    this.materialPlaced = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.0 });
    this.materialCurrent = new THREE.MeshStandardMaterial({
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.28,
    });
    this.materialGhost = new THREE.MeshStandardMaterial({
      roughness: 0.6,
      metalness: 0.0,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });

    this.loop = this.loop.bind(this);
    this.frameHandle = requestAnimationFrame(this.loop);
  }

  setOptions(options: Partial<SceneOptions>): void {
    this.options = { ...this.options, ...options };
    this.refreshInstances();
    if (this.options.followStep) this.focusCurrentStep();
  }

  setModel(result: BuildResult | null): void {
    this.clearModel();
    this.result = result;
    this.step = 0;
    this.userMovedCamera = false;
    if (!result) return;

    const stepOf = new Map<Placement, number>();
    for (const s of result.steps) for (const p of s.placements) stepOf.set(p, s.index);

    const grouped = new Map<string, Entry[]>();
    for (const p of result.placements) {
      const key = `${p.w}x${p.d}x${p.height}`;
      const hex = COLOR_BY_LDRAW.get(p.color)?.hex ?? '#999999';
      const entry: Entry = {
        placement: p,
        step: stepOf.get(p) ?? 0,
        color: new THREE.Color(hex),
      };
      const arr = grouped.get(key);
      if (arr) arr.push(entry);
      else grouped.set(key, [entry]);
    }

    for (const [key, entries] of grouped) {
      const [w, d, h] = key.split('x').map(Number);
      const geo = brickGeometry(w, d, h);
      const make = (mat: THREE.Material) => {
        const mesh = new THREE.InstancedMesh(geo, mat, entries.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        this.root.add(mesh);
        return mesh;
      };
      this.batches.push({
        key,
        entries,
        placed: make(this.materialPlaced),
        current: make(this.materialCurrent),
        ghost: make(this.materialGhost),
      });
    }

    this.addBaseplate(result);

    const width = result.gridX * STUD_MM;
    const height = result.gridY * PLATE_MM;
    const depth = result.gridZ * STUD_MM;
    this.modelCenter.set(width / 2, height / 2, depth / 2);
    this.modelSize.set(width, height, depth);

    this.refreshInstances();
    this.frameAll();
  }

  private addBaseplate(result: BuildResult): void {
    const margin = 2;
    const w = (result.gridX + margin * 2) * STUD_MM;
    const d = (result.gridZ + margin * 2) * STUD_MM;
    const geo = new THREE.BoxGeometry(w, PLATE_MM, d);
    geo.translate((result.gridX * STUD_MM) / 2, -PLATE_MM / 2, (result.gridZ * STUD_MM) / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f3237, roughness: 0.75 });
    this.baseplate = new THREE.Mesh(geo, mat);
    this.root.add(this.baseplate);

    const shadowGeo = new THREE.PlaneGeometry(w * 1.6, d * 1.6);
    shadowGeo.rotateX(-Math.PI / 2);
    shadowGeo.translate((result.gridX * STUD_MM) / 2, -PLATE_MM - 0.4, (result.gridZ * STUD_MM) / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: radialShadowTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.root.add(this.contactShadow);
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

  /** Rebuild the three instance buffers for the current step. */
  private refreshInstances(): void {
    const matrix = new THREE.Matrix4();
    for (const batch of this.batches) {
      let nPlaced = 0;
      let nCurrent = 0;
      let nGhost = 0;
      for (const entry of batch.entries) {
        const p = entry.placement;
        const pos = new THREE.Vector3(
          (p.x + p.w / 2) * STUD_MM,
          p.y * PLATE_MM,
          (p.z + p.d / 2) * STUD_MM,
        );
        const color =
          this.options.highlightSupports && p.support ? SUPPORT_TINT : entry.color;

        if (entry.step < this.step) {
          matrix.makeTranslation(pos.x, pos.y, pos.z);
          batch.placed.setMatrixAt(nPlaced, matrix);
          batch.placed.setColorAt(nPlaced, color);
          nPlaced++;
        } else if (entry.step === this.step) {
          matrix.makeTranslation(pos.x, pos.y, pos.z);
          batch.current.setMatrixAt(nCurrent, matrix);
          batch.current.setColorAt(nCurrent, color);
          nCurrent++;
        } else if (this.options.showGhost) {
          matrix.makeTranslation(pos.x, pos.y, pos.z);
          batch.ghost.setMatrixAt(nGhost, matrix);
          batch.ghost.setColorAt(nGhost, color);
          nGhost++;
        }
      }
      batch.placed.count = nPlaced;
      batch.current.count = nCurrent;
      batch.ghost.count = nGhost;
      for (const mesh of [batch.placed, batch.current, batch.ghost]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Animate the current step's parts dropping into place. */
  private applyDropAnimation(t: number): void {
    const eased = 1 - Math.pow(1 - t, 3);
    const offset = (1 - eased) * DROP_HEIGHT_MM;
    const matrix = new THREE.Matrix4();
    for (const batch of this.batches) {
      let n = 0;
      for (const entry of batch.entries) {
        if (entry.step !== this.step) continue;
        const p = entry.placement;
        matrix.makeTranslation(
          (p.x + p.w / 2) * STUD_MM,
          p.y * PLATE_MM + offset,
          (p.z + p.d / 2) * STUD_MM,
        );
        batch.current.setMatrixAt(n, matrix);
        n++;
      }
      if (n > 0) batch.current.instanceMatrix.needsUpdate = true;
    }
    this.materialCurrent.emissiveIntensity = 0.28 + 0.25 * (1 - eased);
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
    return Math.max(60, Math.max(distForHeight, distForWidth) * 1.3);
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
      front: [c.x, c.y, c.z + dist],
      side: [c.x + dist, c.y, c.z],
      top: [c.x, c.y + dist, c.z + 0.001],
      iso: [c.x + dist * 0.55, c.y + dist * 0.45, c.z + dist * 0.8],
    };
    const [px, py, pz] = positions[view];
    this.camera.position.set(px, py, pz);
    this.controls.target.copy(c);
    this.controls.update();
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
      for (const mesh of [batch.placed, batch.current, batch.ghost]) {
        this.root.remove(mesh);
        mesh.dispose();
      }
    }
    this.batches = [];
    for (const obj of [this.baseplate, this.contactShadow]) {
      if (!obj) continue;
      this.root.remove(obj);
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    this.baseplate = null;
    this.contactShadow = null;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.clearModel();
    this.controls.dispose();
    this.materialPlaced.dispose();
    this.materialCurrent.dispose();
    this.materialGhost.dispose();
    this.renderer.dispose();
  }
}

let shadowTexture: THREE.Texture | null = null;

function radialShadowTexture(): THREE.Texture {
  if (shadowTexture) return shadowTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  shadowTexture = new THREE.CanvasTexture(canvas);
  return shadowTexture;
}

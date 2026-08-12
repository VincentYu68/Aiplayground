/**
 * The photographic side of the viewer: a neutral studio to light the model and
 * a seamless sweep to stand it on.
 *
 * three ships RoomEnvironment, which is a *room* — off-white walls, a few
 * coloured blocks, a lamp — and it tints reflections just enough that the LEGO
 * palette stops matching itself. The palette is not negotiable, so the lighting
 * is: this is a plain grey cyclorama with a big softbox above and slightly to
 * the left, one dim cool fill from the right, and a bright strip behind for the
 * rim. Everything is neutral, so a Red 2x4 renders as Red 2x4.
 */

import * as THREE from 'three';

/** Emissive panel colours are linear radiance, so they can exceed 1. */
function radiance(r: number, g: number, b: number, scale: number): THREE.Color {
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace).multiplyScalar(scale);
}

/**
 * A tiny scene whose only job is to be captured into an environment map: the
 * panels are what the gloss on a brick reflects.
 */
function studioScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.deleteAttribute('uv');

  const panel = (
    color: THREE.Color,
    position: [number, number, number],
    scale: [number, number],
    lookAt: [number, number, number] = [0, 0, 0],
  ) => {
    const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.set(...position);
    mesh.scale.set(scale[0], scale[1], 1);
    mesh.lookAt(...lookAt);
    scene.add(mesh);
    return mesh;
  };

  // The cyclorama: a dim neutral shell so nothing renders against pure black.
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(14, 24, 16),
    new THREE.MeshBasicMaterial({ color: radiance(0.14, 0.145, 0.155, 1), side: THREE.BackSide }),
  );
  scene.add(shell);

  // A brighter upper hemisphere. Sky above, floor below, as in any real room.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(13, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42),
    new THREE.MeshBasicMaterial({ color: radiance(0.32, 0.335, 0.36, 1), side: THREE.BackSide }),
  );
  scene.add(sky);

  // Key softbox: large, close, high and a little to the left and front.
  panel(radiance(1, 0.99, 0.97, 4.6), [-3.5, 8, 5], [11, 11]);
  // A small hard source as well as the big soft one. The softbox alone gives a
  // broad sheen and no edge: it takes something small and bright to put a line
  // down a chamfer, which is most of what says "moulded plastic".
  panel(radiance(1, 1, 1, 30), [5.5, 9, -1], [1.8, 1.8]);
  // Cool fill from the right, weak enough to shape without lighting the shot.
  panel(radiance(0.86, 0.9, 1, 0.7), [9, 2.5, 2.5], [10, 9]);
  // Rim strip behind: the highlight that separates the model from the backdrop.
  panel(radiance(1, 1, 1, 2.0), [-1, 5, -9], [12, 3]);
  // Bounce off the sweep, so undersides get a little light back.
  panel(radiance(0.78, 0.79, 0.81, 1.25), [0, -6, 2], [18, 18]);

  return scene;
}

export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = studioScene();
  const target = pmrem.fromScene(scene, 0.03);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
  });
  pmrem.dispose();
  return target.texture;
}

/**
 * The backdrop: a light grey photographic sweep, brightest a little above and
 * behind the subject and falling off to the corners.
 *
 * It was dark first, to sit quietly in the dark UI, and that was the wrong
 * call — against a dark ground the palette lost its punch, the shadow on the
 * baseplate had nothing to fall on, and the whole thing read as a 3D widget
 * embedded in a page. Every LEGO product photograph is shot on a light sweep,
 * and it turns out that is not a stylistic accident.
 */
export function backdropTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const vertical = ctx.createLinearGradient(0, 0, 0, size);
  vertical.addColorStop(0, '#e9ecf0');
  vertical.addColorStop(0.5, '#d3d8de');
  vertical.addColorStop(1, '#aab0b8');
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, size, size);

  const pool = ctx.createRadialGradient(size * 0.5, size * 0.44, 0, size * 0.5, size * 0.44, size * 0.62);
  pool.addColorStop(0, 'rgba(255,255,255,0.35)');
  pool.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  pool.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Soft alpha disc, used to fade the ground plane out before it reaches the
 * edge of the frame so the sweep has no visible horizon.
 */
export function groundFadeTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.45, '#ffffff');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

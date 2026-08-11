/**
 * Turns a shot spec into a picture, in a real renderer.
 *
 * This file decides nothing about shape. Every number describing the object
 * arrives in the spec, authored in `objects.ts` where the ground-truth solid is
 * derived from the same numbers; all that happens here is meshes, lights and a
 * camera. That split is the whole reason a render can be used as a test
 * photograph: if the picture and the truth could drift apart, the benchmark
 * would be measuring the drift.
 *
 * Deliberately not a flat sweep with a Lambert term. A perspective camera, an
 * environment the specular lobe can reflect, a key light with an angular size
 * so its shadow has a penumbra that widens with distance, and a floor and
 * background with texture on them. Those are the things a photograph has that
 * `scenes.ts` does not, and they are exactly the things a depth network trained
 * on photographs is looking for.
 */

import * as THREE from '/three.module.js';

const DEG = Math.PI / 180;

/** The same seeded generator the app uses, so a scene is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function srgb(colour) {
  return new THREE.Color().setRGB(colour[0] / 255, colour[1] / 255, colour[2] / 255, THREE.SRGBColorSpace);
}

// --- geometry --------------------------------------------------------------

/** Orient a Y-aligned primitive onto an arbitrary segment. */
function alongSegment(geometry, a, b) {
  const from = new THREE.Vector3(a[0], a[1], a[2]);
  const to = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  if (length > 0) {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize(),
    );
    geometry.applyQuaternion(q);
  }
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  geometry.translate(mid.x, mid.y, mid.z);
  return geometry;
}

function shapeFrom(points) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shape;
}

function geometryFor(mesh) {
  switch (mesh.kind) {
    case 'box': {
      const g = new THREE.BoxGeometry(mesh.half[0] * 2, mesh.half[1] * 2, mesh.half[2] * 2);
      if (mesh.rotY) g.rotateY(mesh.rotY);
      return g.translate(mesh.pos[0], mesh.pos[1], mesh.pos[2]);
    }
    case 'ellipsoid': {
      const g = new THREE.SphereGeometry(1, 56, 36);
      g.scale(mesh.radii[0], mesh.radii[1], mesh.radii[2]);
      return g.translate(mesh.pos[0], mesh.pos[1], mesh.pos[2]);
    }
    case 'capsule': {
      const length = Math.hypot(
        mesh.b[0] - mesh.a[0],
        mesh.b[1] - mesh.a[1],
        mesh.b[2] - mesh.a[2],
      );
      return alongSegment(new THREE.CapsuleGeometry(mesh.r, length, 12, 28), mesh.a, mesh.b);
    }
    case 'cylinder': {
      const length = Math.hypot(
        mesh.b[0] - mesh.a[0],
        mesh.b[1] - mesh.a[1],
        mesh.b[2] - mesh.a[2],
      );
      return alongSegment(new THREE.CylinderGeometry(mesh.r, mesh.r, length, 40, 1), mesh.a, mesh.b);
    }
    case 'torus': {
      const sweep = mesh.arcSweep ?? Math.PI * 2;
      const g = new THREE.TorusGeometry(mesh.ring, mesh.tube, 20, 64, sweep);
      // TorusGeometry starts its sweep at +x in the xy plane, which is the same
      // parametrisation the inside-test uses, so the arc lines up by rotating
      // rather than by re-deriving it.
      if (mesh.arcFrom) g.rotateZ(mesh.arcFrom);
      if (mesh.axis === 'y') g.rotateX(Math.PI / 2);
      else if (mesh.axis === 'x') g.rotateY(Math.PI / 2);
      return g.translate(mesh.pos[0], mesh.pos[1], mesh.pos[2]);
    }
    case 'lathe': {
      const points = mesh.profile.map((p) => new THREE.Vector2(p[0], p[1]));
      // The profile is a closed polygon and LatheGeometry revolves a polyline,
      // so the closing edge has to be given explicitly or the solid is open
      // along one seam.
      points.push(points[0].clone());
      const g = new THREE.LatheGeometry(points, 96);
      return g.translate(mesh.pos[0], mesh.pos[1], mesh.pos[2]);
    }
    case 'prism': {
      const shape = shapeFrom(mesh.outline);
      for (const hole of mesh.holes) shape.holes.push(shapeFrom(hole));
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: mesh.depth,
        bevelEnabled: false,
        curveSegments: 4,
      });
      g.translate(0, 0, -mesh.depth / 2);
      if (mesh.rotY) g.rotateY(mesh.rotY);
      return g.translate(mesh.pos[0], mesh.pos[1], mesh.pos[2]);
    }
    default:
      throw new Error(`unknown mesh kind ${mesh.kind}`);
  }
}

/**
 * Fine roughness variation, shared by every surface.
 *
 * Without it every material is perfectly uniform, and perfect uniformity is the
 * strongest tell that a picture was computed rather than taken — real paint has
 * orange peel, real ceramic has glaze thickness, real wood has grain. It costs
 * one texture and it is the cheapest realism in the file.
 */
let detailTexture = null;
function surfaceDetail() {
  if (detailTexture) return detailTexture;
  const rng = mulberry32(90210);
  detailTexture = noiseCanvas(256, (ctx, size) => {
    ctx.fillStyle = '#cfcfcf';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 9000; i++) {
      const l = 58 + rng() * 42;
      ctx.fillStyle = `hsla(0, 0%, ${l}%, 0.5)`;
      ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 2.4, 1 + rng() * 2.4);
    }
  });
  detailTexture.colorSpace = THREE.NoColorSpace;
  detailTexture.repeat.set(4, 4);
  return detailTexture;
}

function materialFor(spec, pass) {
  if (pass === 'mask') return new THREE.MeshBasicMaterial({ color: 0xffffff });
  if (pass === 'clay') {
    return new THREE.MeshStandardMaterial({ color: 0xb9bcc4, roughness: 0.72, metalness: 0.02 });
  }
  const material = new THREE.MeshPhysicalMaterial({
    color: srgb(spec.colour),
    roughness: spec.roughness,
    metalness: spec.metalness,
    roughnessMap: surfaceDetail(),
  });
  if (spec.clearcoat) {
    material.clearcoat = spec.clearcoat;
    material.clearcoatRoughness = 0.08;
  }
  if (spec.sheen) {
    material.sheen = spec.sheen;
    material.sheenRoughness = 0.85;
    material.sheenColor = new THREE.Color(0xffffff);
  }
  return material;
}

// --- procedural texture ----------------------------------------------------

function noiseCanvas(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** A surface with grain in it: wood for a desk, weave for a sweep. */
function surfaceTexture(background) {
  const rng = mulberry32(background.seed + 17);
  const hue = background.hue;
  return noiseCanvas(512, (ctx, size) => {
    ctx.fillStyle = `hsl(${hue}, ${background.kind === 'desk' ? 26 : 8}%, ${
      background.kind === 'desk' ? 38 : 62
    }%)`;
    ctx.fillRect(0, 0, size, size);
    if (background.kind === 'desk') {
      // Wood grain: long, low-contrast streaks with occasional dark lines.
      for (let i = 0; i < 260; i++) {
        const y = rng() * size;
        const h = 1 + rng() * 5;
        ctx.fillStyle = `hsla(${hue + rng() * 12 - 6}, 30%, ${20 + rng() * 34}%, ${0.06 + rng() * 0.18})`;
        ctx.fillRect(0, y, size, h);
      }
      for (let i = 0; i < 14; i++) {
        ctx.strokeStyle = `hsla(${hue}, 34%, 16%, 0.35)`;
        ctx.lineWidth = 0.6 + rng() * 1.4;
        ctx.beginPath();
        const y = rng() * size;
        ctx.moveTo(0, y);
        for (let x = 0; x <= size; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 6);
        ctx.stroke();
      }
    } else {
      // Paper sweep. Large soft blotches first — an even speckle still reads as
      // a flat fill once it is out of focus behind the subject, and it is the
      // low-frequency unevenness that stops a background looking painted on.
      for (let i = 0; i < 26; i++) {
        const x = rng() * size;
        const y = rng() * size;
        const r = size * (0.08 + rng() * 0.3);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const l = 48 + rng() * 26;
        g.addColorStop(0, `hsla(${hue + rng() * 20 - 10}, 10%, ${l}%, 0.5)`);
        g.addColorStop(1, `hsla(${hue}, 10%, ${l}%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < 24000; i++) {
        const l = 52 + rng() * 22;
        ctx.fillStyle = `hsla(${hue}, 6%, ${l}%, 0.25)`;
        ctx.fillRect(rng() * size, rng() * size, 1.4, 1.4);
      }
    }
  });
}

/**
 * The environment the specular lobe reflects.
 *
 * Without one, every glossy surface reflects black and the object reads as
 * plastic no matter what its roughness says. This is a cheap studio: a bright
 * softbox above and to one side, a dimmer bounce opposite, a dark floor.
 */
function environmentTexture(renderer, lighting, background) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, `hsl(${background.hue}, 12%, 82%)`);
  sky.addColorStop(0.55, `hsl(${background.hue}, 10%, 54%)`);
  sky.addColorStop(1, `hsl(${background.hue}, 14%, 16%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 512, 256);

  const softbox = (u, v, w, h, alpha) => {
    const g = ctx.createRadialGradient(u, v, 0, u, v, Math.max(w, h));
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(u - w, v - h, w * 2, h * 2);
  };
  // Where the key is, so the highlight on the object agrees with its shadow.
  // The hot core matters more than the spread: a broad gradient alone gives a
  // glossy surface a vague sheen, and it is the small bright source that draws
  // the highlight line along an edge and says "this is curved, and that way".
  const keyU = ((((-lighting.keyAzimuth + 180) % 360) + 360) % 360) * (512 / 360);
  const keyV = 90 - lighting.keyElevation;
  softbox(keyU, keyV, 140, 100, 0.55);
  softbox(keyU, keyV, 34, 26, 1);
  softbox((keyU + 256) % 512, 120, 110, 80, 0.22);
  // A bright band along the horizon, which is what a room does to a car's flank.
  const band = ctx.createLinearGradient(0, 108, 0, 150);
  band.addColorStop(0, 'rgba(255,255,255,0)');
  band.addColorStop(0.5, 'rgba(255,255,255,0.30)');
  band.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 108, 512, 42);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(texture);
  pmrem.dispose();
  texture.dispose();
  return target.texture;
}

// --- the scene -------------------------------------------------------------

/** Camera basis for an azimuth and elevation, matching `visualHull.ts`. */
function cameraBasis(azimuthDeg, elevationDeg) {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  // Chosen so the camera's right-hand axis is (cos a, 0, sin a): the same
  // horizontal the pipeline calls u. Get this backwards and every measurement
  // downstream is mirrored.
  const back = new THREE.Vector3(
    -Math.sin(a) * Math.cos(e),
    Math.sin(e),
    Math.cos(a) * Math.cos(e),
  ).normalize();
  const right = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return { back, right, up };
}

function addClutter(scene, background, bounds, basis) {
  if (background.clutter <= 0) return;
  const rng = mulberry32(background.seed);
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[2] - bounds.min[2];
  const spread = Math.max(width, depth) * 1.6 + 1.2;
  for (let i = 0; i < background.clutter; i++) {
    const h = 0.18 + rng() * 0.85;
    const w = 0.1 + rng() * 0.3;
    const kind = rng();
    const geometry =
      kind < 0.4
        ? new THREE.BoxGeometry(w * 2, h, w * 1.4)
        : kind < 0.75
          ? new THREE.CylinderGeometry(w, w * 1.05, h, 28)
          : new THREE.SphereGeometry(h / 2, 28, 20);
    // Behind and to the sides, never in front: a distractor that occludes the
    // subject is testing occlusion handling, which is a different question.
    const alongRight = (rng() * 2 - 1) * spread;
    const behind = 0.6 + rng() * spread;
    const position = new THREE.Vector3()
      .addScaledVector(basis.right, alongRight)
      .addScaledVector(basis.back, -behind);
    const camouflage = background.camouflage && i === 0;
    const material = new THREE.MeshPhysicalMaterial({
      color: camouflage
        ? srgb(background.subjectColour ?? [180, 60, 60])
        : new THREE.Color().setHSL(rng(), 0.32 + rng() * 0.3, 0.3 + rng() * 0.35),
      roughness: 0.3 + rng() * 0.6,
      metalness: rng() < 0.25 ? 0.8 : 0.04,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, h / 2, position.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function buildScene(spec, renderer) {
  const scene = new THREE.Scene();
  const pass = spec.pass;
  const basis = cameraBasis(spec.camera.azimuth, spec.camera.elevation);

  const objectRoot = new THREE.Group();
  for (const part of spec.parts) {
    const mesh = new THREE.Mesh(geometryFor(part.mesh), materialFor(part.material, pass));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    objectRoot.add(mesh);
  }
  scene.add(objectRoot);

  if (pass === 'mask') {
    scene.background = new THREE.Color(0x000000);
    return { scene, basis };
  }

  const background = spec.background;
  if (pass === 'clay') {
    scene.background = new THREE.Color(0x1b1d23);
  } else {
    scene.environment = environmentTexture(renderer, spec.lighting, background);
    // Turned down on purpose. At full strength the image-based light fills the
    // shadows back in and the picture loses the one cue that says where the
    // object touches the ground, which is most of what separates a photograph
    // from a drawing of the same object.
    scene.environmentIntensity = 0.55;
    scene.background = new THREE.Color().setHSL((background.hue / 360) % 1, 0.09, 0.42);
  }

  // Floor. Everything stands on y = 0, so the contact shadow lands where the
  // object actually touches — which is the cue that tells a human, and a depth
  // network, how far away the object is.
  const floorMaterial =
    pass === 'clay'
      ? new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.9, metalness: 0 })
      : new THREE.MeshStandardMaterial({
          map: surfaceTexture(background),
          roughness: background.kind === 'desk' ? 0.45 : 0.75,
          metalness: 0.02,
        });
  if (floorMaterial.map) floorMaterial.map.repeat.set(3, 3);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  if (pass === 'beauty') {
    // A wall, well behind the subject, so the background has a horizon and a
    // falloff rather than being one flat colour behind the outline.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 24),
      new THREE.MeshStandardMaterial({
        map: surfaceTexture({ ...background, kind: 'sweep', seed: background.seed + 5 }),
        roughness: 0.95,
        metalness: 0,
      }),
    );
    wall.receiveShadow = true;
    const away = 4.5;
    wall.position.set(-basis.back.x * away, 11, -basis.back.z * away);
    wall.lookAt(0, 11, 0);
    scene.add(wall);
    addClutter(scene, background, spec.bounds, basis);
  }

  const lighting = spec.lighting;
  const keyDir = (() => {
    const a = (spec.camera.azimuth + lighting.keyAzimuth) * DEG;
    const e = lighting.keyElevation * DEG;
    return new THREE.Vector3(-Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  })();

  // The key is split into a few jittered sources across its angular size. One
  // directional light gives a shadow with a razor edge that no real light makes;
  // three across seven degrees give a penumbra that widens with distance from
  // the contact point, which is the cue that reads as "photograph".
  const samples = 3;
  const radius = lighting.keySoftness * DEG;
  for (let i = 0; i < samples; i++) {
    const spin = (i / samples) * Math.PI * 2;
    const jitter = new THREE.Vector3(
      Math.cos(spin) * radius,
      Math.sin(spin) * radius,
      0,
    ).applyAxisAngle(new THREE.Vector3(0, 1, 0), spec.camera.azimuth * DEG);
    const light = new THREE.DirectionalLight(
      new THREE.Color(lighting.keyTint[0], lighting.keyTint[1], lighting.keyTint[2]),
      lighting.keyIntensity / samples,
    );
    light.position.copy(keyDir).add(jitter).multiplyScalar(8);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.left = -3;
    light.shadow.camera.right = 3;
    light.shadow.camera.top = 3;
    light.shadow.camera.bottom = -3;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 20;
    light.shadow.bias = -0.0007;
    light.shadow.normalBias = 0.012;
    scene.add(light);
  }

  const fill = new THREE.DirectionalLight(0xdfe8ff, lighting.fillIntensity);
  fill.position.copy(basis.right).multiplyScalar(-6).setY(3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xfff2e0, lighting.rimIntensity);
  rim.position.copy(basis.back).multiplyScalar(-7).setY(4.5);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0xdcecff, 0x554a3c, lighting.ambientIntensity));
  return { scene, basis };
}

/**
 * Frame the object.
 *
 * The bounding sphere would be the easy way and it is wrong for anything long:
 * a car side-on would sit in the middle of a mostly empty frame. Projecting the
 * bounding box onto the camera's own axes frames what the camera will actually
 * see.
 */
function placeCamera(spec, basis, aspect) {
  if (spec.ortho) {
    // A known window in object units, so node can rasterise the identical view
    // from the inside-test and the two can be compared pixel for pixel. This is
    // the only camera in the file whose numbers are agreed with the other side.
    const { halfWidth, yLow, yHigh } = spec.ortho;
    const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, yHigh, yLow, 0.01, 60);
    const target = new THREE.Vector3(0, 0, 0);
    camera.position.copy(target).addScaledVector(basis.back, 12);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return camera;
  }
  const b = spec.bounds;
  let right = 0;
  let up = 0;
  const centre = new THREE.Vector3(
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  );
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) {
        const p = new THREE.Vector3(x, y, z).sub(centre);
        right = Math.max(right, Math.abs(p.dot(basis.right)));
        up = Math.max(up, Math.abs(p.dot(basis.up)));
      }

  const fov = spec.camera.fov * DEG;
  const fill = spec.camera.fill;
  const distance = Math.max(
    up / (Math.tan(fov / 2) * fill),
    right / (Math.tan(fov / 2) * aspect * fill),
  );

  const camera = new THREE.PerspectiveCamera(spec.camera.fov, aspect, 0.05, 200);
  const target = centre
    .clone()
    .addScaledVector(basis.right, -spec.camera.offset[0] * right)
    .addScaledVector(basis.up, -spec.camera.offset[1] * up);
  camera.position.copy(target).addScaledVector(basis.back, distance);
  camera.up.copy(basis.up);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

let renderer = null;

function getRenderer(width, height) {
  if (!renderer) {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  renderer.setSize(width, height, false);
  return renderer;
}

function disposeScene(scene) {
  scene.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Grain and a vignette, on the beauty pass only.
 *
 * Every real photograph has sensor noise and falls off towards the corners. It
 * is a small thing to look at and not a small thing to measure against: a
 * perfectly clean, perfectly even image lets a segmenter separate object from
 * background on an exact colour match, which is not a test of anything. The
 * mask pass is left alone — it has to stay a clean binary.
 */
function film(canvas, seed) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
  const rng = mulberry32(seed);
  const cx = out.width / 2;
  const cy = out.height / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 4;
      const falloff = 1 - 0.22 * (Math.hypot(x - cx, y - cy) / maxR) ** 2.2;
      const grain = (rng() - 0.5) * 7;
      data[i] = Math.max(0, Math.min(255, data[i] * falloff + grain));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] * falloff + grain));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] * falloff + grain));
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Render one shot and hand back a PNG data URL. */
window.renderShot = function renderShot(spec) {
  const gl = getRenderer(spec.width, spec.height);
  gl.toneMapping = spec.pass === 'mask' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = spec.pass === 'mask' ? 1 : spec.lighting.exposure;
  gl.shadowMap.enabled = spec.pass !== 'mask';

  const { scene, basis } = buildScene(spec, gl);
  const camera = placeCamera(spec, basis, spec.width / spec.height);
  gl.render(scene, camera);
  const url =
    spec.pass === 'beauty'
      ? film(gl.domElement, spec.background.seed).toDataURL('image/png')
      : gl.domElement.toDataURL('image/png');
  disposeScene(scene);
  if (scene.environment) scene.environment.dispose();
  return url;
};

window.rendererInfo = function rendererInfo() {
  const gl = getRenderer(8, 8);
  return gl.getContext().getParameter(gl.getContext().VERSION);
};

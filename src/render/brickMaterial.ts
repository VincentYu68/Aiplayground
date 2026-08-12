/**
 * What a brick is made of.
 *
 * ABS is a dense, slightly waxy plastic: no metal, a tight but not mirrored
 * specular lobe, and enough environment reflection that a flat face still shows
 * a gradient across it. roughness 0.25 lands there — lower turns bricks into
 * chrome, higher and they go chalky and the chamfers stop reading.
 *
 * The materials also carry the cavity-occlusion lookup (see cavity.ts). It is
 * grafted onto MeshStandardMaterial through the aomap hook rather than being a
 * bespoke shader, so tone mapping, shadows, instancing and the rest keep
 * working exactly as three intends.
 */

import * as THREE from 'three';
import type { CavityVolume } from './cavity';

export interface CavityUniforms {
  aoVolume: { value: THREE.Data3DTexture | null };
  aoVolumeMin: { value: THREE.Vector3 };
  aoVolumeInvSize: { value: THREE.Vector3 };
  aoStrength: { value: number };
  aoBias: { value: number };
  aoRange: { value: number };
}

export function createCavityUniforms(): CavityUniforms {
  return {
    aoVolume: { value: null },
    aoVolumeMin: { value: new THREE.Vector3() },
    // Never zero: a degenerate volume would make every fragment sample the
    // same texel and flatten the whole model to one shade.
    aoVolumeInvSize: { value: new THREE.Vector3(1, 1, 1) },
    aoStrength: { value: 1.0 },
    aoBias: { value: 0.22 },
    aoRange: { value: 0.32 },
  };
}

/** Texture lifetime belongs to the scene, which knows when a model is replaced. */
export function setCavityVolume(uniforms: CavityUniforms, volume: CavityVolume | null): void {
  uniforms.aoVolume.value = volume?.texture ?? null;
  if (!volume) return;
  uniforms.aoVolumeMin.value.copy(volume.min);
  uniforms.aoVolumeInvSize.value.copy(volume.invSize);
}

/**
 * A single-texel empty volume, bound when cavity occlusion is off or before a
 * model arrives. WebGL will not draw at all if a declared sampler is unbound,
 * so there always has to be something there.
 */
export function emptyVolume(): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Two samples along the surface normal, one just clear of the face and one a
 * brick further out. The near one finds the crack between touching parts, the
 * far one the broad shading under an arm or inside a recess.
 */
function cavityChunk(): string {
  return /* glsl */ `
    vec3 cavityOrigin = vCavityPos + vCavityNormal * 1.0;
    float occ = 0.62 * cavityAt( cavityOrigin + vCavityNormal * 2.5 )
              + 0.38 * cavityAt( cavityOrigin + vCavityNormal * 9.0 );
    float ambientOcclusion = 1.0 - aoStrength * smoothstep( aoBias, aoBias + aoRange, occ );

    reflectedLight.indirectDiffuse *= ambientOcclusion;
    // A quarter of the same term on direct light. Not physical — the shadow
    // map already owns direct occlusion — but a 0.9mm seam is finer than any
    // shadow map resolves, and without this the joints between parts stay lit
    // from the key and the model reads as one carved block.
    reflectedLight.directDiffuse *= mix( 1.0, ambientOcclusion, 0.25 );

    #if defined( USE_ENVMAP ) && defined( STANDARD )
      float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
      reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
    #endif
  `;
}

function withCavityAO(material: THREE.MeshStandardMaterial, uniforms: CavityUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vCavityPos;\nvarying vec3 vCavityNormal;',
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 cavityObject = vec4( transformed, 1.0 );
        vec3 cavityNormal = objectNormal;
        #ifdef USE_INSTANCING
          cavityObject = instanceMatrix * cavityObject;
          cavityNormal = mat3( instanceMatrix ) * cavityNormal;
        #endif
        vCavityPos = ( modelMatrix * cavityObject ).xyz;
        vCavityNormal = normalize( mat3( modelMatrix ) * cavityNormal );
        #include <project_vertex>`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform highp sampler3D aoVolume;
        uniform vec3 aoVolumeMin;
        uniform vec3 aoVolumeInvSize;
        uniform float aoStrength;
        uniform float aoBias;
        uniform float aoRange;
        varying vec3 vCavityPos;
        varying vec3 vCavityNormal;
        float cavityAt( vec3 p ) {
          return texture( aoVolume, ( p - aoVolumeMin ) * aoVolumeInvSize ).r;
        }`,
      )
      .replace('#include <aomap_fragment>', cavityChunk());
  };
  // Without this the patched and unpatched variants share a program.
  material.customProgramCacheKey = () => 'brickify-cavity';
}

export interface BrickMaterials {
  /** Everything built in an earlier step. */
  placed: THREE.MeshStandardMaterial;
  /** The parts going on right now. */
  current: THREE.MeshStandardMaterial;
  /** What is still to come. */
  ghost: THREE.MeshStandardMaterial;
  /** The baseplate the model stands on. */
  plate: THREE.MeshStandardMaterial;
  /** Shell drawn around the current step's parts. */
  outline: THREE.MeshBasicMaterial;
  all(): THREE.Material[];
}

/**
 * The shell around the current step's parts.
 *
 * It cannot be a fixed colour and it cannot be a glow: a white glow on a white
 * brick is invisible, which is exactly how a step became impossible to find in
 * the manual. So the shell reads the part's own colour out of the instance
 * attribute and draws whichever of near-black or white that colour is not —
 * every element in the palette ends up with a high-contrast edge, and no part
 * of the palette can collide with it.
 */
function outlineMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ side: THREE.BackSide, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      float partLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      diffuseColor.rgb = partLuma > 0.25 ? vec3( 0.004 ) : vec3( 1.0 );`,
    );
  };
  material.customProgramCacheKey = () => 'brickify-outline';
  return material;
}

export function createBrickMaterials(uniforms: CavityUniforms, cavityAO: boolean): BrickMaterials {
  const abs = () =>
    new THREE.MeshStandardMaterial({
      roughness: 0.25,
      metalness: 0.0,
      envMapIntensity: 0.95,
    });

  const placed = abs();
  const current = abs();
  // No standing tint. The parts going on now are called out by the outline
  // shell, which cannot be swallowed by the part's own colour; a wash of
  // emissive can, and it drains the colour out of the finished model as well.
  current.emissive = new THREE.Color(0xffffff);
  current.emissiveIntensity = 0;

  const plate = abs();
  plate.roughness = 0.34;

  const ghost = new THREE.MeshStandardMaterial({
    roughness: 0.5,
    metalness: 0.0,
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
  });

  const outline = outlineMaterial();

  const solid = [placed, current, plate];
  if (cavityAO) for (const m of solid) withCavityAO(m, uniforms);

  return {
    placed,
    current,
    ghost,
    plate,
    outline,
    all: () => [placed, current, ghost, plate, outline],
  };
}

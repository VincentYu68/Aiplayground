/**
 * What a brick is made of.
 *
 * ABS is a dense, slightly waxy plastic: no metal, a tight but not mirrored
 * specular lobe, and enough environment reflection that a flat face still shows
 * a gradient across it. roughness 0.28 lands there — lower turns bricks into
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
}

export function createCavityUniforms(): CavityUniforms {
  return {
    aoVolume: { value: null },
    aoVolumeMin: { value: new THREE.Vector3() },
    // Never zero: a degenerate volume would make every fragment sample the
    // same texel and flatten the whole model to one shade.
    aoVolumeInvSize: { value: new THREE.Vector3(1, 1, 1) },
    aoStrength: { value: 0.9 },
    aoBias: { value: 0.34 },
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
    float ambientOcclusion = 1.0 - aoStrength * smoothstep( aoBias, 1.0, occ );

    reflectedLight.indirectDiffuse *= ambientOcclusion;

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
  all(): THREE.MeshStandardMaterial[];
}

export function createBrickMaterials(uniforms: CavityUniforms, cavityAO: boolean): BrickMaterials {
  const abs = () =>
    new THREE.MeshStandardMaterial({
      roughness: 0.28,
      metalness: 0.0,
      envMapIntensity: 1.0,
    });

  const placed = abs();
  const current = abs();
  // A wash of light rather than a colour cast: tinting the highlight would
  // fight the palette, and the drop animation already says which parts are new.
  current.emissive = new THREE.Color(0xffffff);
  current.emissiveIntensity = 0.1;

  const plate = abs();
  plate.roughness = 0.34;

  const ghost = new THREE.MeshStandardMaterial({
    roughness: 0.5,
    metalness: 0.0,
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
  });

  const solid = [placed, current, plate];
  if (cavityAO) for (const m of solid) withCavityAO(m, uniforms);

  return { placed, current, ghost, plate, all: () => [placed, current, ghost, plate] };
}

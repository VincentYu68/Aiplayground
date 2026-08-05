import { generateModel } from './src/core/build/pipeline';
import { EMPTY } from './src/core/voxel/grid';
import { COLOR_BY_LDRAW } from './src/core/lego/colors';
import { DEFAULT_OPTIONS, type BackTreatment } from './src/types';

// A "head": tan oval with a dark face patch in the middle and brown hair round
// the outside. Mirroring puts the face on the back; wrapping should give hair.
const W = 240, H = 300;
const rgba = new Uint8ClampedArray(W*H*4);
const mask = new Uint8Array(W*H);
for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
  const i=(y*W+x)*4;
  const nx=(x-W/2)/(W*0.32), ny=(y-H/2)/(H*0.42);
  const inside = nx*nx+ny*ny <= 1;
  mask[y*W+x]=inside?1:0;
  if (!inside) { rgba[i]=238; rgba[i+1]=240; rgba[i+2]=243; rgba[i+3]=255; continue; }
  const r = Math.hypot(nx, ny);
  if (r > 0.62) { rgba[i]=70; rgba[i+1]=42; rgba[i+2]=20; }        // hair, wraps round
  else { rgba[i]=232; rgba[i+1]=190; rgba[i+2]=150; }              // face, front only
  // eyes: strong dark features, front only
  if (Math.hypot(x-(W/2-26), y-(H/2-20))<11 || Math.hypot(x-(W/2+26), y-(H/2-20))<11) {
    rgba[i]=25; rgba[i+1]=25; rgba[i+2]=30;
  }
  rgba[i+3]=255;
}

function faceColours(treatment: BackTreatment) {
  const r = generateModel(rgba, mask, W, H, { ...DEFAULT_OPTIONS, studsWide: 28, backTreatment: treatment, hollow: false });
  const dims = { sx: r.gridX, sy: r.gridY, sz: r.gridZ };
  // Rebuild an occupancy+colour grid from placements.
  const col = new Int32Array(dims.sx*dims.sy*dims.sz).fill(-1);
  for (const p of r.placements)
    for (let y=p.y;y<p.y+p.height;y++)
      for (let dz=0;dz<p.d;dz++) for (let dx=0;dx<p.w;dx++)
        col[(y*dims.sz+(p.z+dz))*dims.sx+(p.x+dx)] = p.color;

  // Sample the frontmost and backmost visible voxel of each column.
  const tally = (front: boolean) => {
    const m = new Map<number, number>();
    for (let y=0;y<dims.sy;y++) for (let x=0;x<dims.sx;x++) {
      let found=-1;
      if (front) { for (let z=0;z<dims.sz;z++){const v=col[(y*dims.sz+z)*dims.sx+x]; if(v>=0){found=v;break;}} }
      else { for (let z=dims.sz-1;z>=0;z--){const v=col[(y*dims.sz+z)*dims.sx+x]; if(v>=0){found=v;break;}} }
      if (found>=0) m.set(found,(m.get(found)??0)+1);
    }
    const total=[...m.values()].reduce((a,b)=>a+b,0);
    return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([c,n])=>`${COLOR_BY_LDRAW.get(c)?.name ?? c} ${Math.round(100*n/total)}%`).join(', ');
  };
  return { front: tally(true), back: tally(false), parts: r.totalParts, score: r.stability.score, iou: r.fidelity.silhouetteIoU, asm: r.stability.assemblies, ties: r.stability.tiesRecoloured, seam: r.stability.seamAlignment, cant: r.stability.cantilevered };
}

for (const t of ['mirror','wrap','flat'] as const) {
  const x = faceColours(t);
  console.log(`${t.padEnd(7)} front: ${x.front}`);
  console.log(`${''.padEnd(7)} back:  ${x.back}`);
  console.log(`${''.padEnd(7)} parts ${x.parts}, stability ${x.score}, IoU ${(x.iou*100).toFixed(0)}%, assemblies ${x.asm}, ties ${x.ties}, seam ${x.seam.toFixed(2)}, cantilever ${x.cant}`);
}
void EMPTY;

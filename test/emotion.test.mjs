import { scoreEmotions, topEmotion, EmotionTracker } from '../js/emotion.js';

const bs = (o) => ({ categories: Object.entries(o).map(([categoryName, score]) => ({ categoryName, score })) });
const pair = (base, v) => ({ [base + 'Left']: v, [base + 'Right']: v });

const cases = [
  ['neutral',   {}],
  ['neutral',   { ...pair('mouthSmile', 0.06), jawOpen: 0.05 }],           // idle noise
  ['happy',     { ...pair('mouthSmile', 0.9), ...pair('cheekSquint', 0.6) }],
  ['surprised', { jawOpen: 0.8, browInnerUp: 0.8, ...pair('eyeWide', 0.7), ...pair('browOuterUp', 0.6) }],
  ['angry',     { ...pair('browDown', 0.9), ...pair('mouthPress', 0.6), ...pair('eyeSquint', 0.5) }],
  ['sad',       { ...pair('mouthFrown', 0.85), browInnerUp: 0.6, mouthShrugLower: 0.4 }],
  ['disgusted', { ...pair('noseSneer', 0.9), ...pair('mouthUpperUp', 0.7), ...pair('browDown', 0.3) }],
  ['fearful',   { ...pair('eyeWide', 0.9), browInnerUp: 0.9, jawOpen: 0.5, ...pair('mouthStretch', 0.7) }],
];

let fails = 0;
console.log('=== emotion mapping ===');
for (const [want, shapes] of cases) {
  const vec = scoreEmotions(bs(shapes));
  const got = topEmotion(vec);
  const sum = Object.values(vec).reduce((a, b) => a + b, 0);
  const ok = got.label === want && Math.abs(sum - 1) < 1e-6;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} want=${want.padEnd(10)} got=${got.label.padEnd(10)} ${(got.score*100).toFixed(0)}%  sum=${sum.toFixed(4)}`);
}

// A smile must suppress "angry" even with lowered brows (the neg-term check).
const conflict = topEmotion(scoreEmotions(bs({ ...pair('mouthSmile', 0.9), ...pair('browDown', 0.7) })));
const ok2 = conflict.label === 'happy';
if (!ok2) fails++;
console.log(`${ok2 ? 'ok  ' : 'FAIL'} smile+browDown -> ${conflict.label} (expect happy, neg terms cancelling)`);

console.log('\n=== tracker identity ===');
const tr = new EmotionTracker();
const vecA = scoreEmotions(bs({ ...pair('mouthSmile', 0.9) }));
const vecB = scoreEmotions(bs({ ...pair('browDown', 0.9) }));
let ids = [];
for (let f = 0; f < 6; f++) {
  // two faces drifting slightly, and swapped in the input order each frame
  const a = { cx: 0.30 + f * 0.005, cy: 0.5, vec: vecA };
  const b = { cx: 0.70 - f * 0.005, cy: 0.5, vec: vecB };
  const out = tr.update(f % 2 ? [b, a] : [a, b]);
  ids.push((f % 2 ? [out[1].id, out[0].id] : [out[0].id, out[1].id]).join('/'));
}
const stable = new Set(ids).size === 1;
if (!stable) fails++;
console.log(`${stable ? 'ok  ' : 'FAIL'} ids stable across reordered frames: ${ids.join(' ')}`);

const conv = tr.update([{ cx: 0.30, cy: 0.5, vec: vecA }])[0];
const smoothOk = topEmotion(conv.vec).label === 'happy';
if (!smoothOk) fails++;
console.log(`${smoothOk ? 'ok  ' : 'FAIL'} smoothed track converges to happy`);

console.log(`\n${fails ? `FAIL (${fails})` : 'PASS'}`);
process.exitCode = fails ? 1 : 0;

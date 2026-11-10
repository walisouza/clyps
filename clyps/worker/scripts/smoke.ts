// Teste local do pipeline de vídeo, sem Supabase e sem chaves de IA.
// Gera um vídeo sintético 16:9, simula transcrição/seleção e renderiza os clipes.
// Uso: npm run smoke -- [pasta de saída]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../src/exec.js';
import { probe } from '../src/media.js';
import { renderSelection } from '../src/render.js';
import { mockSelect } from '../src/select.js';
import { mockTranscribe } from '../src/transcribe.js';
import { normalizeOptions, type JobOptions } from '../src/types.js';

const outDir = path.resolve(process.argv[2] ?? 'smoke-out');
await mkdir(outDir, { recursive: true });

const src = path.join(outDir, 'source.mp4');
await run('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=50',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=50',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src,
]);

const info = await probe(src);
const words = mockTranscribe(info.duration);

const variants: Partial<JobOptions>[] = [
  { aspect: '9:16', layout: 'fill', captionStyle: 'karaoke', clipLength: 'short', maxClips: 2 },
  { aspect: '9:16', layout: 'blur', captionStyle: 'bold', clipLength: 'short', maxClips: 1 },
  { aspect: '1:1', layout: 'blur', captionStyle: 'minimal', captionPosition: 'top', clipLength: 'short', maxClips: 1 },
  { aspect: 'original', captionStyle: 'none', clipLength: 'short', maxClips: 1 },
];

let n = 0;
for (const v of variants) {
  const opts = normalizeOptions(v);
  const selections = mockSelect(words, opts, info.duration);
  if (!selections.length) throw new Error('Nenhuma seleção gerada');
  for (const s of selections) {
    const r = await renderSelection(src, info, words, s, opts, outDir, n++);
    const p = await probe(r.file);
    console.log(
      `${path.basename(r.file)}  ${opts.aspect} ${opts.layout} ${opts.captionStyle}  →  ${p.width}x${p.height}  ${p.duration.toFixed(1)}s  áudio:${p.hasAudio}`,
    );
  }
}
console.log(`OK: ${n} clipes em ${outDir}`);

import { existsSync } from 'node:fs';
import { config } from './config.js';
import { escapeFilterPath } from './media.js';
import type { AudioEnhance } from './types.js';

let warnedMissingModel = false;

/** Redução de ruído por rede neural (RNNoise). Pulada se o modelo não estiver instalado. */
function rnnoise(mix: number): string[] {
  if (!existsSync(config.rnnoiseModel)) {
    if (!warnedMissingModel) {
      console.warn(`Modelo RNNoise não encontrado em ${config.rnnoiseModel}; o tratamento forte segue sem essa etapa.`);
      warnedMissingModel = true;
    }
    return [];
  }
  return [`arnndn=m='${escapeFilterPath(config.rnnoiseModel)}':mix=${mix}`];
}

/**
 * Tratamento de voz aplicado ao áudio do clipe final.
 * - light: corta ronco grave, tira chiado leve, comprime e nivela o volume para redes sociais (-14 LUFS).
 * - strong: para gravação de celular com eco e ruído. Adiciona RNNoise, um gate suave que abaixa a cauda
 *   do eco entre as palavras, corta o "embolado" dos graves, realça a presença da voz e tira sibilância.
 *   Reduz bastante o eco, mas não remove reverberação pesada por completo.
 */
export function clipAudioFilter(mode: AudioEnhance): string | undefined {
  if (mode === 'off') return undefined;
  if (mode === 'light') {
    return [
      'highpass=f=80',
      'afftdn=nr=10:nf=-40:tn=1',
      'acompressor=threshold=-18dB:ratio=2.5:attack=10:release=150:makeup=1.5',
      'loudnorm=I=-14:TP=-1.5:LRA=11',
      'aresample=48000',
    ].join(',');
  }
  return [
    'highpass=f=100',
    'lowpass=f=11000',
    ...rnnoise(0.9),
    'afftdn=nr=16:nf=-35:tn=1',
    'agate=threshold=0.015:ratio=1.8:attack=3:release=180:range=0.25',
    'equalizer=f=250:t=q:w=1:g=-2',
    'equalizer=f=3200:t=q:w=1.2:g=3',
    'deesser',
    'acompressor=threshold=-22dB:ratio=3.5:attack=4:release=120:makeup=2',
    'loudnorm=I=-14:TP=-1.5:LRA=7',
    'aresample=48000',
  ].join(',');
}

/** Limpeza do áudio enviado para a transcrição (ajuda a IA a entender fala com eco/ruído). */
export function sttAudioFilter(mode: AudioEnhance): string | undefined {
  if (mode === 'strong') return ['highpass=f=100', ...rnnoise(1), 'afftdn=nr=14:nf=-35:tn=1'].join(',');
  if (mode === 'light') return 'highpass=f=80';
  return undefined;
}

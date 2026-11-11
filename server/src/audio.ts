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
 * Converte para mono pelo índice dos canais (c0, c1…), sem depender do "layout" declarado no arquivo.
 * Algumas versões do FFmpeg (ex.: 5.1 do Debian) não conseguem negociar layouts sozinhas e falham com
 * "Cannot select channel layout"; com tudo explícito a cadeia funciona em qualquer versão.
 */
function toMono(channels: number): string {
  if (channels <= 1) return 'pan=mono|c0=c0';
  if (channels === 2) return 'pan=mono|c0=0.5*c0+0.5*c1';
  // 3+ canais: na ordem padrão (FL, FR, FC, …) o diálogo costuma estar no centro (c2).
  return 'pan=mono|c0=0.3*c0+0.3*c1+0.4*c2';
}

/** Saída padronizada para o encoder AAC: estéreo, 48 kHz, ponto flutuante. */
const STEREO_OUT = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** Sem tratamento de voz: só padroniza os canais (mantém o estéreo original quando existe). */
export function passthroughAudioFilter(channels: number): string {
  const toStereo =
    channels <= 1
      ? 'pan=stereo|c0=c0|c1=c0'
      : channels === 2
        ? 'pan=stereo|c0=c0|c1=c1'
        : 'pan=stereo|c0=0.6*c0+0.4*c2|c1=0.6*c1+0.4*c2';
  return `${toStereo},${STEREO_OUT}`;
}

/**
 * Tratamento de voz aplicado ao áudio do clipe final (sempre termina em estéreo 48 kHz).
 * - off: só padroniza os canais.
 * - light: corta ronco grave, tira chiado leve, comprime e nivela o volume para redes sociais (-14 LUFS).
 * - strong: para gravação de celular com eco e ruído. Adiciona RNNoise, um gate suave que abaixa a cauda
 *   do eco entre as palavras, corta o "embolado" dos graves, realça a presença da voz e tira sibilância.
 *   Reduz bastante o eco, mas não remove reverberação pesada por completo.
 * A voz é tratada em mono e devolvida em estéreo (o mesmo som nos dois lados).
 */
export function clipAudioFilter(mode: AudioEnhance, channels: number): string {
  if (mode === 'off') return passthroughAudioFilter(channels);
  // 'auphonic' só chega aqui quando o Auphonic não pôde ser usado: cai no tratamento forte local.
  const voice =
    mode === 'light'
      ? [
          'highpass=f=80',
          'afftdn=nr=10:nf=-40:tn=1',
          'acompressor=threshold=-18dB:ratio=2.5:attack=10:release=150:makeup=1.5',
          'loudnorm=I=-14:TP=-1.5:LRA=11',
        ]
      : [
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
        ];
  return [toMono(channels), ...voice, 'aresample=48000', 'pan=stereo|c0=c0|c1=c0', STEREO_OUT].join(',');
}

/** Limpeza do áudio enviado para a transcrição (ajuda a IA a entender fala com eco/ruído). */
export function sttAudioFilter(mode: AudioEnhance): string | undefined {
  if (mode === 'strong' || mode === 'auphonic') return ['highpass=f=100', ...rnnoise(1), 'afftdn=nr=14:nf=-35:tn=1'].join(',');
  if (mode === 'light') return 'highpass=f=80';
  return undefined;
}

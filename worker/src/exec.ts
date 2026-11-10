import { spawn } from 'node:child_process';

export type RunResult = { stdout: string; stderr: string };

/** Executa um binário sem shell (argumentos nunca são interpretados). */
export function run(cmd: string, args: string[], timeoutMs = 60 * 60 * 1000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-6000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} não pôde ser executado: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

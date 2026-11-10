import type { Clip, Job, JobOptions } from './types';

export type User = { id: string; email: string; credits: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Algo deu errado. Tente de novo.');
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => request<{ user: User | null; signupOpen: boolean }>('/me'),
  login: (email: string, password: string) => post<{ user: User }>('/login', { email, password }),
  signup: (email: string, password: string) => post<{ user: User }>('/signup', { email, password }),
  logout: () => post<{ ok: true }>('/logout', {}),

  listJobs: () => request<{ jobs: Job[] }>('/jobs'),
  getJob: (id: string) => request<{ job: Job; clips: Clip[] }>(`/jobs/${id}`),
  deleteJob: (id: string) => request<{ ok: true }>(`/jobs/${id}`, { method: 'DELETE' }),
  createJob: (
    source: { sourceType: 'url'; url: string } | { sourceType: 'upload'; uploadId: string; title: string },
    options: JobOptions,
  ) => post<{ id: string }>('/jobs', { ...source, options }),

  /** Envia o arquivo como corpo da requisição, com progresso. */
  upload(file: File, onProgress: (percent: number) => void): Promise<{ uploadId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/uploads');
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data: { uploadId?: string; error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* resposta sem JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.uploadId) resolve({ uploadId: data.uploadId });
        else reject(new Error(data.error || 'O envio falhou.'));
      };
      xhr.onerror = () => reject(new Error('O envio falhou. Confira sua conexão.'));
      xhr.send(file);
    });
  },

  clipUrl: (clipId: string, download = false) => `/api/clips/${clipId}/file${download ? '?download=1' : ''}`,
};

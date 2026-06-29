import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const BASE = '';  // same-origin, or proxied in dev

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useState() {
  return useQuery({
    queryKey: ['state'],
    queryFn: () => apiFetch('/api/state'),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch('/api/me'),
    staleTime: 60_000,      // account info rarely changes
    retry: 1,
  });
}

export function useAclMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, address }) =>
      apiFetch('/api/acl', { method: 'POST', body: JSON.stringify({ action, address }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
}

export function useDiscardPending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message_id }) =>
      apiFetch('/api/pending', { method: 'POST', body: JSON.stringify({ action: 'discard', message_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profile) =>
      apiFetch('/api/profiles', { method: 'POST', body: JSON.stringify(profile) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name) =>
      apiFetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
}

// ── Mail archive / inbox ──────────────────────────────────────────────────────

export function useMessages({ dir = 'all', view = 'thread', q = '', limit = 50 } = {}) {
  const params = new URLSearchParams({ dir, view, limit: String(limit) });
  if (q) params.set('q', q);
  return useQuery({
    queryKey: ['messages', dir, view, q, limit],
    queryFn: () => apiFetch(`/api/messages?${params.toString()}`),
    staleTime: 10_000,
  });
}

export function useMessage(id) {
  return useQuery({
    queryKey: ['message', id],
    queryFn: () => apiFetch(`/api/message/${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useThread(threadRoot) {
  return useQuery({
    queryKey: ['thread', threadRoot],
    queryFn: () => apiFetch(`/api/thread/${encodeURIComponent(threadRoot)}`),
    enabled: !!threadRoot,
    staleTime: 10_000,
  });
}

export function useSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      apiFetch('/api/send', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['thread'] });
    },
  });
}

export function useReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      apiFetch('/api/reply', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['thread'] });
    },
  });
}

export function useForward() {
  return useMutation({
    mutationFn: (payload) =>
      apiFetch('/api/forward', { method: 'POST', body: JSON.stringify(payload) }),
  });
}

export function useSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      apiFetch('/api/sync', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['thread'] });
    },
  });
}

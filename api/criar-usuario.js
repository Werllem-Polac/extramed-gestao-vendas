'use strict';

// Vercel Serverless Function — Criação e atualização de senha de usuários
//
// Por que existe:
//   auth.signUp() no frontend dispara e-mail de confirmação (rate limit do Supabase).
//   A Admin API (/auth/v1/admin/users) cria o usuário já confirmado, sem enviar e-mail,
//   mas exige a service_role key que nunca pode ficar exposta no cliente.
//
// Variáveis de ambiente necessárias (painel Vercel):
//   SUPABASE_URL              — URL do projeto Supabase
//   SUPABASE_SERVICE_ROLE_KEY — Chave service_role (NUNCA expor ao cliente)
//   ALLOWED_ORIGINS           — Origens permitidas, separadas por vírgula

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function corsHeaders(origin, allowedOrigins) {
  const originOk = allowedOrigins.length === 0 || allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin':  origin ? (originOk ? origin : 'null') : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

async function adminFetch(path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin, allowedOrigins);
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const originOk = allowedOrigins.length === 0 || allowedOrigins.includes(origin);
  if (!originOk && origin) return res.status(403).json({ error: 'Origem não permitida.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Configuração ausente.' });

  // Verificar que o chamador possui sessão ativa válida
  const callerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!callerToken) return res.status(401).json({ error: 'Não autenticado.' });

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${callerToken}` },
  });
  if (!verifyRes.ok) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });

  const { action, email, password, userId } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(422).json({ error: 'E-mail inválido.' });
  }
  if (!password || password.length < 8) {
    return res.status(422).json({ error: 'Senha deve ter mínimo 8 caracteres.' });
  }

  // ── CRIAR usuário ─────────────────────────────────────────────
  if (!action || action === 'criar') {
    const result = await adminFetch('/admin/users', 'POST', {
      email,
      password,
      email_confirm: true, // confirma imediatamente, sem enviar e-mail
    });

    if (!result.ok) {
      const msg = result.data?.msg || result.data?.message || '';
      if (msg.toLowerCase().includes('already') || result.status === 422) {
        return res.status(409).json({ error: 'E-mail já cadastrado. Use "Redefinir senha" para alterar a senha.' });
      }
      console.error('[criar-usuario] Erro Admin API:', result.status, result.data);
      return res.status(500).json({ error: 'Erro ao criar usuário: ' + msg });
    }

    return res.status(200).json({ ok: true, userId: result.data.id });
  }

  // ── REDEFINIR senha de usuário existente ──────────────────────
  if (action === 'redefinir-senha') {
    if (!userId) return res.status(422).json({ error: 'userId obrigatório para redefinir senha.' });

    const result = await adminFetch(`/admin/users/${userId}`, 'PUT', { password });

    if (!result.ok) {
      console.error('[criar-usuario] Erro ao redefinir senha:', result.status, result.data);
      return res.status(500).json({ error: 'Erro ao redefinir senha.' });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(422).json({ error: 'Ação inválida.' });
};

/**
 * Vercel Serverless Function — Formulário público de pacientes pendentes
 *
 * Por que existe:
 *   O formulário público não pode gravar diretamente no Supabase com a anon key
 *   porque isso expõe toda a tabela app_data (incluindo dados da clínica) a qualquer
 *   chamada não autenticada. Esta função usa a service_role key (somente servidor)
 *   e aplica validação, sanitização e rate limiting antes de persistir.
 *
 * Variáveis de ambiente necessárias (configurar no painel Vercel):
 *   SUPABASE_URL              — URL do projeto Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — Chave service_role (NUNCA expor ao cliente)
 *   ALLOWED_ORIGINS           — Origens permitidas, separadas por vírgula
 *                               Ex.: https://extramed-gestao.vercel.app,https://meudominio.com
 */

'use strict';

const { randomUUID } = require('crypto');

const DB_KEY      = 'extramed_clinica_vendas_v1';
const RATE_LIMIT  = 5;            // envios por IP por janela
const WINDOW_MS   = 60 * 60 * 1000; // 1 hora

// Estado em memória — sobrevive entre invocações quentes na mesma instância
const ipStore = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function checkRateLimit(ip) {
  const now  = Date.now();
  const rec  = ipStore.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    ipStore.set(ip, { count: 1, start: now });
    return true;
  }
  if (rec.count >= RATE_LIMIT) return false;
  rec.count++;
  return true;
}

function sanitize(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  // Remove control characters e limita comprimento; sem HTML-encode aqui —
  // os dados são armazenados em JSON e sanitizados no frontend antes de exibir.
  return val.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function supabaseFetch(path, method, body) {
  const url  = `${process.env.SUPABASE_URL}/rest/v1${path}`;
  const opts = {
    method,
    headers: {
      'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

// ── Handler principal ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Headers de segurança mínimos (o vercel.json cobre o resto)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  // CORS — valida origin contra lista de permitidas
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const originOk = allowedOrigins.length === 0 || allowedOrigins.includes(origin);

  if (origin) res.setHeader('Access-Control-Allow-Origin', originOk ? origin : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!originOk && allowedOrigins.length > 0) {
    return res.status(403).json({ error: 'Origem não permitida.' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  // Verificar variáveis de ambiente
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[paciente-pendente] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  // Rate limiting por IP
  const ip = getIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em 1 hora.' });
  }

  // Corpo da requisição (Vercel auto-parseia JSON)
  const body = req.body || {};

  // Validação dos campos obrigatórios
  const nome             = sanitize(body.nome, 150);
  const cpfDigits        = String(body.cpf || '').replace(/\D/g, '');
  const consentimento    = body.consentimentoLGPD === true;
  const email            = sanitize(body.email, 150);

  const erros = [];
  if (!nome || nome.length < 2)    erros.push('Nome inválido (mínimo 2 caracteres).');
  if (cpfDigits.length !== 11)     erros.push('CPF deve ter 11 dígitos.');
  if (!consentimento)              erros.push('Consentimento LGPD é obrigatório.');
  if (email && !isValidEmail(email)) erros.push('E-mail inválido.');

  if (erros.length > 0) return res.status(422).json({ error: erros.join(' ') });

  // Montar registro de paciente pendente
  const pending = {
    id:                  randomUUID(),
    nome,
    cpf:                 cpfDigits,
    telefone:            sanitize(body.telefone, 20),
    rua:                 sanitize(body.rua),
    numero:              sanitize(body.numero, 20),
    bairro:              sanitize(body.bairro),
    cidade:              sanitize(body.cidade),
    estado:              sanitize(body.estado, 2).toUpperCase(),
    cep:                 String(body.cep || '').replace(/\D/g, '').slice(0, 8),
    nascimento:          sanitize(body.nascimento, 10),
    email,
    dataEnvio:           new Date().toISOString(),
    consentimentoLGPD:   true,
    dataConsentimento:   new Date().toISOString(),
    ipEnvio:             ip,   // armazenado para auditoria LGPD
    status:              'pendente',
  };

  // Ler app_data atual (via service_role — nunca exposto ao cliente)
  const readResult = await supabaseFetch(
    `/app_data?key=eq.${encodeURIComponent(DB_KEY)}&select=value`,
    'GET'
  );

  let remoteDB = {};
  if (readResult.ok && Array.isArray(readResult.data) && readResult.data.length > 0) {
    remoteDB = readResult.data[0].value || {};
  }

  if (!Array.isArray(remoteDB.pendingPatients)) remoteDB.pendingPatients = [];
  remoteDB.pendingPatients.push(pending);

  // Gravar de volta (service_role ignora RLS — apenas esta função tem acesso)
  const saveResult = await supabaseFetch('/app_data', 'POST', {
    key:   DB_KEY,
    value: remoteDB,
  });

  if (!saveResult.ok && saveResult.status !== 201) {
    console.error('[paciente-pendente] Erro Supabase:', saveResult.status, saveResult.data);
    return res.status(500).json({ error: 'Erro ao salvar. Tente novamente.' });
  }

  return res.status(200).json({ success: true });
};

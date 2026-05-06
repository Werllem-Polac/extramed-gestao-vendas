'use strict';

// Vercel Cron Function — executa diariamente às 03:00 UTC
// Lê o snapshot atual de app_data e grava em app_data_backups
// Mantém os últimos 60 backups (≈ 2 meses) via cleanup_old_backups()

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;
const DB_KEY       = 'extramed_clinica_vendas_v1';

async function supabaseFetch(path, method, body) {
  const opts = {
    method: method || 'GET',
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method || 'GET'} ${path} -> ${res.status}: ${err}`);
  }
  return res.status === 204 ? null : res.json();
}

async function supabaseRpc(fn) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`RPC ${fn} -> ${res.status}: ${err}`);
  }
}

module.exports = async function handler(req, res) {
  // Vercel injeta Authorization: Bearer <CRON_SECRET> nas chamadas agendadas
  const auth = (req.headers['authorization'] || '');
  if (CRON_SECRET && auth !== ('Bearer ' + CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Env vars ausentes' });
  }

  try {
    // 1. Lê o registro principal de app_data (coluna `value`, filtrado pela chave do app)
    const rows = await supabaseFetch(
      '/app_data?key=eq.' + encodeURIComponent(DB_KEY) + '&select=value'
    );

    if (!rows || rows.length === 0 || !rows[0].value) {
      return res.status(200).json({ ok: false, msg: 'app_data vazio — nada a salvar' });
    }

    const snapshot = rows[0].value;

    // 2. Calcula tamanho do snapshot em KB
    const snapshotStr = JSON.stringify(snapshot);
    const tamanho_kb  = Math.ceil(Buffer.byteLength(snapshotStr, 'utf8') / 1024);

    // 3. Resumo com contagens das entidades principais
    const resumo = {
      patients:  Array.isArray(snapshot.patients)  ? snapshot.patients.length  : 0,
      sales:     Array.isArray(snapshot.sales)      ? snapshot.sales.length     : 0,
      doctors:   Array.isArray(snapshot.doctors)    ? snapshot.doctors.length   : 0,
      users:     Array.isArray(snapshot.users)      ? snapshot.users.length     : 0,
      products:  Array.isArray(snapshot.products)   ? snapshot.products.length  : 0,
    };

    // 4. Grava o backup
    await supabaseFetch('/app_data_backups', 'POST', {
      snapshot,
      tamanho_kb,
      resumo,
    });

    // 5. Remove backups antigos (mantém últimos 60)
    await supabaseRpc('cleanup_old_backups');

    return res.status(200).json({
      ok:          true,
      tamanho_kb,
      resumo,
      timestamp:   new Date().toISOString(),
    });

  } catch (err) {
    console.error('[backup]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

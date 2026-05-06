// Vercel Cron Function — executa diariamente às 03:00 UTC
// Lê o snapshot atual de app_data e grava em app_data_backups
// Mantém os últimos 60 backups (≈ 2 meses) via cleanup_old_backups()

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

async function supabaseFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${err}`);
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
    throw new Error(`RPC ${fn} → ${res.status}: ${err}`);
  }
}

export default async function handler(req, res) {
  // Vercel injeta Authorization: Bearer <CRON_SECRET> nas chamadas agendadas
  const auth = req.headers['authorization'] ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Env vars ausentes' });
  }

  try {
    // 1. Lê o registro mais recente de app_data
    const rows = await supabaseFetch('/app_data?select=data&order=updated_at.desc&limit=1');
    if (!rows || rows.length === 0) {
      return res.status(200).json({ ok: false, msg: 'app_data vazio — nada a salvar' });
    }

    const snapshot = rows[0].data;

    // 2. Calcula metadados do snapshot
    const snapshotStr = JSON.stringify(snapshot);
    const tamanho_kb  = Math.ceil(Buffer.byteLength(snapshotStr, 'utf8') / 1024);

    // 3. Monta o resumo com contagens das entidades principais
    const resumo = {
      pacientes:    Array.isArray(snapshot.pacientes)    ? snapshot.pacientes.length    : 0,
      vendas:       Array.isArray(snapshot.vendas)       ? snapshot.vendas.length       : 0,
      profissionais:Array.isArray(snapshot.profissionais)? snapshot.profissionais.length: 0,
      usuarios:     Array.isArray(snapshot.usuarios)     ? snapshot.usuarios.length     : 0,
      produtos:     Array.isArray(snapshot.produtos)     ? snapshot.produtos.length     : 0,
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
      ok: true,
      tamanho_kb,
      resumo,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[backup]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

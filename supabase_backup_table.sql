-- Rodar no Supabase Dashboard → SQL Editor
-- Cria a tabela de backups automáticos diários

create table if not exists app_data_backups (
  id         bigserial    primary key,
  created_at timestamptz  not null default now(),
  snapshot   jsonb        not null,
  tamanho_kb integer,        -- tamanho aproximado do snapshot
  resumo     jsonb           -- contagens: pacientes, vendas, usuários etc.
);

-- Manter apenas os 60 backups mais recentes (≈ 2 meses)
-- Esta função é chamada pela Vercel Function após cada backup
create or replace function cleanup_old_backups()
returns void language sql security definer as $$
  delete from app_data_backups
  where id not in (
    select id from app_data_backups
    order by created_at desc
    limit 60
  );
$$;

-- Índice para listagem por data (consultas de restauração)
create index if not exists idx_backups_created_at on app_data_backups(created_at desc);

-- Habilitar RLS — apenas service_role pode ler e escrever
alter table app_data_backups enable row level security;

-- Nenhuma política pública: acesso exclusivo via service_role (Vercel Function)

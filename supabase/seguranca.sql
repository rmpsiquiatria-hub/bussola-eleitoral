-- Fecha a escrita anonima em respostas_bussola.
--
-- Hoje qualquer pessoa com a chave anon (que esta publica no HTML, como tem
-- que estar) consegue inserir respostas direto na API REST, sem abrir a
-- pagina. Nenhum captcha no navegador impede isso. O que impede e tirar a
-- permissao de INSERT do papel anon e deixar a Edge Function 'enviar-resposta'
-- como unico caminho de escrita — ela usa a service role, que nunca sai do
-- servidor.
--
-- Rode no SQL Editor do Supabase (Dashboard > SQL Editor > New query).
--
-- A ORDEM IMPORTA:
--   1. BLOCO A agora. Ele so adiciona colunas e nao muda permissao nenhuma,
--      entao e seguro rodar com a pagina no ar. Tem que vir ANTES da funcao,
--      porque a funcao grava ip_hash e consulta created_at — sem as colunas
--      ela falha.
--   2. Publique a Edge Function, configure os secrets e preencha
--      TURNSTILE_SITE_KEY e ENVIO_URL no HTML.
--   3. Responda o questionario uma vez e confirme que a contagem subiu.
--   4. So entao BLOCO B. Ele e o que corta a escrita anonima; se rodar antes
--      da funcao estar funcionando, a pagina para de registrar respostas —
--      e em silencio, porque o envio ignora erro para nao travar a tela.
--   5. BLOCO C confere o resultado.

-- ---------------------------------------------------------------------------
-- BLOCO A — colunas que a Edge Function usa
-- ---------------------------------------------------------------------------

-- guarda um hash do IP (nao o IP) so para contar repeticoes por hora
alter table public.respostas_bussola
  add column if not exists ip_hash text;

-- se a tabela ainda nao tiver carimbo de tempo, a janela de 1 hora precisa dele
alter table public.respostas_bussola
  add column if not exists created_at timestamptz not null default now();

create index if not exists respostas_bussola_ip_hash_idx
  on public.respostas_bussola (ip_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- BLOCO B — tira o INSERT de anon
-- ---------------------------------------------------------------------------

alter table public.respostas_bussola enable row level security;

-- remove qualquer policy existente que libere INSERT para anon/public,
-- sem precisar saber o nome que ela recebeu
do $$
declare p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'respostas_bussola'
      and cmd in ('INSERT', 'ALL')
      and (roles::text[] && array['anon','public'])
  loop
    execute format('drop policy %I on public.respostas_bussola', p.policyname);
    raise notice 'policy removida: %', p.policyname;
  end loop;
end $$;

-- e tira tambem o privilegio de tabela, caso tenha sido concedido direto
revoke insert, update, delete on public.respostas_bussola from anon;

-- A service role usada pela Edge Function ignora RLS por definicao, entao ela
-- continua gravando normalmente. Nada a fazer aqui.

-- ---------------------------------------------------------------------------
-- BLOCO C — conferencia
-- ---------------------------------------------------------------------------

-- deve voltar VAZIO. Se voltar alguma linha, ainda ha caminho de escrita aberto.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename  = 'respostas_bussola'
  and cmd in ('INSERT', 'ALL')
  and (roles::text[] && array['anon','public']);

-- deve mostrar apenas SELECT (ou nada) para anon
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name   = 'respostas_bussola'
  and grantee      = 'anon';

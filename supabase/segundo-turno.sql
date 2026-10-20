-- Ajustes de banco para o 2o turno (25/10/2026).
--
-- Rode no SQL Editor do Supabase:
-- https://supabase.com/dashboard/project/fqodqsnirtmvvutjlehk/sql/new

-- ---------------------------------------------------------------------------
-- BLOCO A — campo da nova pergunta (obrigatorio)
-- ---------------------------------------------------------------------------
-- Guarda o voto declarado no 1o turno: o numero de urna como texto ("13", "22"),
-- ou uma das situacoes: outro, branco, nulo, nao_votei, nao_respondeu.
-- Fica nulo nas 60 respostas antigas, que foram colhidas antes da pergunta existir.

alter table public.respostas_bussola
  add column if not exists voto_primeiro_turno text;

-- ---------------------------------------------------------------------------
-- BLOCO B — o que fazer com as respostas do 1o turno (escolha uma)
-- ---------------------------------------------------------------------------
-- O problema: a estatistica da comunidade conta todas as linhas da tabela. As 60
-- respostas antigas apontam vencedores entre nove candidatos, sete dos quais nao
-- disputam mais. Se nada for feito, a tela de resultado vai mostrar Augusto Cury,
-- Marcal e outros como se ainda estivessem na disputa, misturados aos dois do 2o
-- turno — e o total tambem fica inflado.
--
-- Opcao 1 — APAGAR as respostas do 1o turno e comecar a contagem do zero.
-- Mais simples e mais honesto: a pergunta mudou, entao as respostas antigas nao
-- sao comparaveis com as novas. ATENCAO: nao tem volta.
--
--   delete from public.respostas_bussola
--   where created_at < '2026-10-20';
--
-- Opcao 2 — PRESERVAR as antigas e contar so as novas. Exige marcar de qual turno
-- e cada linha e alterar a funcao estatisticas_bussola para filtrar por turno.
-- Da mais trabalho; peca que eu monto a alteracao da funcao.
--
--   alter table public.respostas_bussola
--     add column if not exists turno smallint not null default 2;
--   update public.respostas_bussola set turno = 1 where created_at < '2026-10-20';
--
-- Deixei as duas comentadas de proposito: apagar dado e decisao sua, nao minha.

-- ---------------------------------------------------------------------------
-- BLOCO C — conferencia
-- ---------------------------------------------------------------------------

select count(*) as total,
       count(voto_primeiro_turno) as com_voto_1t,
       min(created_at) as mais_antiga,
       max(created_at) as mais_recente
from public.respostas_bussola;

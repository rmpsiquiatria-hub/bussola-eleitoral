// Edge Function: unico caminho de escrita em respostas_bussola.
//
// Depois que o RLS bloquear INSERT para anon (ver supabase/seguranca.sql), a
// pagina nao grava mais direto na API. Toda resposta passa por aqui, e aqui
// tres coisas sao checadas antes de gravar:
//   1. o token do Cloudflare Turnstile e valido (prova de que veio de um navegador)
//   2. o payload tem o formato esperado (nada de lixo ou campo extra)
//   3. o mesmo IP nao mandou respostas demais na ultima hora
//
// Variaveis de ambiente necessarias (supabase secrets set ...):
//   TURNSTILE_SECRET_KEY   chave secreta do Turnstile (a publica fica no HTML)
//   ORIGENS_PERMITIDAS     lista separada por virgula, ex:
//                          https://bussola-eleitoral-weld.vercel.app
//   SUPABASE_URL           injetada automaticamente pelo Supabase
//   SUPABASE_SERVICE_ROLE_KEY  idem — nunca sai daqui

import { createClient } from "jsr:@supabase/supabase-js@2";

const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ORIGENS = (Deno.env.get("ORIGENS_PERMITIDAS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// quantas respostas o mesmo IP pode mandar por hora
const LIMITE_POR_HORA = 5;

const N_QUESTOES = 7;

function cabecalhosCors(origem: string | null) {
  // so devolve o header de liberacao se a origem estiver na lista
  const liberada = origem && ORIGENS.includes(origem) ? origem : "";
  return {
    "Access-Control-Allow-Origin": liberada,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function recusa(mensagem: string, status: number, origem: string | null) {
  return new Response(JSON.stringify({ erro: mensagem }), {
    status,
    headers: { ...cabecalhosCors(origem), "Content-Type": "application/json" },
  });
}

// aceita so o que a bussola realmente manda; qualquer outra coisa e descartada
function payloadValido(c: unknown): c is {
  respostas: number[];
  pesos: number[];
  vencedor_numero: number;
  vencedor_nome: string;
  vencedor_alinhamento: number;
  token: string;
} {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;

  const listaOk = (v: unknown, min: number, max: number) =>
    Array.isArray(v) &&
    v.length === N_QUESTOES &&
    v.every((n) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max);

  if (!listaOk(o.respostas, 1, 5)) return false;
  if (!listaOk(o.pesos, 1, 3)) return false;
  if (!Number.isInteger(o.vencedor_numero)) return false;
  if (typeof o.vencedor_nome !== "string" || o.vencedor_nome.length > 120) return false;
  if (
    !Number.isInteger(o.vencedor_alinhamento) ||
    (o.vencedor_alinhamento as number) < 0 ||
    (o.vencedor_alinhamento as number) > 100
  ) return false;
  if (typeof o.token !== "string" || o.token.length > 4096) return false;

  return true;
}

// hash do IP: da para contar repeticoes sem guardar o endereco em si
async function hashIp(ip: string) {
  const dados = new TextEncoder().encode(ip + "|bussola");
  const digest = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function turnstileOk(token: string, ip: string) {
  const form = new FormData();
  form.append("secret", TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form },
  );
  const j = await r.json();
  return j.success === true;
}

Deno.serve(async (req) => {
  const origem = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cabecalhosCors(origem) });
  }
  if (req.method !== "POST") {
    return recusa("metodo nao permitido", 405, origem);
  }
  if (ORIGENS.length > 0 && (!origem || !ORIGENS.includes(origem))) {
    return recusa("origem nao autorizada", 403, origem);
  }
  if (!TURNSTILE_SECRET || !SERVICE_ROLE_KEY) {
    return recusa("funcao nao configurada", 500, origem);
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return recusa("json invalido", 400, origem);
  }
  if (!payloadValido(corpo)) {
    return recusa("payload invalido", 400, origem);
  }

  const ip =
    req.headers.get("cf-connecting-ip") ??
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

  if (!(await turnstileOk(corpo.token, ip))) {
    return recusa("verificacao anti-bot falhou", 403, origem);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const ip_hash = ip ? await hashIp(ip) : null;

  if (ip_hash) {
    const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await supabase
      .from("respostas_bussola")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", umaHoraAtras);

    if ((count ?? 0) >= LIMITE_POR_HORA) {
      return recusa("limite de respostas atingido, tente mais tarde", 429, origem);
    }
  }

  const { error } = await supabase.from("respostas_bussola").insert({
    respostas: corpo.respostas,
    pesos: corpo.pesos,
    vencedor_numero: corpo.vencedor_numero,
    vencedor_nome: corpo.vencedor_nome,
    vencedor_alinhamento: corpo.vencedor_alinhamento,
    ip_hash,
  });

  if (error) {
    return recusa("falha ao gravar", 500, origem);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cabecalhosCors(origem), "Content-Type": "application/json" },
  });
});

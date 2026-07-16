/**
 * Crisol — Proxy da API da Riot (Cloudflare Worker)
 * ---------------------------------------------------
 * Isso existe porque a API da Riot bloqueia chamadas diretas do navegador (CORS)
 * e porque sua API key nunca deve ficar exposta dentro do HTML.
 *
 * COMO PUBLICAR:
 * 1. Acesse https://dash.cloudflare.com → Workers & Pages → Create → Create Worker
 * 2. Apague o código de exemplo e cole todo o conteúdo deste arquivo
 * 3. Clique em "Deploy"
 * 4. Vá em Settings → Variables and Secrets → Add → 
 *      Nome: RIOT_API_KEY   |   Valor: sua chave (RGAPI-...)   |   marque como "Secret"
 * 5. Salve. A URL do seu Worker vai ser algo como:
 *      https://SEU-WORKER.SEU-USUARIO.workers.dev
 *    É essa URL que você vai colar no Crisol (modal "🎮 Riot ID").
 *
 * Endpoint exposto: GET /sync-batch
 * Parâmetros:
 *   gameName   (obrigatório na 1ª chamada) — parte antes do # do Riot ID
 *   tagLine    (obrigatório na 1ª chamada) — parte depois do # do Riot ID
 *   puuid      (opcional — enviado pelo Crisol a partir da 2ª chamada em diante,
 *               evita repetir a consulta de conta a cada lote)
 *   continent  — americas | europe | asia | sea  (padrão: americas)
 *   start      — de onde começar a paginação de partidas (padrão: 0)
 *   count      — quantas partidas processar neste lote (padrão: 15, máx: 25)
 *
 * Cada lote processa poucas partidas de propósito: o plano gratuito do Cloudflare
 * Workers tem limite de sub-requisições e tempo de CPU por chamada. O Crisol chama
 * este endpoint várias vezes em sequência (paginando) até cobrir o histórico.
 */

const ARENA_QUEUE_ID = 1700;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/sync-batch') {
      return json({ error: 'Endpoint não encontrado. Use /sync-batch.' }, 404);
    }

    const apiKey = env.RIOT_API_KEY;
    if (!apiKey) {
      return json({ error: 'RIOT_API_KEY não configurada nas variáveis do Worker.' }, 500);
    }

    const gameName = url.searchParams.get('gameName');
    const tagLine = url.searchParams.get('tagLine');
    let puuid = url.searchParams.get('puuid');
    const continent = (url.searchParams.get('continent') || 'americas').toLowerCase();
    const start = Math.max(parseInt(url.searchParams.get('start') || '0', 10), 0);
    const count = Math.min(Math.max(parseInt(url.searchParams.get('count') || '15', 10), 1), 25);

    if (!['americas', 'europe', 'asia', 'sea'].includes(continent)) {
      return json({ error: 'Continente inválido. Use americas, europe, asia ou sea.' }, 400);
    }

    try {
      // 1) Riot ID -> PUUID (só na primeira chamada; depois o Crisol reenvia o puuid já resolvido)
      if (!puuid) {
        if (!gameName || !tagLine) {
          return json({ error: 'Informe gameName e tagLine (ou puuid).' }, 400);
        }
        const accUrl = `https://${continent}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
        const accRes = await riotFetch(accUrl, apiKey);
        if (!accRes.ok) {
          return json({ error: `Riot ID não encontrado (status ${accRes.status}). Confira o nome, a tag e o continente.` }, accRes.status === 404 ? 404 : 502);
        }
        const acc = await accRes.json();
        puuid = acc.puuid;
      }

      // 2) Página de IDs de partidas de Arena, a partir de "start"
      const idsUrl = `https://${continent}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${ARENA_QUEUE_ID}&start=${start}&count=${count}`;
      const idsRes = await riotFetch(idsUrl, apiKey);
      if (!idsRes.ok) {
        return json({ error: `Falha ao buscar partidas (status ${idsRes.status}).` }, 502);
      }
      const matchIds = await idsRes.json();

      // 3) Detalhe de cada partida do lote, verificando 1º lugar
      const wins = {}; // championName -> data ISO mais antiga encontrada
      let scanned = 0;
      for (const matchId of matchIds) {
        const matchUrl = `https://${continent}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
        const res = await riotFetch(matchUrl, apiKey);
        scanned++;
        if (!res.ok) {
          if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
            await sleep(retryAfter * 1000);
          }
          continue;
        }
        const match = await res.json();
        const participants = match && match.info && match.info.participants;
        if (!participants) continue;
        const me = participants.find(p => p.puuid === puuid);
        if (me && me.placement === 1) {
          const dateIso = new Date(match.info.gameEndTimestamp || match.info.gameCreation).toISOString().slice(0, 10);
          const champ = me.championName;
          if (!wins[champ] || wins[champ] > dateIso) wins[champ] = dateIso;
        }
      }

      const champions = Object.keys(wins).map(id => ({ id, date: wins[id] }));
      const hasMore = matchIds.length === count; // se o lote veio "cheio", pode haver mais partidas antigas

      return json({
        puuid,
        champions,
        matchesInBatch: matchIds.length,
        matchesScanned: scanned,
        nextStart: start + matchIds.length,
        hasMore
      });
    } catch (err) {
      return json({ error: 'Erro inesperado no proxy: ' + err.message }, 500);
    }
  }
};

function riotFetch(targetUrl, apiKey) {
  return fetch(targetUrl, { headers: { 'X-Riot-Token': apiKey } });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

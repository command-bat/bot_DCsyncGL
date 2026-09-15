// Confere, do lado do bot, se quem digitou um comando no GoLive é
// administrador do grupo — a mesma conta que a API faz (ver
// docs/guia/permissoes.md#checando-a-permissao-de-quem-usou-o-comando).
// A API só sabe que É O BOT fazendo a chamada (o bot tem manageWebhooks no
// grupo — senão a criação do webhook já falha com 403/404); sem esta conta
// aqui, qualquer membro comum poderia ligar a sala ao Discord usando os
// poderes do bot.

/** Só o dono do grupo ou quem tem a permissão de administrador. @param {{ group: object, memberRoles: Record<string, string[]> }} groupData a resposta de GET /groups/:id */
export function isAdmin(groupData, userId) {
  const { group, memberRoles } = groupData;
  if (group.ownerId === userId) return true;
  const held = new Set(memberRoles?.[userId] ?? []);
  const sets = [group.permissions, ...group.roles.filter((r) => held.has(r.id)).map((r) => r.permissions)];
  return sets.some((p) => p?.manage?.administrator);
}

// GET /groups/:id a cada checagem seria uma chamada por comando; um minuto de
// cache é o mesmo que o guia de permissões recomenda, e o suficiente pra um
// !golive-sync não bater na API duas vezes por engano.
const GROUP_CACHE_MS = 60_000;
const groupCache = new Map(); // groupId -> { data, expiresAt }

export async function fetchGroup(apiBase, token, groupId) {
  const cached = groupCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const res = await fetch(`${apiBase}/groups/${groupId}`, { headers: { Authorization: token } });
  if (!res.ok) return null;
  const data = await res.json();
  groupCache.set(groupId, { data, expiresAt: Date.now() + GROUP_CACHE_MS });
  return data;
}

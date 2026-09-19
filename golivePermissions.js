// Confere, do lado do bot, se quem digitou um comando no GoLive é
// administrador do grupo — a mesma conta que a API faz (ver
// docs/guia/permissoes.md#checando-a-permissao-de-quem-usou-o-comando).
// A API só sabe que É O BOT fazendo a chamada (o bot tem manageWebhooks no
// grupo — senão a criação do webhook já falha com 403/404); sem esta conta
// aqui, qualquer membro comum poderia ligar a sala ao Discord usando os
// poderes do bot.

/** Só o dono do grupo ou quem tem a permissão de administrador. @param {{ group: object, memberRoles: Record<string, string[]> }} groupData a resposta de GET /groups/:id */
export function isAdmin(groupData, userId) {
  if (!groupData || !userId) return false;
  const { group, memberRoles } = groupData;
  if (!group) return false;
  if (group.ownerId === userId) return true;
  // Se @everyone no grupo tem permissão de administrador
  if (group.permissions?.manage?.administrator) return true;
  const held = new Set(memberRoles?.[userId] ?? []);
  if (held.size === 0) return false;
  const roles = Array.isArray(group.roles) ? group.roles : [];
  return roles.some((r) => held.has(r.id) && r.permissions?.manage?.administrator);
}

// GET /groups/:id a cada checagem seria uma chamada por comando; um cache de 30 segundos
// é o suficiente para não sobrecarregar a API nem manter permissões revogadas por muito tempo.
const GROUP_CACHE_MS = 30_000;
const groupCache = new Map(); // groupId -> { data, expiresAt }

export async function fetchGroup(apiBase, token, groupId, forceRefresh = false) {
  if (!groupId) return null;
  const cached = groupCache.get(groupId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;
  try {
    const res = await fetch(`${apiBase}/groups/${groupId}`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    groupCache.set(groupId, { data, expiresAt: Date.now() + GROUP_CACHE_MS });
    return data;
  } catch (err) {
    console.error(`Erro ao buscar grupo ${groupId} no GoLive:`, err);
    return null;
  }
}

export function invalidateGroupCache(groupId) {
  groupCache.delete(groupId);
}

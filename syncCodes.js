import { randomInt } from "node:crypto";

// Códigos de sincronização: a ponte entre um comando rodado do lado do
// Discord e um rodado do lado do GoLive, sem que nenhum dos dois precise
// saber o id interno de nada do outro serviço de antemão. Um lado gera um
// código com `startSync`; a pessoa digita esse código do OUTRO lado, que
// resolve com `consumeSync` e já tem, ali, tudo que faltava (o grupo+sala do
// GoLive, ou o servidor+canal do Discord) pra completar a ligação.
//
// Só em memória — de propósito. Um código vive minutos, não faz sentido
// sobreviver a um restart, e persistir só adicionaria um arquivo pra zerar.

const CODE_TTL_MS = 10 * 60 * 1000;
// Sem 0/O/1/I: são os pares que mais se confundem lendo em voz alta ou
// copiando à mão de uma tela pra outra.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const pending = new Map(); // código -> { side, discord?, golive?, expiresAt }

function makeCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  } while (pending.has(code));
  return code;
}

function sweepExpired() {
  const now = Date.now();
  for (const [code, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(code);
  }
}
setInterval(sweepExpired, 60_000).unref?.();

/** Gera um código novo para o lado do Discord (guildId é só informativo, pra logs/depuração). */
export function startFromDiscord(guildId, channelId) {
  sweepExpired();
  const code = makeCode();
  pending.set(code, { side: "discord", discord: { guildId, channelId }, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** Gera um código novo para o lado do GoLive. */
export function startFromGolive(groupId, channelId) {
  sweepExpired();
  const code = makeCode();
  pending.set(code, { side: "golive", golive: { groupId, channelId }, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/**
 * Resolve um código digitado do lado `side` ("discord" ou "golive"). Só
 * funciona para um código gerado do lado *oposto* — completar exige as duas
 * metades — e cada código só vale uma vez: um acerto o consome, e um erro
 * (lado errado, vencido, ou não existe) nunca o desperdiça, pra não deixar
 * alguém sem uma segunda chance por ter digitado no lugar errado primeiro.
 */
export function consumeSync(code, side) {
  const normalized = code.trim().toUpperCase();
  const entry = pending.get(normalized);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pending.delete(normalized);
    return null;
  }
  if (entry.side === side) return null;
  pending.delete(normalized);
  return entry;
}

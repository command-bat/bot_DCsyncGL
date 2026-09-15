import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Every canal-do-Discord <-> sala-do-GoLive ligação deste bot, num JSON ao
// lado do script — não tem banco de dados aqui, e uma dúzia de servidores
// não precisa de um. Cada ligação é 1 canal do Discord para 1 sala do GoLive
// e vice-versa: nunca duas ligações compartilhando o mesmo canal de nenhum
// dos dois lados (ver addPair).
const FILE = fileURLToPath(new URL("./pairs.json", import.meta.url));

let pairs = [];
let byDiscordChannel = new Map();
let byGoliveChannel = new Map();

function goliveKey(groupId, channelId) {
  return `${groupId}:${channelId}`;
}

function reindex() {
  byDiscordChannel = new Map(pairs.map((p) => [p.discordChannelId, p]));
  byGoliveChannel = new Map(pairs.map((p) => [goliveKey(p.goliveGroupId, p.goliveChannelId), p]));
}

async function save() {
  await fs.writeFile(FILE, JSON.stringify(pairs, null, 2));
}

/** Carrega as ligações salvas. Chamar uma vez, antes de conectar em qualquer lado. */
export async function loadPairs() {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    pairs = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Erro lendo pairs.json:", err);
    pairs = [];
  }
  reindex();
  return pairs;
}

export function allPairs() {
  return pairs;
}

export function findByDiscordChannel(channelId) {
  return byDiscordChannel.get(channelId) ?? null;
}

export function findByGoliveChannel(groupId, channelId) {
  return byGoliveChannel.get(goliveKey(groupId, channelId)) ?? null;
}

/**
 * Nova ligação. `pair` já vem com todos os campos prontos (ver index.js) —
 * este módulo só garante o par 1-para-1 e persiste. Lança se o canal do
 * Discord ou a sala do GoLive já estiverem em outra ligação.
 */
export async function addPair(pair) {
  if (byDiscordChannel.has(pair.discordChannelId)) {
    throw new Error("Este canal do Discord já está ligado a uma sala do GoLive.");
  }
  if (byGoliveChannel.has(goliveKey(pair.goliveGroupId, pair.goliveChannelId))) {
    throw new Error("Essa sala do GoLive já está ligada a outro canal do Discord.");
  }
  pairs.push(pair);
  reindex();
  await save();
  return pair;
}

/** Remove a ligação do canal do Discord dado. Devolve a ligação removida, ou null se não havia nenhuma. */
export async function removePairByDiscordChannel(channelId) {
  const pair = byDiscordChannel.get(channelId) ?? null;
  if (!pair) return null;
  pairs = pairs.filter((p) => p.id !== pair.id);
  reindex();
  await save();
  return pair;
}

export function newPairId() {
  return randomUUID();
}

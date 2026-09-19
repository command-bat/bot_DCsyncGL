// Ponte Discord <-> GoLive, para quantos servidores quiserem usar ao mesmo
// tempo. Cada canal do Discord liga a uma sala do GoLive (e vice-versa) por
// um código de sincronização, um-para-um — ver pairs.js para onde essas
// ligações moram e addPair para a regra que impede duas ligações
// compartilharem um canal, e syncCodes.js para como o código funciona.
//
// Pra convidar este bot num servidor do Discord, o link de convite precisa
// dos escopos `bot` e `applications.commands`, e da permissão **Gerenciar
// Webhooks** (pra ele poder criar o webhook do canal quando o código for
// completado). Do lado do GoLive, a conta do bot (o token em GOLIVE_TOKEN)
// precisa ser adicionada a cada grupo que for usado, com a permissão
// "Gerenciar webhooks" nesse grupo — sem isso, o comando vai dar 403/404 e
// dizer isso mesmo.
import "dotenv/config";
import WebSocket from "ws";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  WebhookClient,
} from "discord.js";
import { addPair, allPairs, findByDiscordChannel, findByGoliveChannel, loadPairs, newPairId, removePairByDiscordChannel, removePairByGoliveChannel } from "./pairs.js";
import { consumeSync, startFromDiscord, startFromGolive } from "./syncCodes.js";
import { fetchGroup, isAdmin } from "./golivePermissions.js";

const API = "https://apigolive.nemtudo.me";
const GATEWAY = "wss://apigolive.nemtudo.me/ws";

const DISCORD_INVITE_URL = "https://discord.com/oauth2/authorize?client_id=1549460926753935482";
const GOLIVE_INVITE_URL = "https://golive.nemtudo.me/bots/b2ad8d4d-bacb-4556-bef8-496e1c00e7ab/add";
const SUPPORT_SERVER_URL = "http://discord.gg/nemtudo";

function createInviteButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Adicionar ao Discord")
      .setStyle(ButtonStyle.Link)
      .setURL(DISCORD_INVITE_URL),
    new ButtonBuilder()
      .setLabel("Adicionar ao GoLive")
      .setStyle(ButtonStyle.Link)
      .setURL(GOLIVE_INVITE_URL),
    new ButtonBuilder()
      .setLabel("Suporte (NemTudo)")
      .setStyle(ButtonStyle.Link)
      .setURL(SUPPORT_SERVER_URL)
  );
}

const GOLIVE_TOKEN = process.env.GOLIVE_TOKEN?.startsWith("Bot ")
  ? process.env.GOLIVE_TOKEN
  : `Bot ${process.env.GOLIVE_TOKEN}`;

  console.log(GOLIVE_TOKEN)

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// O id da própria conta do bot no GoLive — só sabido depois do GET /auth/me
// em main(), usado pra notar quando alguém @menciona o bot numa mensagem.
let meId = null;

// ========== Discord ==========
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Reações em mensagens que não estão (mais) no cache chegam "parciais" —
  // sem isso o discord.js simplesmente ignora o evento em vez de deixar
  // buscar a reação/mensagem completa com .fetch().
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

// Um WebhookClient por ligação, feito na primeira vez que ela é usada e
// reaproveitado depois — criar um por mensagem seria um cliente HTTP novo a
// cada linha de chat.
const discordWebhookClients = new Map();
function discordWebhookFor(pair) {
  let client = discordWebhookClients.get(pair.discordWebhookUrl);
  if (!client) {
    client = new WebhookClient({ url: pair.discordWebhookUrl });
    discordWebhookClients.set(pair.discordWebhookUrl, client);
  }
  return client;
}

// ========== Menções ==========
//
// Nenhum lado deve conseguir notificar @todos/@everyone, cargos ou uma
// pessoa específica através do outro — só o texto deve atravessar, nunca o
// poder de notificar. O webhook do GoLive já não aceita o campo `mentions`
// (não notifica ninguém por conta própria — ver docs/guia/webhooks.md), mas
// sua sintaxe de menção em texto (`<@id>`, `<#id>`) é idêntica à do Discord;
// sem tratar isso, um `<@123...>` do Discord apareceria cru ou, na pior das
// hipóteses, bateria por acaso com o id de alguém do GoLive. Do lado do
// Discord, `allowedMentions: { parse: [] }` desliga a notificação de
const NO_MENTIONS = { parse: [], users: [], roles: [], repliedUser: false };

/**
 * Sanitiza o texto do Discord antes de enviar ao GoLive.
 * Bloqueia menções de @everyone, @here, @todos, @online, @offline e menções de pessoas
 * para que NUNCA passem como menção ativa para o GoLive (usa zero-width space para manter legível).
 */
function sanitizeDiscordToGoLive(message) {
  let text = typeof message === "string" ? message : message?.content || "";

  if (typeof message === "object" && message?.mentions) {
    text = text.replace(/<@!?(\d+)>/g, (m, id) => {
      const user = message.mentions.users?.get?.(id);
      const name = user?.displayName || user?.username || "usuário";
      return `@\u200B${name}`;
    });
    text = text.replace(/<@&(\d+)>/g, (m, id) => {
      const role = message.mentions.roles?.get?.(id);
      const name = role?.name || "cargo";
      return `@\u200B${name}`;
    });
    text = text.replace(/<#(\d+)>/g, (m, id) => {
      const channel = message.mentions.channels?.get?.(id);
      const name = channel?.name || "canal";
      return `#\u200B${name}`;
    });
  } else {
    text = text.replace(/<@!?(\d+)>/g, "@\u200Busuário");
    text = text.replace(/<@&(\d+)>/g, "@\u200Bcargo");
    text = text.replace(/<#(\d+)>/g, "#\u200Bcanal");
  }

  // Neutraliza menções de broadcast (@everyone, @here, @todos, @online, @offline)
  text = text.replace(/@(everyone|here|todos|online|offline)/gi, "@\u200B$1");

  // Neutraliza qualquer menção a pessoas (@nome), inserindo zero-width space após o @
  text = text.replace(/@(?!\u200B)([\p{L}\p{N}_])/gu, "@\u200B$1");

  return text;
}

/**
 * Sanitiza o texto vindo do GoLive antes de enviar ao Discord.
 * Bloqueia menções de @everyone, @here, @todos, @online, @offline, tokens <@id>
 * e menções a pessoas (@nome) para que NUNCA notifiquem ninguém no Discord.
 */
function sanitizeGoLiveToDiscord(text) {
  if (!text || typeof text !== "string") return "";
  let clean = text;

  // Neutraliza tokens de menção <@id>, <@!id>, <@&id>, <#id>
  clean = clean.replace(/<@!?([a-zA-Z0-9_-]+)>/g, "@\u200Busuário");
  clean = clean.replace(/<@&([a-zA-Z0-9_-]+)>/g, "@\u200Bcargo");
  clean = clean.replace(/<#([a-zA-Z0-9_-]+)>/g, "#\u200Bcanal");

  // Neutraliza menções de broadcast
  clean = clean.replace(/@(everyone|here|todos|online|offline)/gi, "@\u200B$1");

  // Neutraliza qualquer menção a pessoas (@nome), inserindo zero-width space após o @
  clean = clean.replace(/@(?!\u200B)([\p{L}\p{N}_])/gu, "@\u200B$1");

  return clean;
}

// ========== Ligação entre mensagens (para as reações) ==========
//
// Pra espelhar uma reação, o bot precisa saber a que mensagem do OUTRO lado
// aquela mensagem corresponde. Guardado só em memória (reinicia zerado, como
// o resto do estado ao vivo deste bot) e limitado a um teto — como o guia de
// reações sugere para o próprio estado de reações, aqui é o mesmo motivo:
// sem limite, a memória cresceria pra sempre.
const MAX_LINKED_MESSAGES = 10000;
const linkedByDiscordId = new Map(); // discordMessageId -> link
const linkedByGoliveId = new Map(); // "groupId:channelId:messageId" -> link
const linkOrder = [];

function goliveMessageKey(groupId, channelId, messageId) {
  return `${groupId}:${channelId}:${messageId}`;
}

function linkMessages({ discordMessageId, discordChannelId, goliveGroupId, goliveChannelId, goliveMessageId }) {
  const link = { discordMessageId, discordChannelId, goliveGroupId, goliveChannelId, goliveMessageId };
  linkedByDiscordId.set(discordMessageId, link);
  linkedByGoliveId.set(goliveMessageKey(goliveGroupId, goliveChannelId, goliveMessageId), link);
  linkOrder.push(link);
  if (linkOrder.length > MAX_LINKED_MESSAGES) {
    const old = linkOrder.shift();
    linkedByDiscordId.delete(old.discordMessageId);
    linkedByGoliveId.delete(goliveMessageKey(old.goliveGroupId, old.goliveChannelId, old.goliveMessageId));
  }
}

function unlinkMessages(link) {
  if (!link) return;
  linkedByDiscordId.delete(link.discordMessageId);
  linkedByGoliveId.delete(goliveMessageKey(link.goliveGroupId, link.goliveChannelId, link.goliveMessageId));
}

// ========== GoLive → Discord ==========
// `images` e `attachments` já são URLs públicas (o CDN do GoLive) — o
// discord.js busca uma URL sozinho quando `attachment` é uma string http(s),
// então não precisa baixar o arquivo aqui para depois subir de novo.
async function sendToDiscord(pair, author, text, images = [], attachments = [], goliveMessageId = null, extra = {}) {
  try {
    const cleanText = sanitizeGoLiveToDiscord(typeof text === "string" ? text : "");
    const cleanImages = Array.isArray(images) ? images : [];
    const cleanAttachments = Array.isArray(attachments) ? attachments : [];

    const files = [
      ...cleanImages.map((url) => ({ attachment: url })),
      ...cleanAttachments.map((a) => ({ attachment: a.url, name: a.name })),
    ];

    if (extra.gifUrl) {
      files.push({ attachment: extra.gifUrl });
    }

    if (!cleanText.trim() && files.length === 0) return;

    let content = cleanText ? cleanText.slice(0, 2000) : undefined;
    if (extra.replyTo?.name && extra.replyTo?.text) {
      const quoteAuthor = sanitizeGoLiveToDiscord(extra.replyTo.name);
      const quoteText = sanitizeGoLiveToDiscord(String(extra.replyTo.text).slice(0, 100).replace(/\n/g, " "));
      const quote = `> 💬 **${quoteAuthor}**: ${quoteText}\n`;
      content = quote + (content || "");
      if (content.length > 2000) content = content.slice(0, 2000);
    }

    const client = discordWebhookFor(pair);
    const authorName = sanitizeGoLiveToDiscord(author?.name || author?.username || "Usuário GoLive").slice(0, 80);
    const sent = await client.send({
      content: content || undefined,
      username: authorName,
      avatarURL: author?.avatarUrl || undefined,
      allowedMentions: NO_MENTIONS, // desliga completamente qualquer menção/ping
      ...(files.length > 0 ? { files } : {}),
    });

    if (goliveMessageId && sent?.id) {
      linkMessages({
        discordMessageId: sent.id,
        discordChannelId: pair.discordChannelId,
        goliveGroupId: pair.goliveGroupId,
        goliveChannelId: pair.goliveChannelId,
        goliveMessageId,
      });
    }
  } catch (err) {
    console.error("Erro enviando mensagem pro Discord:", err);
  }
}

// GoLive não aceita avatar_url por mensagem — a foto é sempre a foto atual do
// webhook. Ele aceita, sim, PATCH /webhooks/:id/:token para trocar essa foto
// (ver docs/guia/webhooks.md), então antes de cada mensagem a foto do webhook
// é atualizada para a do autor do Discord, se ainda não estiver assim.
//
// Duas coisas ficam em cache, nenhuma delas persistida (reinicia zerado, o
// que só custa alguns PATCHs extras logo no começo):
// - `currentAvatarByPair`: a última foto sincronizada de cada ligação, pra
//   não repetir o PATCH se o mesmo autor postar de novo em seguida.
// - `goliveAvatarByDiscordAvatar`: pra cada foto do Discord já subida, a URL
//   que o GoLive devolveu. Sem isso, toda vez que o webhook volta pra alguém
//   que já postou antes (A fala, B fala, A fala de novo) a mesma imagem seria
//   baixada do Discord e subida pro GoLive de novo, como um arquivo novo —
//   com isso, a segunda vez em diante manda essa URL de volta pro PATCH
//   (aceito como está, sem upload nenhum — ver docs/guia/webhooks.md) em vez
//   de repetir o download e o upload. Compartilhado entre ligações: a mesma
//   pessoa do Discord pode estar em vários servidores ligados a salas
//   diferentes, e a foto dela é a mesma em todas.
const currentAvatarByPair = new Map();
const goliveAvatarByDiscordAvatar = new Map();

async function syncGoLiveWebhookAvatar(pair, discordAvatarUrl) {
  if (!discordAvatarUrl || currentAvatarByPair.get(pair.id) === discordAvatarUrl) return;
  try {
    let avatar = goliveAvatarByDiscordAvatar.get(discordAvatarUrl);
    if (!avatar) {
      const imgRes = await fetch(discordAvatarUrl, { signal: AbortSignal.timeout(5000) });
      if (!imgRes.ok) return;
      const contentType = imgRes.headers.get("content-type") || "image/png";
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      avatar = `data:${contentType};base64,${buffer.toString("base64")}`;
    }

    const res = await fetch(pair.goliveWebhookUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error("Falha ao trocar a foto do webhook GoLive:", res.status, await res.text().catch(() => ""));
      return;
    }
    const { avatar: goliveAvatarUrl } = await res.json().catch(() => ({}));
    if (goliveAvatarUrl) goliveAvatarByDiscordAvatar.set(discordAvatarUrl, goliveAvatarUrl);
    currentAvatarByPair.set(pair.id, discordAvatarUrl);
  } catch (err) {
    console.error("Erro ao sincronizar a foto do webhook GoLive:", err);
  }
}

// O webhook do GoLive recebe fotos como `images` (data URL) e outros
// arquivos como `files: [{ name, data }]` (data URL também) — ver
// docs/guia/webhooks.md. Ele não tem um "buscar essa URL" como o discord.js
// tem para mandar pro Discord, então o anexo do Discord é baixado aqui e
// convertido para data URL antes do POST.
const GOLIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const GOLIVE_MAX_IMAGES = 3;
const GOLIVE_MAX_FILES = 5;
const GOLIVE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const GOLIVE_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function toDataUrl(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { contentType, dataUrl: `data:${contentType};base64,${buffer.toString("base64")}` };
  } catch (err) {
    console.warn(`Falha baixando anexo ${url}:`, err.message);
    return null;
  }
}

/** Separa os anexos de uma mensagem do Discord em fotos e arquivos pro GoLive, descartando o que passa dos limites do webhook. */
async function convertDiscordAttachments(discordAttachments) {
  const images = [];
  const files = [];
  for (const att of discordAttachments) {
    const isImage = GOLIVE_IMAGE_TYPES.has((att.contentType || "").split(";")[0]);
    const maxBytes = isImage ? GOLIVE_IMAGE_MAX_BYTES : GOLIVE_FILE_MAX_BYTES;
    if (att.size > maxBytes) {
      console.warn(`Anexo do Discord "${att.name}" ignorado: maior que ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      continue;
    }
    if (isImage && images.length >= GOLIVE_MAX_IMAGES) continue;
    if (!isImage && files.length >= GOLIVE_MAX_FILES) continue;

    const resolved = await toDataUrl(att.url);
    if (!resolved) {
      console.warn(`Não foi possível baixar o anexo do Discord "${att.name}".`);
      continue;
    }
    if (isImage) images.push(resolved.dataUrl);
    else files.push({ name: att.name, data: resolved.dataUrl });
  }
  return { images, files };
}

// ========== Discord → GoLive ==========
async function sendToGoLive(pair, message) {
  try {
    const text = sanitizeDiscordToGoLive(message);
    const discordAttachments = [...message.attachments.values()];
    const stickers = message.stickers ? [...message.stickers.values()] : [];

    // Se a mensagem for resposta a outra no Discord, monta citação amigável sanitizada
    let replyQuote = "";
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (refMsg) {
          const refAuthor = sanitizeDiscordToGoLive(refMsg.author?.displayName || refMsg.author?.username || "Usuário");
          let refText = sanitizeDiscordToGoLive((refMsg.content || "").slice(0, 100).replace(/\r?\n/g, " "));
          if (!refText && refMsg.attachments?.size > 0) refText = "[Anexo]";
          else if (!refText && refMsg.stickers?.size > 0) refText = "[Figurinha]";
          if (refText) {
            replyQuote = `> 💬 **${refAuthor}**: ${refText}\n`;
          }
        }
      } catch {}
    }

    if (!text?.trim() && discordAttachments.length === 0 && stickers.length === 0 && !replyQuote) return;

    const author = message.author;
    await syncGoLiveWebhookAvatar(pair, author.displayAvatarURL?.({ size: 128, extension: "png" }));
    const { images, files } = await convertDiscordAttachments(discordAttachments);

    // Converte figurinhas (stickers) do Discord para imagens no GoLive
    for (const sticker of stickers) {
      if (images.length >= GOLIVE_MAX_IMAGES) break;
      if (sticker.url) {
        const resolved = await toDataUrl(sticker.url);
        if (resolved) images.push(resolved.dataUrl);
      }
    }

    let fullContent = (replyQuote + (text || "")).slice(0, 2000);

    // ?wait=true devolve a mensagem criada (com o id) — sem isso não dá pra
    // ligar essa mensagem à sua correspondente no Discord para as reações/edições/exclusões.
    // Só o username é dinâmico por mensagem; a foto agora acompanha o autor via
    // syncGoLiveWebhookAvatar acima.
    const res = await fetch(`${pair.goliveWebhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: fullContent,
        username: sanitizeDiscordToGoLive(author.displayName || author.username || "Usuário Discord").slice(0, 80),
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`GoLive webhook retornou status ${res.status}`);
      return;
    }

    const sent = await res.json().catch(() => null);
    if (sent?.id) {
      linkMessages({
        discordMessageId: message.id,
        discordChannelId: pair.discordChannelId,
        goliveGroupId: pair.goliveGroupId,
        goliveChannelId: pair.goliveChannelId,
        goliveMessageId: sent.id,
      });
    }
  } catch (err) {
    console.error("Erro enviando mensagem pro GoLive:", err);
  }
}

// ========== Ligar/desligar canais (código de sincronização) ==========
//
// Ninguém precisa saber o id de nada do outro lado. Rode o comando de um
// lado sem código pra gerar um; digite esse código no OUTRO lado e o bot
// resolve o resto sozinho — cria os dois webhooks (um no Discord, com a
// permissão que quem gerou/completou já tem lá; um no GoLive, com a
// permissão "Gerenciar webhooks" que a conta do bot precisa ter naquele
// grupo) e guarda a ligação. Funciona igual começando por qualquer lado:
//
//   Discord: /golive-sync                  → gera o código
//            /golive-sync codigo:ABC123     → completa com um código do GoLive
//   GoLive:  !golive-sync                   → gera o código
//            !golive-sync ABC123            → completa com um código do Discord
// Todos os comandos exigem administrador — setDefaultMemberPermissions só
// controla o que aparece pra quem no Discord (um admin do servidor pode
// liberar o comando pra mais gente nas configurações de Integrações), então
// cada handler confere de novo com requireAdmin() abaixo antes de fazer
// qualquer coisa.
const commands = [
  new SlashCommandBuilder()
    .setName("golive-sync")
    .setDescription("Liga este canal a uma sala do GoLive por código (ou gera um código, sem argumento)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName("codigo").setDescription("Código gerado com !golive-sync numa sala do GoLive").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("golive-unlink")
    .setDescription("Desliga este canal da sala do GoLive a que ele está ligado")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("golive-status")
    .setDescription("Mostra a ligação deste canal com o GoLive, se houver")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("golive-invite")
    .setDescription("Mostra os links para adicionar o bot no Discord e no GoLive"),
  new SlashCommandBuilder()
    .setName("golive-help")
    .setDescription("Mostra como sincronizar canais e usar os comandos do bot"),
];

/** Confere de novo, no servidor, que quem chamou o comando é administrador — não dá pra confiar só no setDefaultMemberPermissions (é editável pelos admins do servidor). Responde com um erro e retorna false se não for. */
async function requireAdmin(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "🚫 Este comando só pode ser usado dentro de um servidor.", ephemeral: true }).catch(() => {});
    return false;
  }
  const isOwner = interaction.guild?.ownerId === interaction.user.id;
  const hasAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (isOwner || hasAdmin) return true;
  await interaction.reply({ content: "🚫 Só administradores do servidor podem usar este comando.", ephemeral: true }).catch(() => {});
  return false;
}

const SYNC_CODE_HELP = "Gere um novo código com `/golive-sync` (Discord, sem código) ou `!golive-sync` (GoLive, sem código) do lado oposto ao que você está completando.";

/** O `id` de um webhook do GoLive, extraído do seu próprio endereço (/webhooks/<id>/<token>). */
function goliveWebhookIdFrom(webhookUrl) {
  if (!webhookUrl) return null;
  const match = /\/webhooks\/([a-zA-Z0-9_-]+)/.exec(webhookUrl);
  return match ? match[1] : null;
}

async function deleteGoliveWebhook(groupId, webhookUrl) {
  const id = goliveWebhookIdFrom(webhookUrl);
  if (!id || !groupId) return;
  await fetch(`${API}/groups/${groupId}/webhooks/${id}`, {
    method: "DELETE",
    headers: { Authorization: GOLIVE_TOKEN },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/**
 * A parte que os dois lados do código de sincronização terminam em: cria o
 * webhook do GoLive, cria o webhook do Discord (buscando o canal direto pelo
 * client — funciona tanto vindo de uma interação do Discord quanto de uma
 * mensagem do GoLive) e guarda a ligação. `{ ok: true }` ou
 * `{ ok: false, message }`, pra quem chamou decidir como avisar.
 */
async function completeSync({ discordGuildId, discordChannelId, goliveGroupId, goliveChannelId, createdBy }) {
  if (findByDiscordChannel(discordChannelId)) {
    return { ok: false, message: "Este canal do Discord já está ligado a uma sala do GoLive." };
  }
  if (findByGoliveChannel(goliveGroupId, goliveChannelId)) {
    return { ok: false, message: "Essa sala do GoLive já está ligada a outro canal do Discord." };
  }

  let goliveWebhook;
  try {
    const res = await fetch(`${API}/groups/${goliveGroupId}/channels/${goliveChannelId}/webhooks`, {
      method: "POST",
      headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Discord" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          message: "Não encontrei essa sala do GoLive, ou a conta do bot não está mais nesse grupo.",
        };
      }
      if (res.status === 403) {
        return {
          ok: false,
          message: "A conta do bot está no grupo, mas sem a permissão **Gerenciar webhooks**. Peça pra alguém do grupo dar essa permissão a ela.",
        };
      }
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: `Não consegui criar o webhook no GoLive (${res.status}): ${body.error ?? "erro desconhecido"}` };
    }
    ({ webhook: goliveWebhook } = await res.json());
  } catch (err) {
    console.error("Erro criando webhook no GoLive:", err);
    return { ok: false, message: "Não consegui falar com o GoLive agora. Tente de novo em um instante." };
  }

  const goliveWebhookUrl = `${API}/webhooks/${goliveWebhook.id}/${goliveWebhook.token}`;

  let discordWebhook;
  try {
    const channel = await discord.channels.fetch(discordChannelId);
    if (!channel || !channel.isTextBased() || channel.isThread?.() || channel.isDMBased?.()) {
      await deleteGoliveWebhook(goliveGroupId, goliveWebhookUrl);
      return {
        ok: false,
        message: "O canal do Discord deve ser um canal de texto padrão do servidor (não pode ser tópico/thread, voz ou DM).",
      };
    }
    discordWebhook = await channel.createWebhook({ name: "GoLive Sync" });
  } catch (err) {
    console.error("Erro criando webhook no Discord:", err);
    // Desfaz o webhook do GoLive já criado, pra não deixar lixo se o do
    // Discord não sair.
    await deleteGoliveWebhook(goliveGroupId, goliveWebhookUrl);
    return {
      ok: false,
      message: "Não consegui criar o webhook naquele canal do Discord. Confira se o bot ainda está no servidor e tem a permissão **Gerenciar webhooks** lá.",
    };
  }

  const pair = {
    id: newPairId(),
    discordGuildId,
    discordChannelId,
    discordWebhookUrl: discordWebhook.url,
    goliveGroupId,
    goliveChannelId,
    goliveWebhookUrl,
    createdBy,
    createdAt: Date.now(),
  };
  try {
    await addPair(pair);
  } catch (err) {
    // Outra sincronização pro mesmo canal ou sala venceu a corrida entre o
    // início deste comando e agora — desfaz os dois webhooks já criados.
    await deleteGoliveWebhook(goliveGroupId, goliveWebhookUrl);
    await discordWebhookFor(pair).delete("Ligação duplicada").catch(() => {});
    return { ok: false, message: err.message };
  }

  // Anuncia a conexão no Discord
  try {
    const client = discordWebhookFor(pair);
    await client.send({
      username: "GoLive Sync",
      content: "🔗 **Conexão estabelecida!** As mensagens enviadas neste canal agora são sincronizadas em tempo real com o GoLive.\n*(Bot em Beta Teste • Suporte: <http://discord.gg/nemtudo>)*",
      allowedMentions: NO_MENTIONS,
    }).catch(() => {});
  } catch {}

  // Anuncia a conexão no GoLive
  try {
    await fetch(pair.goliveWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "GoLive Sync",
        content: "🔗 **Conexão estabelecida!** As mensagens enviadas nesta sala agora são sincronizadas em tempo real com o Discord.\n*(Bot em Beta Teste • Suporte: http://discord.gg/nemtudo)*",
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  } catch {}

  return { ok: true, pair };
}

const SYNC_DONE_MESSAGE = "✅ Ligado! As mensagens (e fotos e arquivos) agora vão e voltam entre o Discord e o GoLive.";

// ========== Tutorial (ao ser mencionado) ==========
//
// @mencionar o bot num canal do Discord ou numa sala do GoLive responde com
// isto — pra quem esbarra nele sem ter lido nenhuma documentação.
// ========== Painel de Ajuda em Embed ==========
function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🌐 Sincronização Discord ↔ GoLive")
    .setDescription(
      "Ponte em tempo real entre canais de texto do Discord e salas do GoLive. Mensagens, fotos, figurinhas, arquivos, respostas, edições e reações são espelhadas automaticamente!"
    )
    .addFields(
      {
        name: "🚀 Como Vincular",
        value:
          "**1.** No Discord, use `/golive-sync` (sem nada) para gerar um código de 6 caracteres.\n" +
          "**2.** Na sala desejada do GoLive, digite `!golive-sync <código>`.\n\n" +
          "*(Também funciona no sentido oposto: gere com `!golive-sync` no GoLive e use `/golive-sync codigo:<código>` no Discord!)*",
      },
      {
        name: "📜 Comandos no Discord",
        value:
          "• `/golive-sync` — Gera código ou vincula canal\n" +
          "• `/golive-unlink` — Desconecta o canal atual\n" +
          "• `/golive-status` — Exibe a sala vinculada a este canal\n" +
          "• `/golive-invite` — Links para adicionar o bot\n" +
          "• `/golive-help` — Exibe este painel de ajuda",
        inline: true,
      },
      {
        name: "💬 Comandos no GoLive",
        value:
          "• `!golive-sync [código]` — Gera código ou vincula sala\n" +
          "• `!golive-unlink` — Desconecta a sala atual\n" +
          "• `!golive-status` — Exibe o canal vinculado a esta sala\n" +
          "• `!golive-invite` — Links para adicionar o bot\n" +
          "• `!golive-help` — Exibe este painel de ajuda",
        inline: true,
      },
      {
        name: "🔒 Permissões & Segurança",
        value:
          "• **Discord:** O bot precisa da permissão **Gerenciar Webhooks** no canal.\n" +
          "• **GoLive:** A conta do bot precisa da permissão **Gerenciar webhooks** no grupo.\n" +
          "• Apenas administradores podem vincular ou desvincular canais.",
      },
      {
        name: "🔗 Links Úteis",
        value: `• [Adicionar ao Discord](${DISCORD_INVITE_URL})\n• [Adicionar ao GoLive](${GOLIVE_INVITE_URL})`,
      },
      {
        name: "🧪 Versão Beta & Suporte",
        value:
          "Este bot está atualmente em **Beta Teste**.\n" +
          "Caso precise de ajuda ou queira relatar algum problema, entre em contato abrindo um ticket no servidor oficial do **NemTudo** no Discord:\n" +
          `👉 [discord.gg/nemtudo](${SUPPORT_SERVER_URL})`,
      }
    )
    .setFooter({ text: "Ponte Discord ↔ GoLive (Beta) • Suporte: discord.gg/nemtudo" })
    .setTimestamp();
}

async function handleHelp(interaction) {
  await interaction.reply({
    embeds: [createHelpEmbed()],
    components: [createInviteButtons()],
    ephemeral: true,
  });
}

async function handleInvite(interaction) {
  const content = [
    "🤖 **Links para adicionar o bot:**",
    "",
    `• **Discord:** [Clique para adicionar ao Discord](${DISCORD_INVITE_URL})`,
    `• **GoLive:** [Clique para adicionar ao GoLive](${GOLIVE_INVITE_URL})`,
    "",
    "🧪 **Aviso de Beta Teste:**",
    "O bot está em fase de testes. Caso precise de suporte ou queira reportar problemas, abra um ticket no servidor oficial do NemTudo no Discord:",
    `• **Suporte:** [discord.gg/nemtudo](${SUPPORT_SERVER_URL})`,
  ].join("\n");

  await interaction.reply({
    content,
    components: [createInviteButtons()],
    ephemeral: true,
  });
}

async function handleSync(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (findByDiscordChannel(interaction.channelId)) {
    return interaction.editReply("Este canal já está ligado a uma sala do GoLive. Use `/golive-unlink` primeiro.");
  }

  const code = interaction.options.getString("codigo")?.trim();
  if (!code) {
    const generated = startFromDiscord(interaction.guildId, interaction.channelId);
    return interaction.editReply(
      `Gerei o código **${generated}**, válido por 10 minutos.\n\nAgora, na sala do GoLive que você quer ligar a este canal, digite:\n\`!golive-sync ${generated}\``
    );
  }

  const entry = consumeSync(code, "discord");
  if (!entry) {
    return interaction.editReply(`Código inválido, vencido ou já usado. ${SYNC_CODE_HELP}`);
  }

  const result = await completeSync({
    discordGuildId: interaction.guildId,
    discordChannelId: interaction.channelId,
    goliveGroupId: entry.golive.groupId,
    goliveChannelId: entry.golive.channelId,
    createdBy: interaction.user.id,
  });
  await interaction.editReply(result.ok ? SYNC_DONE_MESSAGE : result.message);
}

async function handleUnlink(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const pair = await removePairByDiscordChannel(interaction.channelId);
  if (!pair) return interaction.editReply("Este canal não está ligado a nenhuma sala do GoLive.");

  // Avisa em ambos os canais antes de deletar os webhooks
  try {
    const discordClient = discordWebhookFor(pair);
    await discordClient.send({
      username: "GoLive Sync",
      content: "🔌 **Sincronização encerrada.** As mensagens deste canal não serão mais espelhadas no GoLive.",
      allowedMentions: NO_MENTIONS,
    }).catch(() => {});
  } catch {}

  try {
    await fetch(pair.goliveWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "GoLive Sync",
        content: "🔌 **Sincronização encerrada.** As mensagens desta sala não serão mais espelhadas no Discord.",
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {}

  currentAvatarByPair.delete(pair.id);
  await deleteGoliveWebhook(pair.goliveGroupId, pair.goliveWebhookUrl);
  const discordClient = discordWebhookClients.get(pair.discordWebhookUrl);
  discordWebhookClients.delete(pair.discordWebhookUrl);
  await (discordClient ?? new WebhookClient({ url: pair.discordWebhookUrl }))
    .delete("Desligado do GoLive")
    .catch(() => {});

  await interaction.editReply("Canal desligado do GoLive.");
}

async function handleStatus(interaction) {
  const pair = findByDiscordChannel(interaction.channelId);
  if (!pair) {
    return interaction.reply({ content: "Este canal não está ligado a nenhuma sala do GoLive.", ephemeral: true });
  }
  const since = Math.floor(pair.createdAt / 1000);
  await interaction.reply({
    content: `Ligado à sala \`${pair.goliveChannelId}\` do grupo \`${pair.goliveGroupId}\` desde <t:${since}:R>.`,
    ephemeral: true,
  });
}

// ========== Cliente Discord ==========
discord.on("ready", async () => {
  console.log(`Discord conectado como ${discord.user.tag}`);
  try {
    await discord.application.commands.set(commands.map((c) => c.toJSON()));
  } catch (err) {
    console.error("Erro registrando os comandos:", err);
  }
});

discord.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "golive-invite") {
      await handleInvite(interaction);
      return;
    }
    if (interaction.commandName === "golive-help") {
      await handleHelp(interaction);
      return;
    }
    if (!(await requireAdmin(interaction))) return;
    if (interaction.commandName === "golive-sync") await handleSync(interaction);
    else if (interaction.commandName === "golive-unlink") await handleUnlink(interaction);
    else if (interaction.commandName === "golive-status") await handleStatus(interaction);
  } catch (err) {
    console.error(`Erro no comando /${interaction.commandName}:`, err);
    const reply = { content: "Deu um erro inesperado. Tente de novo.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.webhookId) return; // evita loop de webhooks

  // Apenas responde a ajuda se o bot for DIRETAMENTE mencionado no texto (não @everyone, não @here, não cargo e não reply automático)
  const isDirectBotMention =
    discord.user &&
    message.mentions.has(discord.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true }) &&
    (message.content.includes(`<@${discord.user.id}>`) || message.content.includes(`<@!${discord.user.id}>`));

  if (isDirectBotMention) {
    return void message
      .reply({
        embeds: [createHelpEmbed()],
        allowedMentions: NO_MENTIONS,
        components: [createInviteButtons()],
      })
      .catch(() => {});
  }

  const pair = findByDiscordChannel(message.channelId);
  if (!pair) return; // canal não ligado a nenhuma sala do GoLive
  const hasStickers = message.stickers && message.stickers.size > 0;
  if (!message.content && message.attachments.size === 0 && !hasStickers) return;

  await sendToGoLive(pair, message).catch((err) => console.error("Erro em sendToGoLive:", err));
});

discord.on("messageUpdate", async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      try {
        await newMessage.fetch();
      } catch {
        return;
      }
    }
    if (newMessage.author?.bot || newMessage.webhookId) return;

    // Se o conteúdo textual não mudou (ex: apenas unfurl de embeds pelo Discord), ignora
    if (oldMessage.content === newMessage.content) return;

    const link = linkedByDiscordId.get(newMessage.id);
    if (!link) return;

    const text = sanitizeDiscordToGoLive(newMessage);
    await fetch(`${API}/groups/${link.goliveGroupId}/channels/${link.goliveChannelId}/messages/${link.goliveMessageId}`, {
      method: "PATCH",
      headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    }).catch((err) => console.error("Erro sincronizando edição pro GoLive:", err));
  } catch (err) {
    console.error("Erro em messageUpdate Discord:", err);
  }
});

discord.on("messageDelete", async (message) => {
  try {
    const link = linkedByDiscordId.get(message.id);
    if (!link) return;

    unlinkMessages(link);

    await fetch(`${API}/groups/${link.goliveGroupId}/channels/${link.goliveChannelId}/messages/${link.goliveMessageId}`, {
      method: "DELETE",
      headers: { Authorization: GOLIVE_TOKEN },
      signal: AbortSignal.timeout(10000),
    }).catch((err) => console.error("Erro sincronizando exclusão pro GoLive:", err));
  } catch (err) {
    console.error("Erro em messageDelete Discord:", err);
  }
});

// ========== Reações (Discord → GoLive) ==========
//
// O bot só pode mexer na própria reação em cada lado (ver docs/guia/reacoes.md),
// então "espelhar" é: enquanto pelo menos uma pessoa de verdade tiver aquele
// emoji na mensagem original, a conta do bot mantém o mesmo emoji na mensagem
// ligada do outro lado; quando a última pessoa tira o dela, o bot tira o seu.
async function handleDiscordReactionChange(reaction, user, isRemove = false) {
  if (user.bot) return;
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        // Se a reação foi toda removida antes do fetch, ignoramos erro do fetch
      }
    }
  } catch {
    return;
  }
  if (reaction.emoji?.id) return; // emoji personalizado — o GoLive só aceita unicode

  const link = linkedByDiscordId.get(reaction.message.id);
  if (!link) return;

  const count = reaction.count ?? 0;
  const hasReal = isRemove ? count > 0 : count - (reaction.me ? 1 : 0) > 0;
  try {
    await fetch(
      `${API}/groups/${link.goliveGroupId}/channels/${link.goliveChannelId}/messages/${link.goliveMessageId}/reactions`,
      {
        method: "POST",
        headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: reaction.emoji.name, on: hasReal }),
        signal: AbortSignal.timeout(5000),
      }
    );
  } catch (err) {
    console.error("Erro espelhando reação no GoLive:", err);
  }
}

discord.on("messageReactionAdd", (reaction, user) => handleDiscordReactionChange(reaction, user, false));
discord.on("messageReactionRemove", (reaction, user) => handleDiscordReactionChange(reaction, user, true));

// ========== Comandos do lado do GoLive (!golive-*) ==========
//
// O GoLive não tem comandos de barra — um bot lê o texto das mensagens e
// decide (ver docs/guia/comandos.md). `!golive-sync` é o espelho do
// /golive-sync do Discord: sem argumento gera um código, com um código
// completa uma sincronização começada do lado do Discord.
// `!golive-unlink` e `!golive-status` dão autonomia aos admins do GoLive.
const GOLIVE_SYNC_PREFIX = "!golive-sync";

/** Responde na mesma sala, citando o comando — sem notificar (é uma resposta automática). */
async function goliveReply(message, text, extra = {}) {
  await fetch(`${API}/groups/${message.groupId}/channels/${message.channelId}/messages`, {
    method: "POST",
    headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: typeof text === "string" ? text : "",
      replyTo: { id: message.id, name: message.fromName, text: (message.text || "").slice(0, 200), kind: message.kind },
      ...(extra.embeds ? { embeds: extra.embeds } : {}),
    }),
    signal: AbortSignal.timeout(10000),
  }).catch((err) => console.error("Erro respondendo no GoLive:", err));
}

async function handleGoliveSyncCommand(message, author, text) {
  if (findByGoliveChannel(message.groupId, message.channelId)) {
    return goliveReply(message, "Esta sala já está ligada a um canal do Discord. Desligue com `!golive-unlink` aqui ou `/golive-unlink` no Discord primeiro.");
  }

  const groupData = await fetchGroup(API, GOLIVE_TOKEN, message.groupId);
  if (!groupData || !isAdmin(groupData, author.id)) {
    return goliveReply(message, "🚫 Você precisa ser **administrador** deste grupo pra ligar esta sala ao Discord.");
  }

  const raw = typeof text === "string" ? text : message.text || "";
  const code = raw.trim().slice(GOLIVE_SYNC_PREFIX.length).trim();
  if (!code) {
    const generated = startFromGolive(message.groupId, message.channelId);
    return goliveReply(
      message,
      `Gerei o código **${generated}**, válido por 10 minutos.\n\nAgora, no canal do Discord que você quer ligar aqui, rode:\n\`/golive-sync codigo:${generated}\``
    );
  }

  const entry = consumeSync(code, "golive");
  if (!entry) {
    return goliveReply(message, `Código inválido, vencido ou já usado. ${SYNC_CODE_HELP}`);
  }

  const result = await completeSync({
    discordGuildId: entry.discord.guildId,
    discordChannelId: entry.discord.channelId,
    goliveGroupId: message.groupId,
    goliveChannelId: message.channelId,
    createdBy: author.id,
  });
  await goliveReply(message, result.ok ? SYNC_DONE_MESSAGE : `❌ ${result.message}`);
}

async function handleGoliveUnlinkCommand(message, author) {
  const groupData = await fetchGroup(API, GOLIVE_TOKEN, message.groupId);
  if (!groupData || !isAdmin(groupData, author.id)) {
    return goliveReply(message, "🚫 Você precisa ser **administrador** deste grupo pra desvincular esta sala do Discord.");
  }

  const pair = await removePairByGoliveChannel(message.groupId, message.channelId);
  if (!pair) {
    return goliveReply(message, "Esta sala não está ligada a nenhum canal do Discord.");
  }

  // Avisa em ambos os canais antes de deletar os webhooks
  try {
    const discordClient = discordWebhookFor(pair);
    await discordClient.send({
      username: "GoLive Sync",
      content: "🔌 **Sincronização encerrada.** As mensagens deste canal não serão mais espelhadas no GoLive.",
      allowedMentions: NO_MENTIONS,
    }).catch(() => {});
  } catch {}

  try {
    await fetch(pair.goliveWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "GoLive Sync",
        content: "🔌 **Sincronização encerrada.** As mensagens desta sala não serão mais espelhadas no Discord.",
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {}

  currentAvatarByPair.delete(pair.id);
  await deleteGoliveWebhook(pair.goliveGroupId, pair.goliveWebhookUrl);
  const discordClient = discordWebhookClients.get(pair.discordWebhookUrl);
  discordWebhookClients.delete(pair.discordWebhookUrl);
  await (discordClient ?? new WebhookClient({ url: pair.discordWebhookUrl }))
    .delete("Desligado pelo GoLive")
    .catch(() => {});

  return goliveReply(message, "✅ Sala desligada do Discord.");
}

async function handleGoliveStatusCommand(message, author) {
  const groupData = await fetchGroup(API, GOLIVE_TOKEN, message.groupId);
  if (!groupData || !isAdmin(groupData, author.id)) {
    return goliveReply(message, "🚫 Você precisa ser **administrador** deste grupo pra ver o status da sincronização.");
  }

  const pair = findByGoliveChannel(message.groupId, message.channelId);
  if (!pair) {
    return goliveReply(message, "Esta sala não está ligada a nenhum canal do Discord.");
  }
  const since = new Date(pair.createdAt).toLocaleString("pt-BR");
  return goliveReply(message, `ℹ️ Ligada ao canal do Discord \`${pair.discordChannelId}\` desde ${since}.`);
}

// ========== Reações (GoLive → Discord) ==========
//
// O evento `group-message-reactions` traz o estado inteiro das reações da
// mensagem, não quem mudou o quê (ver docs/guia/reacoes.md) — por isso cada
// link guarda, em `mirroredEmojis`, quais emoji tinham pelo menos uma pessoa
// de verdade (ou seja, alguém além do próprio bot) da última vez, pra saber
// o que apareceu e o que sumiu desta vez.
async function ensureDiscordReaction(link, emoji, on) {
  try {
    const channel = await discord.channels.fetch(link.discordChannelId);
    const message = await channel.messages.fetch(link.discordMessageId);
    const existing = message.reactions.cache.get(emoji);
    const alreadyOn = existing?.me ?? false;
    if (on && !alreadyOn) await message.react(emoji);
    else if (!on && alreadyOn) await existing.users.remove(discord.user.id);
  } catch (err) {
    console.error("Erro espelhando reação no Discord:", err);
  }
}

async function handleGoliveReactionsChanged(event) {
  const link = linkedByGoliveId.get(goliveMessageKey(event.groupId, event.channelId, event.messageId));
  if (!link) return;

  const current = new Set();
  for (const r of event.reactions ?? []) {
    if (r.users.some((id) => id !== meId)) current.add(r.emoji);
  }
  const previous = link.mirroredEmojis ?? new Set();

  for (const emoji of current) {
    if (!previous.has(emoji)) await ensureDiscordReaction(link, emoji, true);
  }
  for (const emoji of previous) {
    if (!current.has(emoji)) await ensureDiscordReaction(link, emoji, false);
  }
  link.mirroredEmojis = current;
}

// ========== Cliente GoLive (WebSocket) ==========
let attempt = 0;

function connectGoLive() {
  const ws = new WebSocket(GATEWAY);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "register", token: GOLIVE_TOKEN }));
  });

  ws.on("message", async (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.warn("Evento WebSocket inválido recebido do GoLive:", err);
      return;
    }
    if (!event || typeof event !== "object") return;

    if (event.type === "registered") {
      console.log("GoLive conectado!");
      attempt = 0;
      return;
    }

    if (event.type === "group-message") {
      const { message, author } = event;
      if (!message || !author) return;

      // Ignora bots e webhooks (evita loop)
      if (author.bot || author.webhook) return;

      const rawText = (message.text || "").trim();
      // Remove menção do bot no início se houver (ex: "@bot !golive-sync")
      const cleanedCommandText = meId
        ? rawText.replace(new RegExp(`^<@!?${meId}>\\s*`), "").trim()
        : rawText;
      const lower = cleanedCommandText.toLowerCase();

      if (lower.startsWith(GOLIVE_SYNC_PREFIX)) {
        return handleGoliveSyncCommand(message, author, cleanedCommandText);
      }
      if (lower.startsWith("!golive-unlink")) {
        return handleGoliveUnlinkCommand(message, author);
      }
      if (lower.startsWith("!golive-status")) {
        return handleGoliveStatusCommand(message, author);
      }
      if (lower.startsWith("!golive-invite")) {
        return goliveReply(
          message,
          `🤖 **Links para adicionar o bot:**\n• **Discord:** ${DISCORD_INVITE_URL}\n• **GoLive:** ${GOLIVE_INVITE_URL}\n\n🧪 **Beta Teste & Suporte:**\nEste bot está em fase de testes. Caso precise de ajuda ou queira relatar bugs, abra um ticket no servidor do **NemTudo** no Discord:\n👉 ${SUPPORT_SERVER_URL}`
        );
      }
      if (lower.startsWith("!golive-help")) {
        return goliveReply(message, "", { embeds: [createHelpEmbed().toJSON()] });
      }

      // Se mencionou o bot diretamente no texto e não é comando
      if (meId && message.mentions?.includes(meId) && message.text?.includes(`<@${meId}>`)) {
        return goliveReply(message, "", { embeds: [createHelpEmbed().toJSON()] });
      }

      const pair = findByGoliveChannel(message.groupId, message.channelId);
      if (!pair) return; // sala não ligada a nenhum canal do Discord

      await sendToDiscord(
        pair,
        author,
        message.text,
        message.images ?? [],
        message.attachments ?? [],
        message.id,
        {
          gifUrl: message.kind === "gif" ? message.url : undefined,
          replyTo: message.replyTo,
        }
      );
      return;
    }

    if (event.type === "group-message-updated") {
      const { groupId, channelId, message } = event;
      if (!groupId || !channelId || !message?.id) return;

      const key = goliveMessageKey(groupId, channelId, message.id);
      const link = linkedByGoliveId.get(key);
      if (!link) return;

      const pair = findByGoliveChannel(groupId, channelId);
      if (!pair) return;

      try {
        const client = discordWebhookFor(pair);
        const cleanText = sanitizeGoLiveToDiscord(typeof message.text === "string" ? message.text : "").slice(0, 2000);
        if (cleanText) {
          await client.editMessage(link.discordMessageId, {
            content: cleanText,
            allowedMentions: NO_MENTIONS,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("Erro sincronizando edição pro Discord:", err);
      }
      return;
    }

    if (event.type === "group-message-deleted") {
      const { groupId, channelId, messageId } = event;
      if (!groupId || !channelId || !messageId) return;

      const key = goliveMessageKey(groupId, channelId, messageId);
      const link = linkedByGoliveId.get(key);
      if (!link) return;

      unlinkMessages(link);

      const pair = findByGoliveChannel(groupId, channelId);
      if (!pair) return;

      try {
        const client = discordWebhookFor(pair);
        await client.deleteMessage(link.discordMessageId).catch(() => {});
      } catch (err) {
        console.error("Erro sincronizando exclusão pro Discord:", err);
      }
      return;
    }

    if (event.type === "group-message-reactions") {
      await handleGoliveReactionsChanged(event);
    }
  });

  ws.on("close", (code) => {
    if (code === 4003 || code === 4004) {
      console.error("Token inválido / banido. Parando.");
      return;
    }

    const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 1000;
    attempt++;
    console.log(`GoLive caiu (${code}). Reconectando em ${Math.round(delay)}ms`);
    setTimeout(connectGoLive, delay);
  });

  ws.on("error", () => {}); // o close cuida da reconexão
}

// ========== Inicialização ==========
async function main() {
  // Valida token GoLive
  const meRes = await fetch(`${API}/auth/me`, {
    headers: { Authorization: GOLIVE_TOKEN },
  });
  if (!meRes.ok) throw new Error("Token GoLive inválido");
  const { account } = await meRes.json();
  meId = account.id;
  console.log(`GoLive bot: ${account.displayName} (@${account.username})`);

  let pairs = await loadPairs();

  // Migração de uma vez só: quem já usava a versão antiga (uma ligação fixa,
  // configurada nessas cinco variáveis do .env) continua funcionando sem
  // rodar nenhum comando — os webhooks que já existiam são só aproveitados
  // aqui, nenhum novo é criado.
  if (pairs.length === 0 && process.env.GOLIVE_GROUP_ID && process.env.GOLIVE_CHANNEL_ID && process.env.GOLIVE_WEBHOOK_URL && process.env.DISCORD_CHANNEL_ID && process.env.DISCORD_WEBHOOK_URL) {
    await addPair({
      id: newPairId(),
      discordGuildId: null,
      discordChannelId: process.env.DISCORD_CHANNEL_ID,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      goliveGroupId: process.env.GOLIVE_GROUP_ID,
      goliveChannelId: process.env.GOLIVE_CHANNEL_ID,
      goliveWebhookUrl: process.env.GOLIVE_WEBHOOK_URL,
      createdBy: null,
      createdAt: Date.now(),
    });
    pairs = allPairs();
    console.log("Ligação única do .env migrada para pairs.json — essas cinco variáveis podem ser removidas dele agora.");
  }

  console.log(`${pairs.length} ligação(ões) ativa(s).`);

  await discord.login(DISCORD_TOKEN);
  connectGoLive();
}

main().catch(console.error);

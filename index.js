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
import WebSocket from "ws";
import { Client, GatewayIntentBits, Partials, PermissionFlagsBits, SlashCommandBuilder, WebhookClient } from "discord.js";
import { addPair, allPairs, findByDiscordChannel, findByGoliveChannel, loadPairs, newPairId, removePairByDiscordChannel } from "./pairs.js";
import { consumeSync, startFromDiscord, startFromGolive } from "./syncCodes.js";
import { fetchGroup, isAdmin } from "./golivePermissions.js";

const API = "https://apigolive.nemtudo.me";
const GATEWAY = "wss://apigolive.nemtudo.me/ws";

const GOLIVE_TOKEN = process.env.GOLIVE_TOKEN?.startsWith("Bot ")
  ? process.env.GOLIVE_TOKEN
  : `Bot ${process.env.GOLIVE_TOKEN}`;

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
// @everyone/@here, cargos e pessoas nas mensagens que chegam do GoLive,
// venha o que vier no texto.
const NO_MENTIONS = { parse: [], repliedUser: false };

/** Troca os tokens de menção do Discord por texto simples, pra não virarem uma menção de verdade (ou lixo) do outro lado. */
function stripDiscordMentions(message) {
  let text = message.content || "";
  text = text.replace(/<@!?(\d+)>/g, (m, id) => `@${message.mentions.users.get(id)?.username ?? "usuário"}`);
  text = text.replace(/<@&(\d+)>/g, (m, id) => `@${message.mentions.roles.get(id)?.name ?? "cargo"}`);
  text = text.replace(/<#(\d+)>/g, (m, id) => `#${message.mentions.channels.get(id)?.name ?? "canal"}`);
  // Quebra @everyone/@here com um espaço de largura zero, pra sobrar como
  // texto e nunca ser lido como uma menção de verdade do outro lado.
  text = text.replace(/@(everyone|here)/gi, "@​$1");
  return text;
}

// ========== Ligação entre mensagens (para as reações) ==========
//
// Pra espelhar uma reação, o bot precisa saber a que mensagem do OUTRO lado
// aquela mensagem corresponde. Guardado só em memória (reinicia zerado, como
// o resto do estado ao vivo deste bot) e limitado a um teto — como o guia de
// reações sugere para o próprio estado de reações, aqui é o mesmo motivo:
// sem limite, a memória cresceria pra sempre.
const MAX_LINKED_MESSAGES = 2000;
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

// ========== GoLive → Discord ==========
// `images` e `attachments` já são URLs públicas (o CDN do GoLive) — o
// discord.js busca uma URL sozinho quando `attachment` é uma string http(s),
// então não precisa baixar o arquivo aqui para depois subir de novo.
async function sendToDiscord(pair, author, text, images = [], attachments = [], goliveMessageId = null) {
  if (!text?.trim() && images.length === 0 && attachments.length === 0) return;

  const files = [
    ...images.map((url) => ({ attachment: url })),
    ...attachments.map((a) => ({ attachment: a.url, name: a.name })),
  ];

  const sent = await discordWebhookFor(pair).send({
    content: text.slice(0, 2000),
    username: author.name || author.username || "Usuário GoLive",
    avatarURL: author.avatarUrl || undefined,
    allowedMentions: NO_MENTIONS, // evita menções acidentais
    ...(files.length > 0 ? { files } : {}),
  });

  if (goliveMessageId) {
    linkMessages({
      discordMessageId: sent.id,
      discordChannelId: pair.discordChannelId,
      goliveGroupId: pair.goliveGroupId,
      goliveChannelId: pair.goliveChannelId,
      goliveMessageId,
    });
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
      const imgRes = await fetch(discordAvatarUrl);
      if (!imgRes.ok) return;
      const contentType = imgRes.headers.get("content-type") || "image/png";
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      avatar = `data:${contentType};base64,${buffer.toString("base64")}`;
    }

    const res = await fetch(pair.goliveWebhookUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar }),
    });
    if (!res.ok) {
      console.error("Falha ao trocar a foto do webhook GoLive:", res.status, await res.text());
      return;
    }
    const { avatar: goliveAvatarUrl } = await res.json();
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
  const res = await fetch(url);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { contentType, dataUrl: `data:${contentType};base64,${buffer.toString("base64")}` };
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
  const text = stripDiscordMentions(message);
  const discordAttachments = [...message.attachments.values()];
  if (!text?.trim() && discordAttachments.length === 0) return;

  const author = message.author;
  await syncGoLiveWebhookAvatar(pair, author.displayAvatarURL?.({ size: 128, extension: "png" }));
  const { images, files } = await convertDiscordAttachments(discordAttachments);

  // ?wait=true devolve a mensagem criada (com o id) — sem isso não dá pra
  // ligar essa mensagem à sua correspondente no Discord para as reações.
  // Só o username é dinâmico por mensagem; a foto agora acompanha o autor via
  // syncGoLiveWebhookAvatar acima.
  const res = await fetch(`${pair.goliveWebhookUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: text.slice(0, 2000),
      username: author.displayName || author.username || "Usuário Discord",
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    }),
  });

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
];

/** Confere de novo, no servidor, que quem chamou o comando é administrador — não dá pra confiar só no setDefaultMemberPermissions (é editável pelos admins do servidor). Responde com um erro e retorna false se não for. */
async function requireAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  await interaction.reply({ content: "🚫 Só administradores do servidor podem usar este comando.", ephemeral: true });
  return false;
}

const SYNC_CODE_HELP = "Gere um novo código com `/golive-sync` (Discord, sem código) ou `!golive-sync` (GoLive, sem código) do lado oposto ao que você está completando.";

/** O `id` de um webhook do GoLive, extraído do seu próprio endereço (/webhooks/<id>/<token>). */
function goliveWebhookIdFrom(webhookUrl) {
  const [, , id] = new URL(webhookUrl).pathname.split("/");
  return id;
}

async function deleteGoliveWebhook(groupId, webhookUrl) {
  const id = goliveWebhookIdFrom(webhookUrl);
  await fetch(`${API}/groups/${groupId}/webhooks/${id}`, {
    method: "DELETE",
    headers: { Authorization: GOLIVE_TOKEN },
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

  return { ok: true, pair };
}

const SYNC_DONE_MESSAGE = "✅ Ligado! As mensagens (e fotos e arquivos) agora vão e voltam entre o Discord e o GoLive.";

// ========== Tutorial (ao ser mencionado) ==========
//
// @mencionar o bot num canal do Discord ou numa sala do GoLive responde com
// isto — pra quem esbarra nele sem ter lido nenhuma documentação.
const TUTORIAL_DISCORD = [
  "👋 Eu ligo um canal daqui a uma sala do GoLive: depois de ligados, toda mensagem (com fotos e arquivos) vai e volta entre os dois sozinha.",
  "",
  "**Para ligar este canal a uma sala do GoLive:**",
  "1. Aqui, rode `/golive-sync` sem nada — eu gero um código.",
  "2. Na sala do GoLive que você quer ligar, digite `!golive-sync <código>`.",
  "",
  "(Também funciona começando pelo GoLive: `!golive-sync` lá, depois `/golive-sync codigo:<código>` aqui.)",
  "",
  "**Outros comandos:** `/golive-status` (mostra a ligação deste canal) e `/golive-unlink` (desliga).",
  "",
  "Preciso da permissão **Gerenciar Webhooks** aqui, e minha conta do GoLive precisa da permissão **Gerenciar webhooks** no grupo que você quer ligar.",
].join("\n");

const TUTORIAL_GOLIVE = [
  "👋 Eu ligo esta sala a um canal do Discord: depois de ligados, toda mensagem (com fotos e arquivos) vai e volta entre os dois sozinha.",
  "",
  "**Para ligar esta sala a um canal do Discord:**",
  "1. Aqui, digite `!golive-sync` sem nada — eu gero um código.",
  "2. No canal do Discord que você quer ligar, rode `/golive-sync codigo:<código>`.",
  "",
  "(Também funciona começando pelo Discord: `/golive-sync` lá, depois `!golive-sync <código>` aqui.)",
  "",
  "**Outros comandos (no Discord):** `/golive-status` e `/golive-unlink`.",
  "",
  'Preciso da permissão "Gerenciar webhooks" aqui neste grupo, e minha conta do Discord precisa da permissão Gerenciar Webhooks no canal que você quer ligar.',
].join("\n");

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

  if (message.mentions.has(discord.user)) {
    return void message.reply({ content: TUTORIAL_DISCORD, allowedMentions: NO_MENTIONS }).catch(() => {});
  }

  const pair = findByDiscordChannel(message.channelId);
  if (!pair) return; // canal não ligado a nenhuma sala do GoLive
  if (!message.content && message.attachments.size === 0) return;

  await sendToGoLive(pair, message);
});

// ========== Reações (Discord → GoLive) ==========
//
// O bot só pode mexer na própria reação em cada lado (ver docs/guia/reacoes.md),
// então "espelhar" é: enquanto pelo menos uma pessoa de verdade tiver aquele
// emoji na mensagem original, a conta do bot mantém o mesmo emoji na mensagem
// ligada do outro lado; quando a última pessoa tira o dela, o bot tira o seu.
async function handleDiscordReactionChange(reaction, user) {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    return;
  }
  if (reaction.emoji.id) return; // emoji personalizado — o GoLive só aceita unicode

  const link = linkedByDiscordId.get(reaction.message.id);
  if (!link) return;

  const hasReal = reaction.count - (reaction.me ? 1 : 0) > 0;
  try {
    await fetch(
      `${API}/groups/${link.goliveGroupId}/channels/${link.goliveChannelId}/messages/${link.goliveMessageId}/reactions`,
      {
        method: "POST",
        headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: reaction.emoji.name, on: hasReal }),
      }
    );
  } catch (err) {
    console.error("Erro espelhando reação no GoLive:", err);
  }
}

discord.on("messageReactionAdd", handleDiscordReactionChange);
discord.on("messageReactionRemove", handleDiscordReactionChange);

// ========== Comando do lado do GoLive (!golive-sync) ==========
//
// O GoLive não tem comandos de barra — um bot lê o texto das mensagens e
// decide (ver docs/guia/comandos.md). `!golive-sync` é o espelho do
// /golive-sync do Discord: sem argumento gera um código, com um código
// completa uma sincronização começada do lado do Discord.
const GOLIVE_SYNC_PREFIX = "!golive-sync";

/** Responde na mesma sala, citando o comando — sem notificar (é uma resposta automática). */
async function goliveReply(message, text) {
  await fetch(`${API}/groups/${message.groupId}/channels/${message.channelId}/messages`, {
    method: "POST",
    headers: { Authorization: GOLIVE_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      replyTo: { id: message.id, name: message.fromName, text: message.text.slice(0, 200), kind: message.kind },
    }),
  }).catch((err) => console.error("Erro respondendo no GoLive:", err));
}

async function handleGoliveSyncCommand(message, author) {
  if (findByGoliveChannel(message.groupId, message.channelId)) {
    return goliveReply(message, "Esta sala já está ligada a um canal do Discord. Desligue com `/golive-unlink` no Discord primeiro.");
  }

  const groupData = await fetchGroup(API, GOLIVE_TOKEN, message.groupId);
  if (!groupData || !isAdmin(groupData, author.id)) {
    return goliveReply(message, "🚫 Você precisa ser **administrador** deste grupo pra ligar esta sala ao Discord.");
  }

  const code = message.text.trim().slice(GOLIVE_SYNC_PREFIX.length).trim();
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
    const event = JSON.parse(data.toString());

    if (event.type === "registered") {
      console.log("GoLive conectado!");
      attempt = 0;
      return;
    }

    if (event.type === "group-message") {
      const { message, author } = event;

      // Ignora bots e webhooks (evita loop)
      if (author.bot || author.webhook) return;

      if (meId && message.mentions?.includes(meId)) {
        return goliveReply(message, TUTORIAL_GOLIVE);
      }

      if (message.text?.trim().toLowerCase().startsWith(GOLIVE_SYNC_PREFIX)) {
        return handleGoliveSyncCommand(message, author);
      }

      const pair = findByGoliveChannel(message.groupId, message.channelId);
      if (!pair) return; // sala não ligada a nenhum canal do Discord

      await sendToDiscord(pair, author, message.text, message.images ?? [], message.attachments ?? [], message.id);
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

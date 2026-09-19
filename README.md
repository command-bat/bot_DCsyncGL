# bot_DCsyncGL

Ponte entre o Discord e o GoLive: liga um canal de texto do Discord a uma sala
de um grupo do GoLive, e cada mensagem enviada de um lado aparece do outro,
com nome, foto, fotos e arquivos — sem precisar copiar nenhum link de
webhook. Um único processo deste bot atende quantos servidores do Discord e
quantos grupos do GoLive quiserem usar ao mesmo tempo; cada ligação é sempre
**1 canal do Discord ↔ 1 sala do GoLive**, nunca duas ligações compartilhando
o mesmo canal de nenhum dos dois lados.

## Arquivos

| Arquivo | O que guarda |
|---|---|
| `index.js` | Tudo que roda: os dois clientes (Discord e GoLive), os comandos, e a ponte de mensagens em si. |
| `pairs.js` | As ligações ativas — carregadas de `pairs.json` ao iniciar, uma escrita nesse arquivo a cada mudança. Garante o 1-para-1: `addPair` recusa uma ligação cujo canal do Discord ou sala do GoLive já esteja em outra. |
| `syncCodes.js` | Os códigos de sincronização usados pra ligar um canal a uma sala (ver abaixo) — só em memória, cada um dura 10 minutos. |
| `golivePermissions.js` | Confere se quem digitou um comando *no GoLive* é administrador daquele grupo — a mesma conta que a API faz, do lado do bot. |
| `pairs.json` | Criado sozinho na primeira ligação. Não é versionado (está no `.gitignore`): carrega o endereço de cada webhook, que é uma senha. |

## Como uma ligação é feita

Ninguém precisa saber o id de nada do outro lado — só um código de 6
caracteres, gerado de um lado e digitado do outro:

```
Discord: /golive-sync                  → gera um código
         /golive-sync codigo:ABC123    → completa, usando um código gerado no GoLive

GoLive:  !golive-sync                  → gera um código
         !golive-sync ABC123           → completa, usando um código gerado no Discord
```

Dá pra começar por qualquer um dos dois lados. Quem completa (digita o
código do lado oposto) é o gatilho: o bot então

1. cria um webhook na sala do GoLive (`POST /groups/:id/channels/:cid/webhooks`,
   com o próprio token do bot — por isso ele precisa da permissão "Gerenciar
   webhooks" naquele grupo, ver [Requisitos](#requisitos-de-permissão) abaixo);
2. cria um webhook no canal do Discord (`channel.createWebhook`, exige a
   permissão **Gerenciar Webhooks** do bot naquele servidor);
3. guarda a ligação em `pairs.json` (via `pairs.js`).

A partir daí a ligação já está funcionando — nenhum outro passo.

Um código só vale uma vez e só do lado oposto ao que o gerou: completá-lo do
mesmo lado (por engano) não o desperdiça, ele continua bom pro lado certo até
vencer.

### Comandos

| Onde | Comando | O que faz |
|---|---|---|
| Discord | `/golive-sync` | Gera um código para este canal (sem argumento) ou completa uma ligação com o código de uma sala do GoLive (`codigo:`). |
| Discord | `/golive-unlink` | Desliga o canal atual e apaga os dois webhooks. |
| Discord | `/golive-status` | Mostra a qual sala do GoLive o canal atual está ligado, se houver. |
| Discord | `/golive-invite` | Exibe os botões e links para adicionar o bot ao Discord e ao GoLive. |
| Discord | `/golive-help` | Exibe o painel de ajuda em embed com instruções e lista de comandos. |
| GoLive | `!golive-sync` | O espelho do `/golive-sync` do Discord — sem argumento gera um código, com um código completa. |
| GoLive | `!golive-unlink` | Desliga a sala atual do Discord e apaga os dois webhooks. |
| GoLive | `!golive-status` | Mostra a qual canal do Discord a sala atual está ligada, se houver. |
| GoLive | `!golive-invite` | Exibe os links para adicionar o bot ao Discord e ao GoLive. |
| GoLive | `!golive-help` | Exibe o painel de ajuda em embed e instruções de uso. |

Os comandos de configuração e sincronização (`/golive-sync`, `/golive-unlink`, `/golive-status`, `!golive-sync`, `!golive-unlink`, `!golive-status`) exigem **administrador**: no Discord exigem
administrador ou dono do servidor (e são respondidos de forma efêmera e privada),
e no GoLive conferem se quem digitou é o dono do grupo ou possui cargo
com a permissão `administrator` antes de executar qualquer ação (ver `golivePermissions.js`). Os comandos de ajuda e convite (`/golive-help`, `/golive-invite`, `!golive-help`, `!golive-invite`) podem ser consultados livremente.

## O que é sincronizado, e como

Uma vez ligados, `index.js` ouve as duas pontas:

- **Discord → GoLive** (`messageCreate`): texto, respostas/citações a mensagens anteriores, figurinhas (stickers convertidas em fotos) e anexos convertidos para o
  formato que o webhook do GoLive aceita — `images` (fotos, como data URL) e
  `files` (qualquer outro tipo, também como data URL), respeitando os limites
  do webhook (3 fotos/5 MB cada, 5 arquivos/8 MB cada — ver
  `GOLIVE_MAX_IMAGES` etc. em `index.js`). A foto do webhook do GoLive é
  trocada pra foto de quem está falando via `PATCH /webhooks/:id/:token` (ver
  a documentação do GoLive, `docs/guia/webhooks.md`) — com um cache que evita
  subir a mesma foto duas vezes quando a mesma pessoa volta a falar depois de
  outra.
- **GoLive → Discord** (evento `group-message` do WebSocket): texto, citações de respostas (`replyTo`), fotos e
  arquivos, mandados pro `WebhookClient` do Discord — que busca as URLs do
  CDN do GoLive direto, sem baixar e re-enviar nada.
- **Edição e Exclusão Bidirecional**: quando uma mensagem vinculada é editada ou apagada no Discord, a alteração/exclusão correspondente é enviada imediatamente à sala do GoLive; reciprocamente, quando uma mensagem é editada ou excluída no GoLive, o bot edita ou apaga a mensagem espelhada no Discord.
- **Avisos de Conexão e Desconexão**: ao concluir uma ligação com sucesso, ambos os canais recebem um anúncio de conexão estabelecida; ao desvincular (`/golive-unlink` ou `!golive-unlink`), ambos os canais recebem um aviso amigável de desconexão antes da remoção dos webhooks.
- **Reações**, nas duas direções: como o bot só pode mexer na própria reação
  (nunca na de outra pessoa — regra de ambas as plataformas), "espelhar" é
  manter o mesmo emoji da conta do bot na mensagem ligada do outro lado
  enquanto pelo menos uma pessoa de verdade reagiu com ele, e tirar assim
  que a última pessoa tira a dela. Só emoji Unicode são espelhados — o
  GoLive não tem emoji personalizado.

Mensagens de outros webhooks e bots nunca são retransmitidas — é o que evita
um eco infinito entre os dois lados.

### Bloqueio de Menções (Everyone e Pessoas)

Nenhum lado consegue notificar `@everyone`, `@here`, `@todos`, cargos ou pessoas específicas através do outro aplicativo:

- **Discord → GoLive:** Qualquer token de menção (`<@id>`, `<@&id>`, `<#id>`) ou menção em texto (`@everyone`, `@here`, `@todos`, `@online`, `@offline`, e qualquer `@Nome` de usuário) recebe um espaço invisível de largura zero (`@\u200BNome`). Com isso, a mensagem permanece legível visualmente, mas o GoLive **nunca** a interpreta como menção, não gera notificações push, nem alertas sonoros de menção na sala.
- **GoLive → Discord:** Qualquer menção de broadcast (`@everyone`, `@here`, `@todos`, etc.), tokens `<@id>` ou menção a usuários (`@Nome`) também é neutralizada com zero-width space antes de ser enviada ao Discord. Além disso, o envio do webhook utiliza `allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }`, garantindo que nenhuma menção ou ping atinja membros no Discord.

## Requisitos de permissão

- **No Discord:** o bot precisa ser convidado com os escopos `bot` e
  `applications.commands`, e as permissões **Gerenciar Webhooks** (sem ela,
  completar uma sincronização falha ao tentar criar o webhook do canal),
  **Adicionar Reações** e **Ler Histórico de Mensagens** (para espelhar as
  reações que vêm do GoLive).
- **No GoLive:** a conta do bot (a que o `GOLIVE_TOKEN` autentica) precisa ser
  **adicionada a cada grupo** que for usado, com as permissões **Gerenciar
  webhooks** *naquele grupo* (sem isso, a API responde `403`/`404` na hora de
  criar o webhook, e é exatamente essa mensagem que o comando devolve) e
  **Adicionar reações** (`addReactions`) para espelhar as reações que vêm do
  Discord.

## Configuração

Variáveis de ambiente, em `.env`:

| Variável | Para quê |
|---|---|
| `GOLIVE_TOKEN` | Token da conta-bot do GoLive (com ou sem o prefixo `Bot `). |
| `DISCORD_TOKEN` | Token do bot no Discord. |

As demais variáveis que existiam numa versão anterior deste bot
(`GOLIVE_GROUP_ID`, `GOLIVE_CHANNEL_ID`, `GOLIVE_WEBHOOK_URL`,
`DISCORD_CHANNEL_ID`, `DISCORD_WEBHOOK_URL`) não são mais lidas depois da
primeira vez que o bot inicia com elas presentes — nesse primeiro boot, se
`pairs.json` ainda não existir, elas são migradas automaticamente para uma
ligação em `pairs.json` (sem criar nenhum webhook novo) e podem ser
removidas do `.env` depois.

## Rodando

```
npm install
node index.js
```

Os comandos de barra do Discord são registrados globalmente ao conectar
(`discord.application.commands.set`) — uma mudança neles pode levar até uma
hora para aparecer em todo lugar, é assim que o Discord funciona.

## 🧪 Versão Beta & Suporte

Este bot está atualmente em fase de **Beta Teste**. Se você encontrar qualquer inconsistência, bug ou precisar de suporte na configuração dos canais ou permissões:

- Abra um **ticket de suporte** no servidor oficial do **NemTudo** no Discord:
  👉 **[discord.gg/nemtudo](http://discord.gg/nemtudo)**


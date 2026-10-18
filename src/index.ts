
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "baileys";
import ollama from "ollama";
import qrcode from "qrcode-terminal";

const MODEL = "qwen2.5:1.5b";
const SELF_CHAT_TRIGGER = "!marquinhos ";
const HISTORY_LIMIT = 10;

const systemMessage = {
  role: "system" as const,
  content: `
Você é Marquinhos, um assistente de IA especializado em programação.
Responda sempre em português brasileiro, de forma clara, natural e didática.

Explique os conceitos com exemplos práticos e código correto.
Priorize TypeScript, JavaScript, Node.js, React e Next.js.
Não invente informações quando não souber a resposta.

Você ainda não tem permissão para modificar arquivos do computador.
Quando o usuário pedir uma tarefa que envolva alterações no PC,
explique o que seria necessário e aguarde uma autorização explícita.
  `.trim(),
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const histories = new Map<string, ChatMessage[]>();
const pendingByChat = new Map<string, Promise<void>>();

function getMessageText(message: any): string {
  const content = message?.message;

  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    ""
  ).trim();
}

function limitHistory(
  messages: ChatMessage[],
  limit = HISTORY_LIMIT,
): ChatMessage[] {
  const recentMessages = messages.slice(-limit);

  if (recentMessages[0]?.role === "assistant") {
    recentMessages.shift();
  }

  return recentMessages;
}

async function answerWithOllama(
  chatId: string,
  prompt: string,
): Promise<string> {
  const history = histories.get(chatId) ?? [];

  history.push({
    role: "user",
    content: prompt,
  });

  const messages = [
    systemMessage,
    ...limitHistory(history),
  ];

  console.log(`[OLLAMA] Consultando modelo: ${MODEL}`);

  const response = await ollama.chat({
    model: MODEL,
    messages,
  });

  const answer = response.message.content.trim();

  history.push({
    role: "assistant",
    content: answer,
  });

  histories.set(chatId, limitHistory(history));

  return answer || "Não consegui gerar uma resposta desta vez.";
}

async function connectToWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(
    "auth_info_baileys",
  );

  const socket = makeWASocket({
    auth: state,
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on(
    "connection.update",
    ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("Escaneie o QR Code abaixo com o WhatsApp:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("🌑 Marquinhos Agent conectado ao WhatsApp.");
        console.log(
          `No chat "Mensagem para você", envie: ${SELF_CHAT_TRIGGER}sua pergunta`,
        );

        console.log("[DEBUG] Identidade da sessão:", {
          id: socket.user?.id,
          lid: socket.user?.lid,
        });
      }

      if (connection === "close") {
        const error = lastDisconnect?.error;

        const statusCode =
          error && "output" in error
            ? error.output?.statusCode
            : undefined;

        console.log("[DEBUG] Conexão encerrada:", {
          statusCode,
          error: error?.message,
        });

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "Sessão desconectada. Remova o aparelho vinculado e pareie novamente.",
          );
          return;
        }

        console.log("Conexão encerrada; tentando reconectar...");

        setTimeout(() => {
          void connectToWhatsApp();
        }, 2_000);
      }
    },
  );

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(
      `[DEBUG] Evento: ${type} | Mensagens: ${messages.length}`,
    );

    if (type !== "notify") {
      console.log("[DEBUG] Evento ignorado: não é notify.");
      return;
    }

    for (const message of messages) {
      const jid = message.key.remoteJid;
      const text = getMessageText(message);

      const ownId = socket.user?.id
        ? jidNormalizedUser(socket.user.id)
        : null;

      const ownLid = socket.user?.lid
        ? jidNormalizedUser(socket.user.lid)
        : null;

      const normalizedJid = jid
        ? jidNormalizedUser(jid)
        : null;

      console.log("[DEBUG] Mensagem recebida:", {
        jid,
        fromMe: message.key.fromMe,
        temTexto: Boolean(text),
        texto: text || "(sem texto reconhecido)",
        comecaComComando: text
          .toLowerCase()
          .startsWith(SELF_CHAT_TRIGGER),
        ownId,
        ownLid,
        jidNormalizado: normalizedJid,
      });

      if (!jid) {
        console.log("[DEBUG] Ignorada: mensagem sem JID.");
        continue;
      }

      if (
        jid.endsWith("@g.us") ||
        jid === "status@broadcast" ||
        jid.endsWith("@newsletter")
      ) {
        console.log("[DEBUG] Ignorada: grupo, status ou canal.");
        continue;
      }

      if (!text) {
        console.log("[DEBUG] Ignorada: mensagem sem texto reconhecido.");
        continue;
      }

      // CORREÇÃO: aceita o identificador do telefone ou o LID da sessão.
      const isOwnChat =
        normalizedJid === ownId ||
        (ownLid !== null && normalizedJid === ownLid);

      if (!isOwnChat) {
        console.log(
          "[DEBUG] Ignorada: a conversa não corresponde à conta conectada.",
        );
        continue;
      }

      if (!message.key.fromMe) {
        console.log(
          "[DEBUG] Ignorada: a mensagem não foi enviada por você.",
        );
        continue;
      }

      if (
        !text
          .toLowerCase()
          .startsWith(SELF_CHAT_TRIGGER)
      ) {
        console.log(
          `[DEBUG] Ignorada: use o prefixo ${SELF_CHAT_TRIGGER}`,
        );
        continue;
      }

      const prompt = text
        .slice(SELF_CHAT_TRIGGER.length)
        .trim();

      if (!prompt) {
        console.log("[DEBUG] Ignorada: comando sem pergunta.");
        continue;
      }

      console.log("[DEBUG] Comando reconhecido! Preparando resposta...");

      const chatQueue =
        pendingByChat.get(jid) ?? Promise.resolve();

      const next = chatQueue
        .catch(() => undefined)
        .then(async () => {
          try {
            console.log(`[USUÁRIO] ${prompt}`);

            const answer = await answerWithOllama(jid, prompt);

            console.log(
              "[DEBUG] Ollama respondeu. Enviando mensagem ao WhatsApp...",
            );

            await socket.sendMessage(jid, {
              text: answer,
            });

            console.log(`[MARQUINHOS] ${answer}\n`);
            console.log("[DEBUG] Resposta enviada com sucesso.");
          } catch (error) {
            console.error(
              "[ERRO] Falha ao responder:",
              error,
            );

            try {
              await socket.sendMessage(jid, {
                text:
                  "Não consegui processar sua pergunta. Confira se o Ollama está funcionando e se o modelo qwen2.5:1.5b está instalado.",
              });
            } catch (sendError) {
              console.error(
                "[ERRO] Também não foi possível enviar a mensagem de erro:",
                sendError,
              );
            }
          }
        });

      pendingByChat.set(jid, next);
    }
  });
}

connectToWhatsApp().catch((error: unknown) => {
  console.error("❌ Erro ao iniciar o Marquinhos:", error);
  process.exitCode = 1;
});

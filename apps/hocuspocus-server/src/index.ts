import { createServer } from "node:http";
import { Server } from "@hocuspocus/server";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { verifyCollabToken } from "@acme/auth/collab-token";
import type { CollabTokenPayload } from "@acme/auth/collab-token";
import {
  and,
  db,
  codelet,
  codeletMember,
  codeletMessage,
  eq,
  sql,
} from "@acme/db";

import { env } from "./env.js";
import {
  cancelPreviewSchedules,
  schedulePreview,
} from "./services/preview.js";

interface CollabContext {
  user: {
    id: string;
    username: string;
  };
  codeletId: number;
  role: CollabTokenPayload["role"];
  isReadOnly: boolean;
}

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  timestamp: number;
}

const allowedOrigins = (env.ALLOWED_WS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Per-codelet cache of (ownerId + active member IDs) used to validate
// chat-message authorship at persist time. onStoreDocument fires on every
// save tick — re-querying every time fans out one extra round trip per
// keystroke burst.
const MEMBERSHIP_TTL_MS = 30 * 1000;
const membershipCache = new Map<
  number,
  { allowed: Set<string>; expiresAt: number }
>();

async function getAllowedAuthorIds(
  codeletId: number,
  ownerId: string,
): Promise<Set<string>> {
  const cached = membershipCache.get(codeletId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.allowed;
  }

  const members = await db
    .select({ userId: codeletMember.userId })
    .from(codeletMember)
    .where(
      and(
        eq(codeletMember.codeletId, codeletId),
        eq(codeletMember.status, "active"),
      ),
    );

  const allowed = new Set<string>([ownerId, ...members.map((m) => m.userId)]);
  membershipCache.set(codeletId, {
    allowed,
    expiresAt: now + MEMBERSHIP_TTL_MS,
  });
  return allowed;
}


function originAllowed(origin: string | undefined): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

const server = Server.configure({
  port: env.PORT,

  onListen: async (data) => {
    console.log(`Hocuspocus server running on port ${data.port}`);
  },

  onAuthenticate: async ({
    documentName,
    connection,
    token,
    requestHeaders,
  }) => {
    if (!originAllowed(requestHeaders.origin)) {
      throw new Error("Origin not allowed");
    }

    const expectedcodeletId = parseInt(documentName.replace("codelet-", ""), 10);
    if (!Number.isFinite(expectedcodeletId)) {
      throw new Error("Invalid document name");
    }

    const payload = verifyCollabToken(
      token ?? "",
      process.env.BETTER_AUTH_SECRET ?? "",
    );
    if (!payload) {
      throw new Error("Invalid or expired token");
    }

    if (payload.codeletId !== expectedcodeletId) {
      throw new Error("Token does not match document");
    }

    const [existingcodelet] = await db
      .select()
      .from(codelet)
      .where(eq(codelet.id, expectedcodeletId))
      .limit(1);

    if (!existingcodelet) {
      throw new Error("codelet not found");
    }

    // Re-verify access at connection time (token may have been issued
    // before access was revoked).
    let isReadOnly = true;
    if (existingcodelet.ownerId === payload.userId) {
      isReadOnly = false;
    } else {
      const [member] = await db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, expectedcodeletId),
            eq(codeletMember.userId, payload.userId),
            eq(codeletMember.status, "active"),
          ),
        )
        .limit(1);

      if (member?.role === "editor") {
        isReadOnly = false;
      } else if (member?.role === "viewer") {
        isReadOnly = true;
      } else if (existingcodelet.isPublic) {
        // Public codelet, non-member: read-only is allowed.
        isReadOnly = true;
      } else {
        throw new Error("Access denied");
      }
    }

    connection.readOnly = isReadOnly;

    const context: CollabContext = {
      user: {
        id: payload.userId,
        username: payload.username,
      },
      codeletId: expectedcodeletId,
      role: payload.role,
      isReadOnly,
    };
    return context;
  },

  // Load existing document from PostgreSQL
  onLoadDocument: async ({ documentName, document }) => {
    const codeletId = parseInt(documentName.replace("codelet-", ""), 10);
    if (!Number.isFinite(codeletId)) return;

    try {
      const [existing] = await db
        .select({ yjsData: codelet.yjsData })
        .from(codelet)
        .where(eq(codelet.id, codeletId))
        .limit(1);

      if (existing?.yjsData) {
        const update = Buffer.from(existing.yjsData, "base64");
        applyUpdate(document, update);
      }
    } catch (err) {
      console.error("Failed to load document:", err);
    }

    return document;
  },

  // Enforce verified identity on awareness updates.
  // The client can still set color / cursor / photoURL freely, but the
  // server overwrites id and name with the values from the verified token
  // so a peer cannot impersonate someone else in the presence list.
  onAwarenessUpdate: async ({ awareness, updated, context }) => {
    const ctx = context as CollabContext | undefined;
    if (!ctx?.user) return;

    for (const clientId of updated) {
      const state = awareness.getStates().get(clientId);
      if (!state?.user) continue;

      const u = state.user as { id?: unknown; name?: unknown };
      if (u.id !== ctx.user.id || u.name !== ctx.user.username) {
        awareness.states.set(clientId, {
          ...state,
          user: {
            ...state.user,
            id: ctx.user.id,
            name: ctx.user.username,
          },
        });
      }
    }
  },

  // Store document to PostgreSQL
  onStoreDocument: async ({ documentName, document, clientsCount }) => {
    const codeletId = parseInt(documentName.replace("codelet-", ""), 10);
    if (!Number.isFinite(codeletId)) return;

    try {
      const update = encodeStateAsUpdate(document);
      const data = Buffer.from(update).toString("base64");

      const [codeletData] = await db
        .select({
          id: codelet.id,
          ownerId: codelet.ownerId,
        })
        .from(codelet)
        .where(eq(codelet.id, codeletId))
        .limit(1);

      if (!codeletData) {
        console.error(`codelet ${codeletId} not found`);
        return;
      }

      await db
        .update(codelet)
        .set({
          yjsData: data,
          lastClientsCount: clientsCount,
          yjsVersion: sql`${codelet.yjsVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(codelet.id, codeletId));

      // Persist chat messages. Only keep ones whose userId is either the
      // codelet owner or an active member — this prevents a forged chat
      // message from being attributed to an arbitrary user in the DB.
      const messagesArray = document.getArray<ChatMessage>("messages");
      const messages = messagesArray.toArray();

      if (messages.length > 0) {
        const candidateUserIds = Array.from(
          new Set(messages.map((m) => m.userId).filter(Boolean)),
        );

        const allowedUserIds =
          candidateUserIds.length > 0
            ? await getAllowedAuthorIds(codeletId, codeletData.ownerId)
            : new Set<string>();

        const values = messages
          .filter(
            (msg) =>
              typeof msg.userId === "string" &&
              !msg.userId.startsWith("anon-") &&
              allowedUserIds.has(msg.userId) &&
              typeof msg.text === "string" &&
              msg.text.length > 0,
          )
          .map((msg) => ({
            id: msg.id,
            codeletId,
            userId: msg.userId,
            authorUsername:
              typeof msg.username === "string"
                ? msg.username.slice(0, 100)
                : null,
            content: msg.text.slice(0, 4000),
            createdAt: new Date(msg.timestamp),
          }));

        if (values.length > 0) {
          await db.insert(codeletMessage).values(values).onConflictDoNothing();
        }
      }

      // Preview generation is throttled per codelet (leading+trailing edge)
      // so rapid edits don't fan out into a Puppeteer launch per debounce tick.
      const html = document.getText("html").toString();
      const css = document.getText("css").toString();
      const js = document.getText("js").toString();
      const settingsMap = document.getMap("settings");
      const headScripts = (settingsMap.get("headScripts") as string) ?? "";

      schedulePreview({
        codeletId,
        html,
        css,
        js,
        headScripts,
      });
    } catch (err) {
      console.error("Failed to store document:", err);
    }
  },
});

server.listen();

const startedAt = Date.now();
const healthPort = env.PORT + 1;
const healthServer = createServer((req, res) => {
  if (req.url !== "/health" && req.url !== "/healthz") {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      documents: server.getDocumentsCount(),
      connections: server.getConnectionsCount(),
    }),
  );
});
healthServer.listen(healthPort, () => {
  console.log(`Healthcheck listening on port ${healthPort}`);
});

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    cancelPreviewSchedules();
    await server.destroy();
    healthServer.close();
  } catch (err) {
    console.error("Error during shutdown:", err);
  }
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

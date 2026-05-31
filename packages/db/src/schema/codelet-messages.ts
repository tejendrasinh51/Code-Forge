import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";
import { codelet } from "./codelets";

export const codeletMessage = pgTable(
  "codelet_message",
  {
    id: varchar("id", { length: 100 }).primaryKey(),
    codeletId: integer("codelet_id")
      .notNull()
      .references(() => codelet.id, { onDelete: "cascade" }),
    // userId becomes null when the author is deleted — the row itself
    // stays so chat history isn't punched full of holes. authorUsername
    // is the snapshot of the username at send-time so we can still render
    // who said what.
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    authorUsername: varchar("author_username", { length: 100 }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("codelet_message_room_created_idx").on(t.codeletId, t.createdAt),
  ],
);

export const codeletMessageRelations = relations(codeletMessage, ({ one }) => ({
  codelet: one(codelet, {
    fields: [codeletMessage.codeletId],
    references: [codelet.id],
  }),
  user: one(user, {
    fields: [codeletMessage.userId],
    references: [user.id],
  }),
}));

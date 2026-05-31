import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";
import { codelet } from "./codelets";

export const codeletSnapshot = pgTable(
  "codelet_snapshot",
  {
    id: serial("id").primaryKey(),
    codeletId: integer("codelet_id")
      .notNull()
      .references(() => codelet.id, { onDelete: "cascade" }),
    // Base64-encoded Yjs state at snapshot time.
    yjsData: text("yjs_data").notNull(),
    label: varchar("label", { length: 200 }),
    // User who took the snapshot — kept for attribution. Set null if they
    // are later deleted so we don't lose the historical row.
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("codelet_snapshot_room_created_idx").on(t.codeletId, t.createdAt),
  ],
);

export const codeletSnapshotRelations = relations(
  codeletSnapshot,
  ({ one }) => ({
    codelet: one(codelet, {
      fields: [codeletSnapshot.codeletId],
      references: [codelet.id],
    }),
    creator: one(user, {
      fields: [codeletSnapshot.createdBy],
      references: [user.id],
    }),
  }),
);

export type codeletSnapshot = typeof codeletSnapshot.$inferSelect;
export type NewcodeletSnapshot = typeof codeletSnapshot.$inferInsert;

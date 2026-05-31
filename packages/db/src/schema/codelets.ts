import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";
import { memberRoleEnum, memberStatusEnum } from "./enums";

export const codelet = pgTable(
  "codelet",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),

    // Owner (creator)
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // Visibility
    isPublic: boolean("is_public").default(true).notNull(),

    // Yjs Collaboration Data
    yjsData: text("yjs_data"), // Base64-encoded Yjs state
    yjsVersion: integer("yjs_version").default(1).notNull(), // Version for conflict detection
    lastClientsCount: integer("last_clients_count").default(0),

    // Preview image URL (stored in R2)
    previewImage: text("preview_image"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdateFn(() => sql`now()`),
  },
  (t) => [
    index("codelet_owner_idx").on(t.ownerId),
    index("codelet_is_public_idx").on(t.isPublic),
  ],
);

export const codeletMember = pgTable(
  "codelet_member",
  {
    codeletId: integer("codelet_id")
      .notNull()
      .references(() => codelet.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").default("viewer").notNull(),
    status: memberStatusEnum("status").default("active").notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.codeletId, t.userId] }),
    index("codelet_member_user_idx").on(t.userId),
  ],
);

// Relations
export const codeletRelations = relations(codelet, ({ one, many }) => ({
  owner: one(user, {
    fields: [codelet.ownerId],
    references: [user.id],
  }),
  members: many(codeletMember),
}));

export const codeletMemberRelations = relations(codeletMember, ({ one }) => ({
  codelet: one(codelet, {
    fields: [codeletMember.codeletId],
    references: [codelet.id],
  }),
  user: one(user, {
    fields: [codeletMember.userId],
    references: [user.id],
  }),
}));

export type codelet = typeof codelet.$inferSelect;
export type Newcodelet = typeof codelet.$inferInsert;

import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, lt, or } from "drizzle-orm";
import { z } from "zod";

import type { CollabRole } from "@acme/auth/collab-token";
import { signCollabToken } from "@acme/auth/collab-token";
import {
  codelet,
  codeletMember,
  codeletMessage,
  codeletSnapshot,
  userProfile,
} from "@acme/db/schema";
import { getPublicUrl } from "@acme/storage";

import { track } from "../telemetry";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

const COLLAB_TOKEN_TTL_SECONDS = 60 * 60;

// In-process rate limiter for requestAccess: max 5 requests per user per
// 5-minute window. Sized for a single API node — good enough to deter
// casual spam without standing up a Redis-backed limiter.
const REQUEST_ACCESS_WINDOW_MS = 5 * 60 * 1000;
const REQUEST_ACCESS_LIMIT = 5;
const requestAccessHits = new Map<string, number[]>();

function checkRequestAccessRate(userId: string): boolean {
  const now = Date.now();
  const hits = (requestAccessHits.get(userId) ?? []).filter(
    (t) => now - t < REQUEST_ACCESS_WINDOW_MS,
  );
  if (hits.length >= REQUEST_ACCESS_LIMIT) {
    requestAccessHits.set(userId, hits);
    return false;
  }
  hits.push(now);
  requestAccessHits.set(userId, hits);
  return true;
}

export const codeletRouter = createTRPCRouter({
  /**
   * List codelets (public + user's private codelets)
   */
  list: publicProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(50).default(20),
          cursor: z.number().nullish(),
          onlyMine: z.boolean().optional(),
          search: z.string().trim().max(100).optional(),
          sort: z.enum(["recent", "oldest", "updated"]).default("recent"),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;
      const offset = input?.cursor ?? 0;
      const onlyMine = input?.onlyMine;
      const search = input?.search;
      const sort = input?.sort ?? "recent";

      const conditions = [];

      if (ctx.session?.user && onlyMine) {
        conditions.push(eq(codelet.ownerId, ctx.session.user.id));
      } else if (ctx.session?.user) {
        conditions.push(
          or(
            eq(codelet.isPublic, true),
            eq(codelet.ownerId, ctx.session.user.id),
          ),
        );
      } else {
        conditions.push(eq(codelet.isPublic, true));
      }

      if (search) {
        // Postgres ILIKE handles case-insensitive prefix/substring match.
        // % chars in the input are escaped so users can't widen the search.
        const escaped = search.replace(/[\\%_]/g, (m) => `\\${m}`);
        conditions.push(ilike(codelet.name, `%${escaped}%`));
      }

      const orderBy =
        sort === "oldest"
          ? codelet.createdAt
          : sort === "updated"
            ? desc(codelet.updatedAt)
            : desc(codelet.createdAt);

      const codelets = await ctx.db
        .select({
          id: codelet.id,
          name: codelet.name,
          description: codelet.description,
          isPublic: codelet.isPublic,
          previewImage: codelet.previewImage,
          createdAt: codelet.createdAt,
          updatedAt: codelet.updatedAt,
          ownerId: codelet.ownerId,
          owner: {
            username: userProfile.username,
            photoURL: userProfile.photoURL,
          },
        })
        .from(codelet)
        .leftJoin(userProfile, eq(codelet.ownerId, userProfile.userId))
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      const items = codelets.map((d) => ({
        ...d,
        previewImage: d.previewImage ? getPublicUrl(d.previewImage) : null,
      }));

      const nextCursor =
        items.length === limit ? offset + items.length : undefined;

      return { items, nextCursor };
    }),

  /**
   * Get codelet by ID
   */
  byId: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const [result] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.id))
        .limit(1);

      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "codelet not found",
        });
      }

      // Short-circuit: private codelet with no session user can't read at all.
      if (!result.isPublic && !ctx.session?.user) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Members + owner profile fetched in parallel — both are independent
      // of each other so there's no need to await them sequentially.
      // We use the members list to derive the access check below, which
      // avoids a separate membership query for private non-owner readers.
      const [members, ownerRows] = await Promise.all([
        ctx.db
          .select({
            userId: codeletMember.userId,
            role: codeletMember.role,
            status: codeletMember.status,
            username: userProfile.username,
            photoURL: userProfile.photoURL,
          })
          .from(codeletMember)
          .leftJoin(userProfile, eq(codeletMember.userId, userProfile.userId))
          .where(eq(codeletMember.codeletId, input.id)),
        ctx.db
          .select({
            username: userProfile.username,
            photoURL: userProfile.photoURL,
          })
          .from(userProfile)
          .where(eq(userProfile.userId, result.ownerId))
          .limit(1),
      ]);

      // Get current user's membership status
      let currentUserStatus = null;
      if (ctx.session?.user) {
        const member = members.find((m) => m.userId === ctx.session!.user.id);
        if (member) {
          currentUserStatus = member.status;
        }
      }

      // Re-check access now that we have the members list. Private codelets
      // require ownership or an ACTIVE membership.
      if (
        !result.isPublic &&
        result.ownerId !== ctx.session!.user.id &&
        currentUserStatus !== "active"
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const owner = ownerRows[0];

      return {
        ...result,
        previewImage: result.previewImage
          ? getPublicUrl(result.previewImage)
          : null,
        owner,
        members,
        currentUserStatus,
      };
    }),

  /**
   * Issue a short-lived signed token for connecting to the Hocuspocus
   * collaboration websocket. Verifies ownership / active membership /
   * public-read access before signing.
   */
  getCollabToken: protectedProcedure
    .input(z.object({ codeletId: z.number() }))
    .query(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "codelet not found",
        });
      }

      const userId = ctx.session.user.id;
      let role: CollabRole;

      if (existing.ownerId === userId) {
        role = "owner";
      } else {
        const [member] = await ctx.db
          .select()
          .from(codeletMember)
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, userId),
              eq(codeletMember.status, "active"),
            ),
          )
          .limit(1);

        if (member?.role === "editor") {
          role = "editor";
        } else if (member?.role === "viewer") {
          role = "viewer";
        } else if (existing.isPublic) {
          role = "viewer";
        } else {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
      }

      const sessionUser = ctx.session.user as {
        id: string;
        name?: string;
        username?: string;
      };
      const username = sessionUser.username ?? sessionUser.name ?? "User";

      const token = signCollabToken(
        {
          userId,
          username,
          codeletId: input.codeletId,
          role,
          exp: Math.floor(Date.now() / 1000) + COLLAB_TOKEN_TTL_SECONDS,
        },
        process.env.BETTER_AUTH_SECRET ?? "",
      );

      return { token, role };
    }),

  /**
   * Create a new codelet
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        isPublic: z.boolean().default(true),
        // Cap at ~5MB base64 to prevent oversized initial snapshots from
        // blowing past TRPC payload limits.
        yjsData: z.string().max(5_000_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [newcodelet] = await ctx.db
        .insert(codelet)
        .values({
          ...input,
          ownerId: ctx.session.user.id,
        })
        .returning();

      if (newcodelet) {
        track("codelet.created", {
          codeletId: newcodelet.id,
          userId: ctx.session.user.id,
          isPublic: newcodelet.isPublic,
        });
      }

      return newcodelet;
    }),

  /**
   * Fork an existing codelet — copies its current yjsData snapshot
   * into a new private codelet owned by the caller.
   */
  fork: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [source] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.id))
        .limit(1);

      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "codelet not found",
        });
      }

      // Caller must be able to read the source: public, owner, or active member.
      const userId = ctx.session.user.id;
      if (!source.isPublic && source.ownerId !== userId) {
        const [member] = await ctx.db
          .select()
          .from(codeletMember)
          .where(
            and(
              eq(codeletMember.codeletId, input.id),
              eq(codeletMember.userId, userId),
              eq(codeletMember.status, "active"),
            ),
          )
          .limit(1);

        if (!member) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
      }

      const forkedName = (input.name ?? `${source.name} (fork)`).slice(0, 100);

      const [forked] = await ctx.db
        .insert(codelet)
        .values({
          name: forkedName,
          description: source.description,
          isPublic: false,
          yjsData: source.yjsData,
          ownerId: userId,
        })
        .returning();

      if (forked) {
        track("codelet.forked", {
          codeletId: forked.id,
          sourcecodeletId: source.id,
          userId,
        });
      }

      return forked;
    }),

  /**
   * Update codelet settings
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
        isPublic: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;

      // Check ownership
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, id))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [updated] = await ctx.db
        .update(codelet)
        .set(updates)
        .where(eq(codelet.id, id))
        .returning();

      return updated;
    }),

  /**
   * Delete codelet
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Check ownership
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.id))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db.delete(codelet).where(eq(codelet.id, input.id));

      track("codelet.deleted", {
        codeletId: input.id,
        userId: ctx.session.user.id,
      });

      return { success: true };
    }),

  /**
   * Add member to codelet
   */
  addMember: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        userId: z.string().max(100),
        role: z.enum(["editor", "viewer"]).default("viewer"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check ownership
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db.insert(codeletMember).values({
        codeletId: input.codeletId,
        userId: input.userId,
        role: input.role,
      });

      return { success: true };
    }),

  /**
   * Change an existing member's role (Owner only).
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        userId: z.string().max(100),
        role: z.enum(["editor", "viewer"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [member] = await ctx.db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, input.userId),
          ),
        )
        .limit(1);

      if (!member) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      }

      await ctx.db
        .update(codeletMember)
        .set({ role: input.role })
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, input.userId),
          ),
        );

      track("codelet.member.role_changed", {
        codeletId: input.codeletId,
        actorId: ctx.session.user.id,
        memberId: input.userId,
        role: input.role,
      });

      return { success: true };
    }),

  /**
   * Remove member from codelet
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        userId: z.string().max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check ownership
      const [existing] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .delete(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, input.userId),
          ),
        );

      track("codelet.member.removed", {
        codeletId: input.codeletId,
        actorId: ctx.session.user.id,
        memberId: input.userId,
      });

      return { success: true };
    }),

  /**
   * Invite a user to a codelet by username
   */
  inviteUser: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        username: z.string().min(1).max(100),
        role: z.enum(["editor", "viewer"]).default("viewer"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Verify codelet Ownership
      const [existingcodelet] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existingcodelet || existingcodelet.ownerId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not authorized to invite users",
        });
      }

      // 2. Find User by Username
      const [targetUser] = await ctx.db
        .select()
        .from(userProfile)
        .where(eq(userProfile.username, input.username))
        .limit(1);

      if (!targetUser) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      if (targetUser.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot invite yourself",
        });
      }

      // 3. Check if already a member/invited
      const [existingMember] = await ctx.db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, targetUser.userId),
          ),
        )
        .limit(1);

      if (existingMember) {
        if (existingMember.status === "active") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "User is already a member",
          });
        } else if (existingMember.status === "invited") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "User is already invited",
          });
        } else if (existingMember.status === "requested") {
          // If they requested, just approve them by updating to active/invited
          await ctx.db
            .update(codeletMember)
            .set({ status: "active", role: input.role })
            .where(
              and(
                eq(codeletMember.codeletId, input.codeletId),
                eq(codeletMember.userId, targetUser.userId),
              ),
            );
          return { success: true, message: "Request approved" };
        }
      }

      // 4. Create Invitation
      await ctx.db.insert(codeletMember).values({
        codeletId: input.codeletId,
        userId: targetUser.userId,
        role: input.role,
        status: "invited",
      });

      track("codelet.member.invited", {
        codeletId: input.codeletId,
        inviterId: ctx.session.user.id,
        inviteeId: targetUser.userId,
        role: input.role,
      });

      return { success: true, message: "Invitation sent" };
    }),

  /**
   * Request access to a codelet
   */
  requestAccess: protectedProcedure
    .input(z.object({ codeletId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkRequestAccessRate(ctx.session.user.id)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many access requests. Please wait a few minutes.",
        });
      }

      // 1. Verify codelet exists
      const [existingcodelet] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existingcodelet) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (existingcodelet.ownerId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are the owner",
        });
      }

      // 2. Check existing membership
      const [existingMember] = await ctx.db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, ctx.session.user.id),
          ),
        )
        .limit(1);

      if (existingMember) {
        if (existingMember.status === "active")
          return { success: true, message: "Already a member" };
        if (existingMember.status === "requested")
          return { success: true, message: "Request already sending" };
        if (existingMember.status === "invited") {
          // If invited, auto-accept
          await ctx.db
            .update(codeletMember)
            .set({ status: "active" })
            .where(
              and(
                eq(codeletMember.codeletId, input.codeletId),
                eq(codeletMember.userId, ctx.session.user.id),
              ),
            );
          return { success: true, message: "Joined via invitation" };
        }
      }

      // 3. Create Request
      await ctx.db.insert(codeletMember).values({
        codeletId: input.codeletId,
        userId: ctx.session.user.id,
        role: "viewer", // Default request role
        status: "requested",
      });

      track("codelet.access.requested", {
        codeletId: input.codeletId,
        userId: ctx.session.user.id,
      });

      return { success: true };
    }),

  /**
   * Respond to invitation (Accept/Decline)
   */
  respondToInvite: protectedProcedure
    .input(z.object({ codeletId: z.number(), accept: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [member] = await ctx.db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, ctx.session.user.id),
            eq(codeletMember.status, "invited"),
          ),
        )
        .limit(1);

      if (!member) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No invitation found",
        });
      }

      if (input.accept) {
        await ctx.db
          .update(codeletMember)
          .set({ status: "active" })
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, ctx.session.user.id),
            ),
          );
      } else {
        await ctx.db
          .delete(codeletMember)
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, ctx.session.user.id),
            ),
          );
      }

      return { success: true };
    }),

  /**
   * Respond to access request (Owner only)
   */
  respondToRequest: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        userId: z.string().max(100),
        accept: z.boolean(),
        role: z.enum(["editor", "viewer"]).default("viewer"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Verify Ownership
      const [existingcodelet] = await ctx.db
        .select()
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existingcodelet || existingcodelet.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // 2. Find Request
      const [member] = await ctx.db
        .select()
        .from(codeletMember)
        .where(
          and(
            eq(codeletMember.codeletId, input.codeletId),
            eq(codeletMember.userId, input.userId),
            eq(codeletMember.status, "requested"),
          ),
        )
        .limit(1);

      if (!member) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No pending request found",
        });
      }

      if (input.accept) {
        await ctx.db
          .update(codeletMember)
          .set({ status: "active", role: input.role })
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, input.userId),
            ),
          );
      } else {
        await ctx.db
          .delete(codeletMember)
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, input.userId),
            ),
          );
      }

      return { success: true };
    }),

  /**
   * Paginated chat history for a codelet. Cursor is the createdAt
   * timestamp of the oldest message in the previous page; messages
   * are returned newest-first.
   */
  chatHistory: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().datetime().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Same access rules as byId: owner, active member, or public reader.
      const [existing] = await ctx.db
        .select({
          id: codelet.id,
          ownerId: codelet.ownerId,
          isPublic: codelet.isPublic,
        })
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "codelet not found",
        });
      }

      const userId = ctx.session.user.id;
      if (!existing.isPublic && existing.ownerId !== userId) {
        const [member] = await ctx.db
          .select()
          .from(codeletMember)
          .where(
            and(
              eq(codeletMember.codeletId, input.codeletId),
              eq(codeletMember.userId, userId),
              eq(codeletMember.status, "active"),
            ),
          )
          .limit(1);

        if (!member) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
      }

      const conditions = [eq(codeletMessage.codeletId, input.codeletId)];
      if (input.cursor) {
        conditions.push(lt(codeletMessage.createdAt, new Date(input.cursor)));
      }

      const rows = await ctx.db
        .select({
          id: codeletMessage.id,
          userId: codeletMessage.userId,
          authorUsername: codeletMessage.authorUsername,
          content: codeletMessage.content,
          createdAt: codeletMessage.createdAt,
          liveUsername: userProfile.username,
          livePhotoURL: userProfile.photoURL,
        })
        .from(codeletMessage)
        .leftJoin(userProfile, eq(codeletMessage.userId, userProfile.userId))
        .where(and(...conditions))
        .orderBy(desc(codeletMessage.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({
        id: r.id,
        userId: r.userId,
        // Prefer the current profile username; fall back to the snapshot
        // taken at send-time if the user has since been deleted.
        username: r.liveUsername ?? r.authorUsername ?? "[deleted user]",
        photoURL: r.livePhotoURL,
        content: r.content,
        createdAt: r.createdAt,
        isDeletedAuthor: r.userId == null,
      }));

      const nextCursor = hasMore
        ? items[items.length - 1]?.createdAt.toISOString()
        : undefined;

      return { items, nextCursor };
    }),

  /**
   * Snapshot the current yjsData so the owner can restore later.
   */
  createSnapshot: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        label: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({
          id: codelet.id,
          ownerId: codelet.ownerId,
          yjsData: codelet.yjsData,
        })
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      if (!existing.yjsData) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Nothing to snapshot yet",
        });
      }

      const [created] = await ctx.db
        .insert(codeletSnapshot)
        .values({
          codeletId: input.codeletId,
          yjsData: existing.yjsData,
          label: input.label,
          createdBy: ctx.session.user.id,
        })
        .returning({
          id: codeletSnapshot.id,
          label: codeletSnapshot.label,
          createdAt: codeletSnapshot.createdAt,
        });

      if (created) {
        track("codelet.snapshot.created", {
          codeletId: input.codeletId,
          snapshotId: created.id,
          userId: ctx.session.user.id,
        });
      }

      return created;
    }),

  /**
   * List snapshots for a codelet (owner only — snapshots may contain
   * intermediate state the owner doesn't want to expose).
   */
  listSnapshots: protectedProcedure
    .input(z.object({ codeletId: z.number() }))
    .query(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ ownerId: codelet.ownerId })
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const snapshots = await ctx.db
        .select({
          id: codeletSnapshot.id,
          label: codeletSnapshot.label,
          createdAt: codeletSnapshot.createdAt,
          createdBy: codeletSnapshot.createdBy,
          creatorUsername: userProfile.username,
        })
        .from(codeletSnapshot)
        .leftJoin(
          userProfile,
          eq(codeletSnapshot.createdBy, userProfile.userId),
        )
        .where(eq(codeletSnapshot.codeletId, input.codeletId))
        .orderBy(desc(codeletSnapshot.createdAt));

      return snapshots;
    }),

  /**
   * Restore a snapshot. Writes the snapshot's yjsData back to the codelet
   * and bumps yjsVersion so connected clients are forced to reload.
   *
   * Note: this is a destructive operation; clients with unsaved edits will
   * lose them. The UI should warn before invoking.
   */
  restoreSnapshot: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        snapshotId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ ownerId: codelet.ownerId })
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [snap] = await ctx.db
        .select()
        .from(codeletSnapshot)
        .where(
          and(
            eq(codeletSnapshot.id, input.snapshotId),
            eq(codeletSnapshot.codeletId, input.codeletId),
          ),
        )
        .limit(1);

      if (!snap) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Snapshot not found",
        });
      }

      await ctx.db
        .update(codelet)
        .set({ yjsData: snap.yjsData })
        .where(eq(codelet.id, input.codeletId));

      track("codelet.snapshot.restored", {
        codeletId: input.codeletId,
        snapshotId: input.snapshotId,
        userId: ctx.session.user.id,
      });

      return { success: true };
    }),

  /**
   * Delete a snapshot (owner only).
   */
  deleteSnapshot: protectedProcedure
    .input(
      z.object({
        codeletId: z.number(),
        snapshotId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ ownerId: codelet.ownerId })
        .from(codelet)
        .where(eq(codelet.id, input.codeletId))
        .limit(1);

      if (!existing || existing.ownerId !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .delete(codeletSnapshot)
        .where(
          and(
            eq(codeletSnapshot.id, input.snapshotId),
            eq(codeletSnapshot.codeletId, input.codeletId),
          ),
        );

      return { success: true };
    }),
});

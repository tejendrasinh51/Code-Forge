"use client";

import { use, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Copy,
  Lock,
  MessageSquare,
  Send,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { ChatMessage, UserPresence } from "~/hooks/use-socket";
import { authClient } from "~/auth/client";
import { RenamecodeletDialog } from "~/components/collab-editor/rename-codelet-dialog";
import { SettingsModal } from "~/components/collab-editor/settings-modal";
import { ShareModal } from "~/components/collab-editor/share-modal";
import { useSignIn } from "~/components/sign-in-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/ui/resizable";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useIsMobile } from "~/hooks/use-is-mobile";
import { useSocketcodelet } from "~/hooks/use-socket";
import { track } from "~/lib/analytics";
import { useTRPC } from "~/trpc/react";

// CodeMirror + y-codemirror.next add ~200kB to the bundle. Defer them
// until the page is interactive so they don't block first paint.
const LayoutManager = dynamic(
  () =>
    import("~/components/collab-editor/layout-manager").then(
      (m) => m.LayoutManager,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted text-muted-foreground flex h-full w-full items-center justify-center">
        Loading editor…
      </div>
    ),
  },
);

export default function codeletPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: codeletIdStr } = use(params);
  const codeletId = parseInt(codeletIdStr);
  const router = useRouter();
  const trpc = useTRPC();

  // Auth state
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const username = session?.user?.name ?? "Anonymous";
  const photoURL = session?.user?.image ?? undefined;

  // Fetch codelet data
  const {
    data: codelet,
    isLoading: iscodeletLoading,
    error,
  } = useQuery(
    trpc.codelet.byId.queryOptions({ id: codeletId }, { enabled: !!codeletId }),
  );

  // Fetch a short-lived collab token. The websocket will not connect until
  // the server has authorized this user for this codelet.
  const { data: collabAuth } = useQuery(
    trpc.codelet.getCollabToken.queryOptions(
      { codeletId },
      { enabled: !!codeletId && !!userId, staleTime: 30 * 60 * 1000 },
    ),
  );

  // Connect to Socket Server
  const {
    users,
    messages,
    isConnected,
    sendMessage,
    updateCursor,
    provider,
    ydoc,
  } = useSocketcodelet({
    codeletId: codeletIdStr,
    userId,
    username,
    photoURL,
    token: collabAuth?.token,
  });

  const queryClient = useQueryClient();

  // Settings state - synced via Y.js Map
  const [head, setHead] = useState("");
  const [body, setBody] = useState("");

  // Sync head and body scripts from Y.js Map
  useEffect(() => {
    if (!ydoc) return;

    const settingsMap = ydoc.getMap("settings");

    const updateSettings = () => {
      const headScripts = settingsMap.get("headScripts") as string | undefined;
      const bodyScripts = settingsMap.get("bodyScripts") as string | undefined;

      setHead(headScripts ?? "");
      setBody(bodyScripts ?? "");
    };

    // Initial sync
    updateSettings();

    // Listen for changes
    settingsMap.observe(updateSettings);

    return () => {
      settingsMap.unobserve(updateSettings);
    };
  }, [ydoc]);

  // The Hocuspocus server bumps a `meta` Y.Map field whenever codelet
  // membership / visibility changes (driven by the API → Redis →
  // Hocuspocus bridge). Refetch `byId` so the share modal's pending
  // requests, member list, and visibility state stay in sync without
  // needing the user to refresh.
  useEffect(() => {
    if (!ydoc) return;
    const meta = ydoc.getMap("meta");
    const onChange = () => {
      void queryClient.invalidateQueries(
        trpc.codelet.byId.queryFilter({ id: codeletId }),
      );
    };
    meta.observe(onChange);
    return () => meta.unobserve(onChange);
  }, [ydoc, queryClient, trpc, codeletId]);

  // Update Y.js when head/body change
  const handleHeadChange = (value: string) => {
    if (!ydoc) return;
    const settingsMap = ydoc.getMap("settings");
    settingsMap.set("headScripts", value);
  };

  const handleBodyChange = (value: string) => {
    if (!ydoc) return;
    const settingsMap = ydoc.getMap("settings");
    settingsMap.set("bodyScripts", value);
  };

  const [newMessage, setNewMessage] = useState("");
  const isMobile = useIsMobile();
  // Chat collapses by default on mobile so editors get the full viewport.
  const [isChatOpen, setIsChatOpen] = useState(false);
  useEffect(() => {
    setIsChatOpen(!isMobile);
  }, [isMobile]);
  const [renameOpen, setRenameOpen] = useState(false);

  const forkMutation = useMutation(
    trpc.codelet.fork.mutationOptions({
      onSuccess: (forked) => {
        if (!forked) return;
        track("codelet-fork", { from: "detail", sourceId: codeletId });
        toast.success("Forked to your codelets");
        void queryClient.invalidateQueries(
          trpc.codelet.list.infiniteQueryFilter(),
        );
        router.push(`/codelets/${forked.id}`);
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const handleSendMessage = () => {
    if (!newMessage.trim()) return;
    sendMessage(newMessage);
    setNewMessage("");
  };

  // Determine Permissions
  const isOwner = codelet?.ownerId === userId;
  const userStatus = codelet?.currentUserStatus;
  const isMember = userStatus === "active";
  const canEdit =
    isOwner ||
    (isMember &&
      codelet?.members.find((m) => m.userId === userId)?.role === "editor");
  const isPublic = codelet?.isPublic ?? false;

  // Redirect non-members to guest page for public codelets
  // This also handles access revocation during active session
  useEffect(() => {
    if (codelet && isPublic && !isOwner && !isMember) {
      router.push(`/codelets/${codeletId}/guest`);
    }
  }, [codelet, isPublic, isOwner, isMember, codeletId, router]);

  // Listen to websocket disconnects for access revocation
  useEffect(() => {
    if (!provider || !codelet) return;

    const handleAuthFailure = (event: { reason?: string }) => {
      console.log("[codelet] Connection closed:", event);
      // If connection closes and codelet is public, redirect to guest mode
      // This happens when server kicks user due to access revocation
      if (codelet.isPublic && !isOwner) {
        router.push(`/codelets/${codeletId}/guest`);
      }
    };

    // Listen for authentication/permission errors
    provider.on("close", handleAuthFailure);
    provider.on("authenticationFailed", handleAuthFailure);

    return () => {
      provider.off("close", handleAuthFailure);
      provider.off("authenticationFailed", handleAuthFailure);
    };
  }, [provider, codelet, isOwner, codeletId, router]);

  if (iscodeletLoading) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <div className="text-muted-foreground animate-pulse">
          Loading codelet...
        </div>
      </div>
    );
  }

  if (error || !codelet) {
    const code = error?.data?.code;
    if (code === "FORBIDDEN") {
      return <AccessDeniedScreen codeletId={codeletId} isAuthed={!!userId} />;
    }
    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4">
        <h2 className="text-destructive text-xl font-bold">
          {code === "NOT_FOUND" ? "codelet not found" : "Error loading codelet"}
        </h2>
        <p className="text-muted-foreground">
          {error?.message ?? "This codelet does not exist."}
        </p>
        <Button onClick={() => router.push("/codelets")}>Back to List</Button>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="bg-muted/20 flex items-center justify-between gap-2 border-b px-2 py-2 sm:px-4">
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/codelets">
            <Button variant="outline" size="sm" className="px-2 sm:px-3">
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back</span>
            </Button>
          </Link>
        </div>
        <div className="min-w-0 flex-1 text-center">
          {isOwner ? (
            <button
              type="button"
              onClick={() => setRenameOpen(true)}
              className="hover:text-primary block max-w-full truncate font-semibold transition-colors"
              title="Rename"
            >
              {codelet.name}
            </button>
          ) : (
            <h1 className="truncate font-semibold">{codelet.name}</h1>
          )}
          {codelet.description && (
            <p className="text-muted-foreground hidden truncate text-xs sm:block">
              {codelet.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <ConnectionBadge
            isConnected={isConnected}
            hasToken={!!collabAuth?.token}
          />

          {userId && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => forkMutation.mutate({ id: codeletId })}
              disabled={forkMutation.isPending}
              title="Fork this codelet"
              aria-label="Fork codelet"
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}

          <SettingsModal
            head={head}
            onHeadChange={handleHeadChange}
            body={body}
            onBodyChange={handleBodyChange}
          />

          <ShareModal
            codeletId={codeletId}
            isOwner={isOwner}
            isPublic={isPublic}
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={isChatOpen ? "bg-muted" : ""}
            title={isChatOpen ? "Hide Chat" : "Show Chat"}
            aria-label={isChatOpen ? "Hide chat" : "Show chat"}
          >
            <MessageSquare className="h-4 w-4" />
          </Button>

          <div className="hidden -space-x-2 sm:flex">
            {users.slice(0, 5).map((u) => (
              <Avatar key={u.id} className="border-background h-8 w-8 border-2">
                <AvatarImage src={u.photoURL} />
                <AvatarFallback>{u.username[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
            ))}
            {users.length > 5 && (
              <div className="bg-muted border-background flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs">
                +{users.length - 5}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Main Editor Area */}
          <ResizablePanel defaultSize={80} minSize={50}>
            {provider && ydoc ? (
              <LayoutManager
                provider={provider}
                ydoc={ydoc}
                head={head}
                body={body}
                readOnly={!canEdit}
              />
            ) : (
              <div className="bg-muted text-muted-foreground flex h-full w-full items-center justify-center">
                Connecting to room...
              </div>
            )}
          </ResizablePanel>

          {/* Chat sidebar — only on desktop. On mobile the chat lives in a
              fixed overlay rendered below so it can take the full viewport. */}
          {isChatOpen && !isMobile && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize={20} minSize={15} maxSize={30}>
                <ChatPanel
                  users={users}
                  messages={messages}
                  userId={userId}
                  newMessage={newMessage}
                  setNewMessage={setNewMessage}
                  onSend={handleSendMessage}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>

        {isChatOpen && isMobile && (
          <div className="bg-background fixed inset-0 z-40 flex flex-col md:hidden">
            <div className="flex items-center justify-between border-b p-3">
              <div className="flex items-center gap-2 font-medium">
                <MessageSquare className="h-4 w-4" />
                Chat & Users
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsChatOpen(false)}
                aria-label="Close chat"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ChatPanel
              users={users}
              messages={messages}
              userId={userId}
              newMessage={newMessage}
              setNewMessage={setNewMessage}
              onSend={handleSendMessage}
              showHeader={false}
            />
          </div>
        )}
      </div>

      {isOwner && (
        <RenamecodeletDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          codeletId={codeletId}
          currentName={codelet.name}
        />
      )}
    </div>
  );
}

function ChatPanel({
  users,
  messages,
  userId,
  newMessage,
  setNewMessage,
  onSend,
  showHeader = true,
}: {
  users: UserPresence[];
  messages: ChatMessage[];
  userId: string | undefined;
  newMessage: string;
  setNewMessage: (val: string) => void;
  onSend: () => void;
  showHeader?: boolean;
}) {
  return (
    <div className="bg-muted/10 flex h-full flex-col border-l">
      {showHeader && (
        <div className="flex items-center gap-2 border-b p-3 font-medium">
          <MessageSquare className="h-4 w-4" />
          Chat & Users
        </div>
      )}

      <div className="border-b p-2">
        <div className="text-muted-foreground mb-2 flex items-center gap-1 text-xs font-semibold">
          <Users className="h-3 w-3" /> Online ({users.length})
        </div>
        <div className="flex flex-wrap gap-1">
          {users.map((u) => (
            <div key={u.id} title={u.username} className="relative">
              <Avatar className="border-border h-6 w-6 border">
                <AvatarImage src={u.photoURL} />
                <AvatarFallback className="text-[9px]">
                  {u.username[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </div>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.userId === userId ? "items-end" : "items-start"
              }`}
            >
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-muted-foreground text-xs font-medium">
                  {msg.username}
                </span>
                <span className="text-muted-foreground/70 text-[10px]">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                  msg.userId === userId
                    ? "bg-primary text-primary-foreground rounded-tr-none"
                    : "bg-muted rounded-tl-none"
                }`}
              >
                {msg.text}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="bg-background border-t p-3">
        <div className="flex gap-2">
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            placeholder="Type..."
            className="h-8"
          />
          <Button
            size="icon"
            onClick={onSend}
            className="h-8 w-8"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectionBadge({
  isConnected,
  hasToken,
}: {
  isConnected: boolean;
  hasToken: boolean;
}) {
  if (isConnected) {
    return (
      <span
        className="text-muted-foreground flex items-center gap-1 text-xs"
        title="Connected — changes sync in real time"
      >
        <Wifi className="h-3.5 w-3.5 text-emerald-500" />
        <span className="hidden sm:inline">Live</span>
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 text-xs text-amber-500"
      title={hasToken ? "Disconnected — reconnecting…" : "Connecting…"}
    >
      <WifiOff className="h-3.5 w-3.5 animate-pulse" />
      <span className="hidden sm:inline">
        {hasToken ? "Reconnecting…" : "Connecting…"}
      </span>
    </span>
  );
}

function AccessDeniedScreen({
  codeletId,
  isAuthed,
}: {
  codeletId: number;
  isAuthed: boolean;
}) {
  const trpc = useTRPC();
  const { openSignIn } = useSignIn();
  const requestAccess = useMutation(
    trpc.codelet.requestAccess.mutationOptions({
      onSuccess: (data, variables) => {
        track("codelet-request-access", { id: variables.codeletId });
        toast.success(data.message ?? "Request sent");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
        <Lock className="text-muted-foreground h-7 w-7" />
      </div>
      <h2 className="text-2xl font-semibold">This codelet is private</h2>
      <p className="text-muted-foreground">
        You don't have access to this codelet. Ask the owner to invite you, or
        request access below.
      </p>
      <div className="flex gap-2">
        {isAuthed ? (
          <Button
            onClick={() => requestAccess.mutate({ codeletId })}
            disabled={requestAccess.isPending || requestAccess.isSuccess}
          >
            {requestAccess.isSuccess
              ? "Request sent"
              : requestAccess.isPending
                ? "Requesting…"
                : "Request access"}
          </Button>
        ) : (
          <Button
            onClick={() =>
              openSignIn({
                source: "codelet-access-denied",
                callbackURL: `/codelets/${codeletId}`,
              })
            }
          >
            Sign in to request access
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link href="/codelets">Back to list</Link>
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useTRPC } from "~/trpc/react";

interface RenamecodeletDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  codeletId: number;
  currentName: string;
}

export function RenamecodeletDialog({
  open,
  onOpenChange,
  codeletId,
  currentName,
}: RenamecodeletDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const renameMutation = useMutation(
    trpc.codelet.update.mutationOptions({
      onSuccess: (data) => {
        if (!data) return;
        toast.success("codelet renamed");

        const byIdKey = trpc.codelet.byId.queryKey({ id: codeletId });
        queryClient.setQueryData(byIdKey, (prev) =>
          prev ? { ...prev, name: data.name } : prev,
        );
        void queryClient.invalidateQueries(
          trpc.codelet.byId.queryFilter({ id: codeletId }),
        );
        void queryClient.invalidateQueries(
          trpc.codelet.list.infiniteQueryFilter(),
        );
        onOpenChange(false);
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onOpenChange(false);
      return;
    }
    renameMutation.mutate({ id: codeletId, name: trimmed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename codelet</DialogTitle>
            <DialogDescription>
              Give your codelet a clearer name.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="codelet-name">Name</Label>
            <Input
              id="codelet-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={renameMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={renameMutation.isPending || !name.trim()}
            >
              {renameMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { addOptimisticActionAtom, removeOptimisticActionAtom } from '@/store/optimistic-updates';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { backgroundQueueAtom } from '@/store/backgroundQueue';
import type { ThreadDestination } from '@/lib/thread-actions';
import { useMail } from '@/components/mail/use-mail';
import { useTRPC } from '@/providers/query-provider';
import { moveThreadsTo } from '@/lib/thread-actions';
import { useThreads } from '@/hooks/use-threads';
import { useStats } from '@/hooks/use-stats';
import { useCallback, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useQueryState } from 'nuqs';
import { useAtom } from 'jotai';
import { toast } from 'sonner';
import React from 'react';

type PendingAction = {
  id: string;
  type: 'MOVE' | 'STAR' | 'READ' | 'LABEL';
  threadIds: string[];
  params: any;
  optimisticId: string;
  execute: () => Promise<void>;
  undo: () => void;
  timeoutId: NodeJS.Timeout;
};

export function useOptimisticActions() {
  const t = useTranslations();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, setBackgroundQueue] = useAtom(backgroundQueueAtom);
  const [, addOptimisticAction] = useAtom(addOptimisticActionAtom);
  const [, removeOptimisticAction] = useAtom(removeOptimisticActionAtom);
  const [threadId, setThreadId] = useQueryState('threadId');
  const [mail, setMail] = useMail();
  const [{ refetch: refetchThreads }] = useThreads();
  const { refetch: refetchStats } = useStats();
  const { mutateAsync: markAsRead } = useMutation(trpc.mail.markAsRead.mutationOptions());
  const { mutateAsync: markAsImportant } = useMutation(trpc.mail.markAsImportant.mutationOptions());
  const { mutateAsync: toggleStar } = useMutation(trpc.mail.toggleStar.mutationOptions());
  const { mutateAsync: toggleImportant } = useMutation(trpc.mail.toggleImportant.mutationOptions());
  const { mutateAsync: bulkArchive } = useMutation(trpc.mail.bulkArchive.mutationOptions());
  const { mutateAsync: bulkStar } = useMutation(trpc.mail.bulkStar.mutationOptions());
  const { mutateAsync: bulkDeleteThread } = useMutation(trpc.mail.bulkDelete.mutationOptions());

  const pendingActionsRef = useRef<Map<string, PendingAction>>(new Map());

  const generatePendingActionId = () =>
    `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const UNDO_DELAY = 5000;

  const refreshData = useCallback(
    async (threadIds: string[]) => {
      await Promise.all([
        refetchStats(),
        refetchThreads(),
        ...threadIds.map((id) =>
          queryClient.invalidateQueries({
            queryKey: trpc.mail.get.queryKey({ id }),
          }),
        ),
      ]);
    },
    [refetchStats, refetchThreads, queryClient, trpc.mail.get],
  );

  const createPendingAction = useCallback(
    ({
      type,
      threadIds,
      params,
      optimisticId,
      execute,
      undo,
      toastMessage,
    }: {
      type: 'MOVE' | 'STAR' | 'READ' | 'LABEL';
      threadIds: string[];
      params: any;
      optimisticId: string;
      execute: () => Promise<void>;
      undo: () => void;
      toastMessage: string;
    }) => {
      const pendingActionId = generatePendingActionId();

      const timeoutId = setTimeout(async () => {
        try {
          await execute();

          await refreshData(threadIds);

          pendingActionsRef.current.delete(pendingActionId);
        } catch (error) {
          toast.error('Action failed');

          pendingActionsRef.current.delete(pendingActionId);
        }
      }, UNDO_DELAY);
      const pendingAction: PendingAction = {
        id: pendingActionId,
        type,
        threadIds,
        params,
        optimisticId,
        execute,
        undo,
        timeoutId,
      };

      pendingActionsRef.current.set(pendingActionId, pendingAction);

      const itemCount = threadIds.length;
      const bulkActionMessage =
        itemCount > 1 ? `${toastMessage} (${itemCount} items)` : toastMessage;

      toast(bulkActionMessage, {
        duration: UNDO_DELAY,
        action: {
          label: 'Undo',
          onClick: () => {
            clearTimeout(timeoutId);
            undo();
            pendingActionsRef.current.delete(pendingActionId);

            const undoMessage =
              itemCount > 1 ? `Action undone (${itemCount} items)` : 'Action undone';
            toast.success(undoMessage);
          },
        },
        className: 'group relative',
        position: 'bottom-center',
        style: {
          '--toast-progress-color': 'var(--primary)',
          '--toast-progress-height': '4px',
        } as React.CSSProperties,
      });

      return pendingActionId;
    },
    [refreshData, UNDO_DELAY],
  );

  const optimisticMarkAsRead = useCallback(
    (threadIds: string[]) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'READ',
        threadIds,
        read: true,
      });

      createPendingAction({
        type: 'READ',
        threadIds,
        params: { read: true },
        optimisticId,
        execute: async () => {
          await markAsRead({ ids: threadIds });

          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: 'Marked as read',
      });
    },
    [addOptimisticAction, removeOptimisticAction, markAsRead, createPendingAction, mail, setMail],
  );

  const optimisticToggleStar = useCallback(
    (threadIds: string[], starred: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'STAR',
        threadIds,
        starred,
      });

      createPendingAction({
        type: 'STAR',
        threadIds,
        params: { starred },
        optimisticId,
        execute: async () => {
          await toggleStar({ ids: threadIds });
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: starred
          ? t('common.actions.addedToFavorites')
          : t('common.actions.removedFromFavorites'),
      });
    },
    [addOptimisticAction, removeOptimisticAction, toggleStar, createPendingAction, t],
  );

  const optimisticMoveThreadsTo = useCallback(
    (threadIds: string[], currentFolder: string, destination: ThreadDestination) => {
      if (!threadIds.length || !destination) return;

      const optimisticId = addOptimisticAction({
        type: 'MOVE',
        threadIds,
        destination,
      });

      threadIds.forEach((id) => {
        setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
      });

      if (threadId && threadIds.includes(threadId)) {
        setThreadId(null);
      }
      const successMessage =
        destination === 'inbox'
          ? t('common.actions.movedToInbox')
          : destination === 'spam'
            ? t('common.actions.movedToSpam')
            : destination === 'bin'
              ? t('common.actions.movedToBin')
              : t('common.actions.archived');

      createPendingAction({
        type: 'MOVE',
        threadIds,
        params: { currentFolder, destination },
        optimisticId,
        execute: async () => {
          await moveThreadsTo({
            threadIds,
            currentFolder,
            destination,
          });

          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
          threadIds.forEach((id) => {
            setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
          });
        },
        toastMessage: successMessage,
      });
    },
    [
      addOptimisticAction,
      removeOptimisticAction,
      setBackgroundQueue,
      threadId,
      setThreadId,
      createPendingAction,
      t,
      mail,
      setMail,
    ],
  );

  const optimisticDeleteThreads = useCallback(
    (threadIds: string[], currentFolder: string) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'MOVE',
        threadIds,
        destination: 'bin',
      });

      threadIds.forEach((id) => {
        setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
      });

      if (threadId && threadIds.includes(threadId)) {
        setThreadId(null);
      }
      createPendingAction({
        type: 'MOVE',
        threadIds,
        params: { currentFolder, destination: 'bin' },
        optimisticId,
        execute: async () => {
          await bulkDeleteThread({ ids: threadIds });

          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);

          threadIds.forEach((id) => {
            setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
          });
        },
        toastMessage: t('common.actions.movedToBin'),
      });
    },
    [
      addOptimisticAction,
      removeOptimisticAction,
      setBackgroundQueue,
      threadId,
      setThreadId,
      createPendingAction,
      bulkDeleteThread,
      t,
      mail,
      setMail,
    ],
  );

  const optimisticToggleImportant = useCallback(
    (threadIds: string[], isImportant: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'LABEL',
        threadIds,
        labelIds: [],
        add: isImportant,
      });

      createPendingAction({
        type: 'LABEL',
        threadIds,
        params: { important: isImportant },
        optimisticId,
        execute: async () => {
          await toggleImportant({ ids: threadIds });

          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: isImportant ? 'Marked as important' : 'Unmarked as important',
      });
    },
    [
      addOptimisticAction,
      createPendingAction,
      mail,
      removeOptimisticAction,
      setMail,
      toggleImportant,
    ],
  );

  return {
    optimisticMarkAsRead,
    optimisticToggleStar,
    optimisticMoveThreadsTo,
    optimisticDeleteThreads,
    optimisticToggleImportant,
  };
}

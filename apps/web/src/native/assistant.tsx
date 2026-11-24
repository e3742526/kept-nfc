import { isLiveTurn, newId, TURN_LIMITS } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { assistantPaths as paths } from '@/api/assistant/paths';
import type {
  AskResult,
  AssistantModel,
  ConfirmBody,
  ConfirmResult,
  Proposal,
  Thread,
  ThreadDetail,
  ThreadsPage,
  TurnView,
} from '@/api/assistant/types';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { PlaceView, ThingView } from '@/api/inventory/types';
import { FieldList, ProposalRowTitle } from '@/assistant/confirm-card';
import { cardExpiry, cardRows } from '@/assistant/confirm-rows';
import {
  AssistantInputs,
  AssistantPhotoError,
  assistantPhotoBase64,
  useAssistantInputs,
} from '@/assistant/inputs';
import { LinkOnlyMarkdown, parse } from '@/assistant/link-only-markdown';
import { threadItems } from '@/assistant/thread';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Select, SelectItem } from '@/components/ui/select';
import { usePlatform } from './adapters';
import type { Connection, NativeRequestOptions } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

type Props = {
  connection: Connection;
  online: boolean;
  cache?: InventoryCache;
  defaultLocationId?: string;
  threadId?: string;
  onThreadChange: (id?: string) => void;
  onOpen: (target: Target) => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
  onInventoryChanged: () => void;
};

export function AssistantScreen(props: Props) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, networkMode: 'always' } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AssistantConversation {...props} />
    </QueryClientProvider>
  );
}

function AssistantConversation({
  connection,
  online,
  cache,
  defaultLocationId,
  threadId,
  onThreadChange,
  onOpen,
  onAuthError,
  onInventoryChanged,
}: Props) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { transport } = usePlatform();
  const [turnId, setTurnId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>(null);
  const previousAsk = useRef<{ thread: string; input: string; key: string }>(null);
  const request = <T,>(path: string, options?: NativeRequestOptions) =>
    transport.request<T>(connection, path, options);
  const models = useQuery({
    queryKey: ['assistant-models', defaultLocationId],
    queryFn: () =>
      request<{ items: AssistantModel[] }>(paths.models + qs({ locationId: defaultLocationId })),
    enabled: online,
  });
  const inputs = useAssistantInputs(models.data?.items ?? []);
  const threads = useQuery({
    queryKey: ['assistant-threads'],
    queryFn: () => request<ThreadsPage>(paths.threads),
    enabled: online,
  });
  const detail = useQuery({
    queryKey: ['assistant-thread', threadId],
    queryFn: () => request<ThreadDetail>(paths.thread(threadId ?? '')),
    enabled: online && !!threadId,
  });
  const activeTurnId = turnId ?? detail.data?.liveTurn?.id;
  const turn = useQuery({
    queryKey: ['assistant-turn', activeTurnId],
    queryFn: () => request<TurnView>(paths.turn(activeTurnId ?? '')),
    enabled: online && !!activeTurnId,
    refetchInterval: ({ state }) =>
      online && (!state.data || isLiveTurn(state.data.status)) ? 1000 : false,
  });
  const live = !!activeTurnId && (!turn.data || isLiveTurn(turn.data.status));
  const refetchDetail = detail.refetch;
  const refetchThreads = threads.refetch;
  const finished = !!turn.data && !isLiveTurn(turn.data.status);
  useEffect(() => {
    if (!activeTurnId || !finished) return;
    void refetchDetail();
    void refetchThreads();
  }, [activeTurnId, finished, refetchDetail, refetchThreads]);

  const ask = useMutation({
    mutationFn: async (text: string) => {
      const photo = inputs.photo ? await assistantPhotoBase64(inputs.photo) : undefined;
      let id = threadId;
      const context = defaultLocationId
        ? { kind: 'location' as const, id: defaultLocationId, recordOnly: true }
        : { kind: 'none' as const, recordOnly: true };
      if (!id) {
        const created = await request<Thread>(paths.threads, { method: 'POST', body: { context } });
        id = created.id;
        onThreadChange(id);
      }
      const body = {
        text,
        context,
        locale: i18n.locale,
        ...(photo ? { photo } : {}),
        ...(inputs.model ? { model: inputs.model } : {}),
      };
      const input = JSON.stringify(body);
      const prior = previousAsk.current;
      const key = prior?.thread === id && prior.input === input ? prior.key : newId();
      previousAsk.current = { thread: id, input, key };
      const result = await request<AskResult>(paths.threadTurns(id), {
        method: 'POST',
        body,
        idempotencyKey: key,
      });
      previousAsk.current = null;
      return result;
    },
    onSuccess: ({ turnId: id }) => {
      inputs.setPhoto(undefined);
      setDraft('');
      setTurnId(id);
    },
    onError: (failed: unknown) => {
      setError(failed);
      if (failed instanceof ApiError && failed.code === 'turn_running') {
        setTurnId(undefined);
        void refetchDetail();
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      request<TurnView>(paths.turnCancel(activeTurnId ?? ''), {
        method: 'POST',
        body: {},
      }),
    onSuccess: async () => {
      await turn.refetch();
    },
    onError: setError,
  });

  const issue = error ?? detail.error ?? turn.error ?? threads.error;
  useEffect(() => {
    if (isAuthRefusal(issue)) onAuthError('expired');
    else if (isRestoreEpochMismatch(issue)) onAuthError('restored');
  }, [issue, onAuthError]);
  const selectThread = (id?: string) => {
    onThreadChange(id);
    setTurnId(undefined);
    setDraft('');
    inputs.setPhoto(undefined);
    setError(null);
    previousAsk.current = null;
  };
  const removeThread = useMutation({
    mutationFn: (id: string) => request(paths.thread(id), { method: 'DELETE' }),
    onSuccess: async (_deleted, id) => {
      selectThread();
      queryClient.removeQueries({ queryKey: ['assistant-thread', id] });
      if (activeTurnId) queryClient.removeQueries({ queryKey: ['assistant-turn', activeTurnId] });
      await queryClient.invalidateQueries({ queryKey: ['assistant-threads'] });
    },
    onError: setError,
  });
  const askDelete = async (id: string) => {
    if (
      await confirm({
        title: t`Delete this thread`,
        body: t`Permanently delete this thread and its messages?`,
        confirmLabel: t`Delete`,
        destructive: true,
      })
    )
      removeThread.mutate(id);
  };
  const messages = detail.data?.messages ?? [];
  const proposals = detail.data?.proposals ?? [];
  const messageIds = new Set(messages.map((message) => message.id));
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const items = threadItems(
    [...messages, ...(turn.data?.messages.filter((message) => !messageIds.has(message.id)) ?? [])],
    [
      ...proposals,
      ...(turn.data?.proposals.filter((proposal) => !proposalIds.has(proposal.id)) ?? []),
    ],
  );
  const recent = threads.data?.items.filter((thread) => thread.title) ?? [];
  const threadLoading = !!threadId && !detail.data;
  const blocked = ask.isPending || live || threadLoading || removeThread.isPending;
  const text = draft.trim() || (inputs.photo ? t`Describe this photo` : '');
  const applyFeedback = async (changed: boolean) => {
    if (changed) onInventoryChanged();
    await refetchDetail();
  };

  return (
    <section className="grid gap-3">
      <h2 className="kept-card-title text-title">
        <MessageSquare size={18} aria-hidden />
        <Trans>Assistant</Trans>
      </h2>
      <p className="m-0 text-small text-ink-2">
        <Trans>All locations</Trans>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {recent.length > 0 && (
          <Select
            className="min-w-0 flex-1"
            label={t`Threads`}
            items={recent}
            selectedKey={recent.some((entry) => entry.id === threadId) ? threadId : null}
            isDisabled={!online || ask.isPending || removeThread.isPending}
            onSelectionChange={(key) => {
              if (key) selectThread(String(key));
            }}
          >
            {(entry) => (
              <SelectItem id={entry.id} textValue={entry.title ?? ''}>
                <bdi>{entry.title}</bdi>
              </SelectItem>
            )}
          </Select>
        )}
        {threadId && (
          <>
            <Button
              variant="secondary"
              size="small"
              isDisabled={ask.isPending || removeThread.isPending}
              onPress={() => selectThread()}
            >
              <Trans>New thread</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              isDisabled={!online || ask.isPending || threadLoading}
              isPending={removeThread.isPending}
              onPress={() => void askDelete(threadId)}
            >
              <Trans>Delete this thread</Trans>
            </Button>
          </>
        )}
      </div>
      <div role="log" aria-label={t`Assistant`} className="grid min-w-0 gap-3">
        {items.map((item) => {
          if (item.kind === 'card') {
            return (
              <ProposalCard
                key={item.key}
                proposals={item.proposals.filter(({ tool }) => RECORD_TOOLS.has(tool))}
                online={online && !live}
                request={request}
                onError={setError}
                onChanged={applyFeedback}
              />
            );
          }
          if (item.kind === 'tool') return null;
          if (item.kind === 'photo')
            return (
              <p key={item.key} className="m-0 justify-self-end text-small text-ink-2">
                <Trans>Photo attached</Trans>
              </p>
            );
          if (item.kind === 'redacted')
            return (
              <p key={item.key} className="m-0 text-small text-ink-2">
                <Trans>Hidden</Trans>
              </p>
            );
          return item.kind === 'question' ? (
            <p
              key={item.key}
              dir="auto"
              className="m-0 max-w-[90%] justify-self-end whitespace-pre-wrap rounded-xl bg-sunken px-3 py-2 [overflow-wrap:anywhere]"
            >
              {item.text}
            </p>
          ) : (
            <LinkOnlyMarkdown
              key={item.key}
              blocks={parse(item.text)}
              renderLink={(link) => {
                const pool = link.kind === 'thing' ? cache?.things : cache?.places;
                const record = pool?.find((entry) => entry.id === link.id);
                const open = async () => {
                  try {
                    const found =
                      record ??
                      (await request<ThingView | PlaceView>(
                        link.kind === 'thing'
                          ? inventoryPaths.thing(link.id)
                          : inventoryPaths.place(link.id),
                      ));
                    onOpen({ id: found.id, locationId: found.locationId, kind: link.kind });
                  } catch (failed) {
                    setError(failed);
                  }
                };
                return record || online ? (
                  <button
                    type="button"
                    className="text-start font-semibold underline underline-offset-2"
                    onClick={() => void open()}
                  >
                    <bdi>{link.text}</bdi>
                  </button>
                ) : (
                  <bdi>{link.text}</bdi>
                );
              }}
            />
          );
        })}
      </div>
      {!online ? (
        <p role="status" className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
      {live && (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="m-0 text-small text-ink-2">
            <Trans>Thinking…</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            isDisabled={!online}
            isPending={cancel.isPending}
            onPress={() => cancel.mutate()}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
      {issue ? (
        <p role="alert" className="m-0 text-small text-danger">
          {issue instanceof AssistantPhotoError
            ? t`Choose a readable photo.`
            : issue instanceof ApiError && issue.code === 'ai_unavailable'
              ? t`AI isn't set up here`
              : errorText(issue)}
        </p>
      ) : null}
      {finished &&
      (turn.data?.status === 'failed' ||
        turn.data?.status === 'paused_budget' ||
        turn.data?.status === 'cancelled') ? (
        <p role="status" className="m-0 text-small text-ink-2">
          {turn.data.status === 'paused_budget'
            ? t`AI paused`
            : turn.data.status === 'cancelled'
              ? t`Stopped`
              : turn.data.statusReason === 'model_unavailable'
                ? t`The selected model is unavailable for this turn.`
                : t`The assistant couldn't finish this answer. Ask again.`}
        </p>
      ) : null}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text || blocked || !online) return;
          setError(null);
          ask.mutate(text);
        }}
      >
        <AssistantInputs value={inputs} disabled={!online || blocked} />
        <label className="grid gap-1 text-small font-semibold">
          <Trans>Ask the assistant</Trans>
          <textarea
            className="min-h-20 resize-y rounded-xl border border-line bg-surface p-3 text-base font-normal text-ink focus:border-ink"
            dir="auto"
            maxLength={TURN_LIMITS.maxQuestionChars}
            value={draft}
            readOnly={ask.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!text || blocked || !online}
          isPending={ask.isPending}
        >
          <Trans>Send</Trans>
        </Button>
      </form>
    </section>
  );
}

const RECORD_TOOLS = new Set(['add_thing', 'update_thing', 'remove_inventory_record']);

function ProposalCard({
  proposals,
  online,
  request,
  onError,
  onChanged,
}: {
  proposals: Proposal[];
  online: boolean;
  request: <T>(path: string, options?: NativeRequestOptions) => Promise<T>;
  onError: (error: unknown) => void;
  onChanged: (changed: boolean) => Promise<void>;
}) {
  const { t } = useLingui();
  const [settled, setSettled] = useState(false);
  const [undone, setUndone] = useState<string[]>([]);
  const batchId = proposals[0]?.batchId ?? '';
  const open = proposals.filter((proposal) => proposal.status === 'open');
  const rows = cardRows(proposals);
  const deadline = cardExpiry(open);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline]);
  const action = useMutation({
    mutationFn: async (confirm: boolean) => {
      if (!confirm) {
        await request(paths.proposalsCancel, { method: 'POST', body: { batchId } });
        return false;
      }
      const body: ConfirmBody = {
        batchId,
        proposals: open.map(({ id, argsHash }) => ({ id, argsHash })),
      };
      const result = await request<ConfirmResult>(paths.proposalsConfirm, { method: 'POST', body });
      return result.results.some((entry) => entry.status === 'confirmed');
    },
    onSuccess: async (changed) => {
      setSettled(true);
      await onChanged(changed);
    },
    onError,
  });
  const undo = useMutation({
    mutationFn: async (proposal: Proposal) => {
      const audit = proposal.audit;
      if (!audit) return;
      const events = audit.eventIds ?? [audit.eventId];
      await request(
        events.length === 1 ? inventoryPaths.undo(audit.eventId) : inventoryPaths.undoTogether,
        { method: 'POST', body: events.length === 1 ? {} : { eventIds: events } },
      );
    },
    onSuccess: async (_result, proposal) => {
      setUndone((ids) => [...ids, proposal.id]);
      await onChanged(true);
    },
    onError,
  });
  const canConfirm = open.length > 0 && !expired && !settled;
  const count = rows.filter((row) => open.some((item) => item.id === row.proposalId)).length;
  const statusLabel = (status: Proposal['status']) => {
    switch (status) {
      case 'open':
        return expired ? t`Expired · ask again` : settled ? t`Done` : '';
      case 'confirmed':
        return t`Saved`;
      case 'cancelled':
        return t`Cancelled`;
      case 'expired':
        return t`Expired`;
      case 'conflict':
        return t`Changed since you asked`;
      case 'failed':
        return t`Some changes couldn't be saved. Ask again.`;
    }
  };
  if (!rows.length) return null;
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-3">
      <legend className="px-1 text-small font-semibold">
        <Trans>Changes</Trans>
      </legend>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((row, index) => {
          const proposal = proposals.find((item) => item.id === row.proposalId);
          const audit = proposal?.audit;
          const reversed = audit?.undone || undone.includes(row.proposalId);
          const lastRow = rows[index + 1]?.proposalId !== row.proposalId;
          return (
            <li key={row.key} className="min-w-0 border-line border-b pb-2">
              <ProposalRowTitle row={row}>
                <bdi>{row.target?.name ?? t`Something SheepKeep can't name`}</bdi>
              </ProposalRowTitle>
              <p className="m-0 text-small text-ink-2">
                <bdi>{row.location.from}</bdi>
              </p>
              <FieldList row={row} fields={row.fields} />
              <p className="m-0 text-small text-ink-2">
                {reversed ? t`Undone` : statusLabel(proposal?.status ?? 'failed')}
              </p>
              {lastRow &&
                proposal?.status === 'confirmed' &&
                audit &&
                !reversed &&
                Date.parse(audit.until) > Date.now() && (
                  <Button
                    variant="secondary"
                    size="small"
                    isDisabled={!online || undo.isPending}
                    onPress={() => {
                      onError(null);
                      undo.mutate(proposal);
                    }}
                  >
                    <Trans>Undo</Trans>
                  </Button>
                )}
            </li>
          );
        })}
      </ul>
      {canConfirm && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            isDisabled={!online || rows.length === 0 || action.isPending}
            onPress={() => {
              onError(null);
              action.mutate(true);
            }}
          >
            <Plural value={count} one="Confirm #" other="Confirm #" />
          </Button>
          <Button
            variant="secondary"
            isDisabled={!online || action.isPending}
            onPress={() => {
              onError(null);
              action.mutate(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
    </fieldset>
  );
}

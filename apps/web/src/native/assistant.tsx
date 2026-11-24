import { isLiveTurn, newId, type SnapLocation, TURN_LIMITS } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { assistantPaths as paths } from '@/api/assistant/paths';
import type {
  AskResult,
  ConfirmBody,
  ConfirmResult,
  Proposal,
  Thread,
  ThreadDetail,
  ThreadsPage,
  TurnView,
} from '@/api/assistant/types';
import { ApiError } from '@/api/client';
import { FieldList, ProposalRowTitle } from '@/assistant/confirm-card';
import { cardExpiry, cardRows } from '@/assistant/confirm-rows';
import { LinkOnlyMarkdown, parse } from '@/assistant/link-only-markdown';
import { threadItems } from '@/assistant/thread';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection, NativeRequestOptions } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

type Props = {
  connection: Connection;
  online: boolean;
  cache?: InventoryCache;
  onBack: () => void;
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
  onBack,
  onOpen,
  onAuthError,
  onInventoryChanged,
}: Props) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const { transport } = usePlatform();
  const [locationId, setLocationId] = useState<string>();
  const [threadId, setThreadId] = useState<string>();
  const [turnId, setTurnId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>(null);
  const previousAsk = useRef<{ thread: string; input: string; key: string }>(null);
  const locations = cache?.locations ?? [];
  const location = locations.find((item) => item.id === locationId) ?? locations[0];
  const request = <T,>(path: string, options?: NativeRequestOptions) =>
    transport.request<T>(connection, path, options);
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
    mutationFn: async ({ text, scope }: { text: string; scope?: SnapLocation }) => {
      let id = threadId;
      const existing = detail.data?.thread.context;
      const context = existing
        ? { kind: existing.kind, ...(existing.id ? { id: existing.id } : {}) }
        : scope
          ? { kind: 'location' as const, id: scope.id }
          : { kind: 'none' as const };
      if (!id) {
        const created = await request<Thread>(paths.threads, { method: 'POST', body: { context } });
        id = created.id;
        setThreadId(id);
      }
      const body = { text, context, locale: i18n.locale };
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
    setThreadId(id);
    setTurnId(undefined);
    setDraft('');
    setError(null);
    previousAsk.current = null;
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
  const threadLocation = locations.find(
    (item) => item.id === detail.data?.thread.context.locationId,
  );
  const selectedLocation = threadId ? threadLocation : location;
  const blocked = ask.isPending || live || threadLoading || (!threadId && !cache);
  const text = draft.trim();
  const applyFeedback = async (changed: boolean) => {
    if (changed) onInventoryChanged();
    await refetchDetail();
  };

  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>Assistant</Trans>}
        onBack={onBack}
        icon={<MessageSquare size={18} aria-hidden />}
      />
      <p className="m-0 text-small text-ink-2">
        <Trans>Server API</Trans>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {recent.length > 0 && (
          <Select
            className="min-w-0 flex-1"
            label={t`Threads`}
            items={recent}
            selectedKey={recent.some((entry) => entry.id === threadId) ? threadId : null}
            isDisabled={!online || ask.isPending}
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
          <Button
            variant="secondary"
            size="small"
            isDisabled={ask.isPending}
            onPress={() => selectThread()}
          >
            <Trans>New thread</Trans>
          </Button>
        )}
      </div>
      {threadId ? (
        selectedLocation && (
          <p className="m-0 text-small text-ink-2">
            <bdi>{selectedLocation.name}</bdi>
          </p>
        )
      ) : locations.length > 1 ? (
        <Select
          label={t`Location`}
          items={locations}
          selectedKey={location?.id}
          isDisabled={!online || ask.isPending}
          onSelectionChange={(key) => {
            if (key) setLocationId(String(key));
          }}
        >
          {(entry) => (
            <SelectItem id={entry.id} textValue={entry.name}>
              <bdi>{entry.name}</bdi>
            </SelectItem>
          )}
        </Select>
      ) : location ? (
        <p className="m-0 text-small text-ink-2">
          <bdi>{location.name}</bdi>
        </p>
      ) : null}
      <div role="log" aria-label={t`Assistant`} className="grid min-w-0 gap-3">
        {items.map((item) => {
          if (item.kind === 'card') {
            return (
              <ProposalCard
                key={item.key}
                proposals={item.proposals}
                online={online && !live}
                request={request}
                onError={setError}
                onChanged={applyFeedback}
              />
            );
          }
          if (item.kind === 'tool') return null;
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
                return record ? (
                  <button
                    type="button"
                    className="text-start font-semibold underline underline-offset-2"
                    onClick={() =>
                      onOpen({ id: record.id, locationId: record.locationId, kind: link.kind })
                    }
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
          {issue instanceof ApiError && issue.code === 'ai_unavailable'
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
              : t`The assistant couldn't finish this answer. Ask again.`}
        </p>
      ) : null}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text || blocked || !online) return;
          setError(null);
          ask.mutate({ text, scope: selectedLocation });
        }}
      >
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
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-3">
      <legend className="px-1 text-small font-semibold">
        <Trans>Changes</Trans>
      </legend>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 border-line border-b pb-2">
            <ProposalRowTitle row={row}>
              <bdi>{row.target?.name ?? t`Something SheepKeep can't name`}</bdi>
            </ProposalRowTitle>
            <FieldList row={row} fields={row.fields} />
            <p className="m-0 text-small text-ink-2">
              {statusLabel(
                proposals.find((proposal) => proposal.id === row.proposalId)?.status ?? 'failed',
              )}
            </p>
          </li>
        ))}
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

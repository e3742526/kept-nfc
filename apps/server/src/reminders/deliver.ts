import { type ChannelKindBuilt, newId } from '@kept/shared';
import type pg from 'pg';
import { withSystem } from '../db/scope.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import {
  type ChannelMessage,
  type ChannelSender,
  type ChannelTarget,
  errorCode,
  type ReminderRecipient,
  type SendOutcome,
} from './channel.js';
import { OCCURRENCE_COLUMNS, type OccurrenceRow, reminderItems } from './items.js';
import { loadUsers, type RecipientDeps } from './recipients.js';

// `reminder-deliver` (one delivery a job): an overdue reminder, sent on one
// channel once the person's quiet hours are over. The job's data only names a delivery row;
// whether to send is read from the database, never trusted from the data (jobs/boss.ts):
// The row is leased before sending. Network calls run outside the transaction; the lease token
// fences the final write and an expired lease can be reclaimed by a retry. For a webhook, the
// enqueue and delivery outcome commit together. External channels are at-least-once across a
// crash after a provider accepts a send but before the outcome reaches the database.
//
// A channel's test (T15's routes) may send `{kind: 'test', channelId}` to the same queue: the
// channel's own user gets the test message.

export type DeliverDeps = RecipientDeps & {
  /** KEPT_PUBLIC_URL, for the deep links. */
  publicUrl: string;
  log?: { error: (obj: object, msg: string) => void };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type DeliverData =
  | { kind: 'delivery'; occurrenceId: string; userId: string; channelId: string }
  | { kind: 'test'; channelId: string };

export function parseDeliverData(data: unknown): DeliverData | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.kind === 'test')
    return isUuid(d.channelId) ? { kind: 'test', channelId: d.channelId } : null;
  if (isUuid(d.occurrenceId) && isUuid(d.userId) && isUuid(d.channelId)) {
    return {
      kind: 'delivery',
      occurrenceId: d.occurrenceId,
      userId: d.userId,
      channelId: d.channelId,
    };
  }
  return null;
}

/** What became of a job: the delivery's end state, or nothing to do. */
export type DeliverResult = SendOutcome['status'] | 'nothing';

async function channelOf(client: pg.ClientBase, channelId: string): Promise<ChannelTarget | null> {
  const { rows } = await client.query<{ id: string; kind: ChannelKindBuilt; user_id: string }>(
    'SELECT id, kind, user_id FROM public.notification_channels WHERE id = $1',
    [channelId],
  );
  const r = rows[0];
  return r ? { id: r.id, kind: r.kind, userId: r.user_id } : null;
}

type PreparedSend = {
  sender: ChannelSender;
  target: ChannelTarget;
  user: ReminderRecipient;
  message: ChannelMessage;
};

async function prepareSend(
  deps: DeliverDeps,
  client: pg.ClientBase,
  target: ChannelTarget,
  message: ChannelMessage,
): Promise<PreparedSend | SendOutcome> {
  const sender = deps.channels?.[target.kind];
  if (!sender) return { status: 'skipped', error: 'channel_off' };
  const user = (await loadUsers(deps, client, [target.userId])).get(target.userId);
  if (!user || user.banned) return { status: 'skipped', error: 'no_user' };
  return { sender, target, user, message };
}

async function sendPrepared(plan: PreparedSend, client?: pg.ClientBase): Promise<SendOutcome> {
  try {
    const out = await plan.sender.send(plan.target, plan.user, plan.message, client);
    return out.status === 'sent' ? out : { status: out.status, error: errorCode(out.error) };
  } catch {
    return { status: 'failed', error: 'send_error' };
  }
}

type Delivery = Extract<DeliverData, { kind: 'delivery' }>;
const LEASE_SECONDS = JOB_POLICIES['reminder-deliver'].expireInSeconds;

async function prepareDelivery(deps: DeliverDeps, client: pg.ClientBase, data: Delivery) {
  const { rows } = await client.query<OccurrenceRow & { state: string; member: boolean }>(
    `SELECT ${OCCURRENCE_COLUMNS}, o.state,
            EXISTS (SELECT 1 FROM public.memberships m
                     WHERE m.location_id = o.location_id AND m.user_id = $2
                       AND (m.expires_at IS NULL OR m.expires_at > now())) AS member
       FROM public.reminder_occurrences o WHERE o.id = $1`,
    [data.occurrenceId, data.userId],
  );
  const occ = rows[0];
  if (occ?.state !== 'open') return { status: 'skipped', error: 'closed' } as const;
  if (!occ.member) return { status: 'skipped', error: 'not_member' } as const;
  const target = await channelOf(client, data.channelId);
  if (!target || target.userId !== data.userId) {
    return { status: 'skipped', error: 'channel_gone' } as const;
  }
  const [item] = await reminderItems(client, [occ], deps.publicUrl);
  if (!item) return { status: 'skipped', error: 'closed' } as const;
  return prepareSend(deps, client, target, { mode: 'immediate', item });
}

async function deliverOne(deps: DeliverDeps, data: Delivery): Promise<SendOutcome | null> {
  const claim = newId();
  const key = [data.occurrenceId, data.userId, data.channelId, claim];
  const finish = async (client: pg.ClientBase, outcome: SendOutcome) => {
    const { rowCount } = await client.query(
      `UPDATE public.reminder_deliveries
          SET status = $5, error = $6, sent_at = CASE WHEN $5 = 'sent' THEN now() END,
              send_claim = NULL, send_claimed_at = NULL
        WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3
          AND status IN ('queued', 'failed') AND send_claim = $4`,
      [...key, outcome.status, outcome.status === 'sent' ? null : outcome.error],
    );
    return rowCount ? outcome : null;
  };
  const prepared = await withSystem(deps.pools.system, async (_tx, client) => {
    // Keep the original queue status readable by workers from the previous release.
    const claimed = await client.query(
      `UPDATE public.reminder_deliveries
          SET send_claim = $4, send_claimed_at = now()
        WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3
          AND status IN ('queued', 'failed')
          AND (send_claimed_at IS NULL OR send_claimed_at <= now() - make_interval(secs => $5))
        RETURNING 1`,
      [...key, LEASE_SECONDS],
    );
    if (!claimed.rowCount) return null;
    const plan = await prepareDelivery(deps, client, data);
    if ('status' in plan) return finish(client, plan);
    if (plan.target.kind === 'webhook') return finish(client, await sendPrepared(plan, client));
    return plan;
  });
  if (!prepared || 'status' in prepared) return prepared;

  // A slow provider can keep sending past the queue attempt's expiry.
  let renewing = false;
  const timer = setInterval(
    () => {
      if (renewing) return;
      renewing = true;
      void withSystem(deps.pools.system, (_tx, client) =>
        client.query(
          `UPDATE public.reminder_deliveries SET send_claimed_at = now()
          WHERE occurrence_id = $1 AND user_id = $2 AND channel_id = $3 AND send_claim = $4`,
          key,
        ),
      )
        .catch(() =>
          deps.log?.error({ occurrenceId: data.occurrenceId }, 'reminder lease update failed'),
        )
        .finally(() => {
          renewing = false;
        });
    },
    (LEASE_SECONDS * 1000) / 3,
  );
  timer.unref();
  try {
    const outcome = await sendPrepared(prepared);
    return await withSystem(deps.pools.system, (_tx, client) => finish(client, outcome));
  } finally {
    clearInterval(timer);
  }
}

async function deliverTest(deps: DeliverDeps, channelId: string): Promise<SendOutcome | null> {
  const prepared = await withSystem(deps.pools.system, async (_tx, client) => {
    const target = await channelOf(client, channelId);
    return target ? prepareSend(deps, client, target, { mode: 'test' }) : null;
  });
  return !prepared || 'status' in prepared ? prepared : sendPrepared(prepared);
}

/** The `reminder-deliver` job. Throws when a send failed, so pg-boss retries it. */
export async function runDelivery(deps: DeliverDeps, raw: unknown): Promise<DeliverResult> {
  const data = parseDeliverData(raw);
  if (!data) return 'nothing';
  const outcome =
    data.kind === 'test' ? await deliverTest(deps, data.channelId) : await deliverOne(deps, data);
  if (!outcome) return 'nothing';
  if (outcome.status === 'failed') {
    throw new Error(`reminder delivery failed: ${outcome.error}`);
  }
  return outcome.status;
}

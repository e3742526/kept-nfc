import { type DevicePhotoProposal, DevicePhotoProposals, normalize } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { usePlatform } from './adapters';
import {
  type CaptureAIModel,
  type CaptureAIProvider,
  type CaptureAIStatus,
  type Connection,
  nativeErrorCode,
} from './bridge';

function useCaptureAI(connection: Connection) {
  const { captureAI, lifecycle } = usePlatform();
  const [status, setStatus] = useState<CaptureAIStatus>();
  useEffect(() => {
    if (!captureAI) return;
    let live = true;
    let remove: (() => void | Promise<void>) | undefined;
    const refresh = () => {
      void captureAI
        .status(connection)
        .then((result) => {
          if (live) setStatus(result);
        })
        .catch(() => {});
    };
    refresh();
    void lifecycle
      .onAppStateChange(({ active }) => {
        if (active) refresh();
      })
      .then((dispose) => {
        if (live) remove = dispose;
        else void dispose();
      })
      .catch(() => {});
    return () => {
      live = false;
      void remove?.();
    };
  }, [captureAI, connection, lifecycle]);

  return {
    status,
    setAccount(account: string | undefined) {
      setStatus((current) => ({ apple: current?.apple ?? 'unsupported', chatGPT: account }));
    },
  };
}

function ChatGPTConnection({
  connection,
  account,
  onChange,
  canDisconnect,
  isDisabled,
}: {
  connection: Connection;
  account?: string;
  onChange: (account: string | undefined) => void;
  canDisconnect?: boolean;
  isDisabled?: boolean;
}) {
  const { captureAI } = usePlatform();
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function connect() {
    if (!captureAI || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await captureAI.connect(connection);
      onChange(result.account);
    } catch (error) {
      setMessage(
        nativeErrorCode(error) === 'cancelled'
          ? t`Sign-in cancelled.`
          : t`Could not connect to ChatGPT. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!captureAI || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const { revoked } = await captureAI.disconnect(connection);
      onChange(undefined);
      if (!revoked)
        setMessage(t`Disconnected on this iPhone. End the session in ChatGPT settings.`);
    } catch {
      setMessage(t`Could not disconnect from ChatGPT. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {account && <bdi className="break-all text-small text-ink-2">{account}</bdi>}
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          isPending={busy}
          isDisabled={isDisabled}
          onPress={() => void connect()}
        >
          {account ? <Trans>Reconnect ChatGPT</Trans> : <Trans>Continue with ChatGPT</Trans>}
        </Button>
        {canDisconnect && account && (
          <Button size="small" variant="ghost" isDisabled={busy} onPress={() => void disconnect()}>
            <Trans>Disconnect</Trans>
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="text-small text-ink-2">
          {message}
        </p>
      )}
    </div>
  );
}

export function CaptureAISettings({ connection }: { connection: Connection }) {
  const { status, setAccount } = useCaptureAI(connection);

  return (
    <section className="kept-card">
      <h3 className="kept-card-title text-small text-ink-2">
        <Trans>AI settings</Trans>
      </h3>
      {status && (
        <ChatGPTConnection
          connection={connection}
          account={status.chatGPT}
          onChange={setAccount}
          canDisconnect
        />
      )}
      <Link
        href={new URL('/settings/ai', connection.origin).href}
        target="_blank"
        rel="noopener noreferrer"
        className="justify-self-start text-small text-ink underline"
      >
        <Trans>Manage API keys</Trans>
      </Link>
    </section>
  );
}

export function CaptureSuggestion({
  connection,
  file,
  locationId,
  provider,
  onProviderChange,
  onUse,
  onProposals,
  onCategories,
  disabled,
}: {
  connection: Connection;
  file: File;
  locationId?: string;
  provider: CaptureAIProvider;
  onProviderChange: (provider: CaptureAIProvider) => void;
  onUse: (name: string) => void;
  onProposals?: (items: DevicePhotoProposal[]) => Promise<void>;
  onCategories?: (items: DevicePhotoProposal[]) => Promise<void>;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const { captureAI } = usePlatform();
  const { status, setAccount } = useCaptureAI(connection);
  const [models, setModels] = useState<CaptureAIModel[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const active = useRef(true);
  const reviewCallbacks = useRef({ items: onProposals, categories: onCategories });
  useLayoutEffect(() => {
    reviewCallbacks.current = { items: onProposals, categories: onCategories };
  }, [onProposals, onCategories]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const providers: { id: CaptureAIProvider; name: string }[] = [
    { id: 'server', name: t`Server API` },
    { id: 'apple', name: t`Apple Intelligence` },
    { id: 'chatgpt', name: t`ChatGPT plan` },
  ];

  useEffect(() => {
    if (!captureAI || provider !== 'chatgpt' || !status?.chatGPT) return;
    let live = true;
    setModels([]);
    void captureAI
      .models(connection)
      .then((result) => {
        if (!live) return;
        setModels(result);
        setModel((current) =>
          result.some(({ id }) => id === current) ? current : (result[0]?.id ?? ''),
        );
        if (!result.length) setMessage(t`No ChatGPT models are available for this account.`);
      })
      .catch(() => {
        if (live) setMessage(t`Could not load ChatGPT models. Reconnect and try again.`);
      });
    return () => {
      live = false;
    };
  }, [captureAI, connection, provider, status, t]);

  async function suggest(review?: 'items' | 'categories') {
    if (!captureAI || busy) return;
    setBusy(true);
    setSuggestion('');
    setMessage('');
    try {
      const modelId = provider === 'chatgpt' ? model : undefined;
      if (review) {
        let value: unknown;
        if (provider === 'server') {
          if (!locationId || !captureAI.serverProposals) return;
          value = await captureAI.serverProposals(connection, locationId, file);
        } else {
          const { name } = await captureAI.suggest(connection, provider, file, modelId, true);
          const raw = name.replace(/^\s*\x60{3}(?:json)?\s*|\s*\x60{3}\s*$/gi, '');
          value = JSON.parse(raw);
        }
        const { items } = DevicePhotoProposals.parse(value);
        if (!active.current) return;
        const seen = new Set<string>();
        await reviewCallbacks.current[review]?.(
          items.filter((item) => {
            const key = normalize(item.name);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
      } else if (provider !== 'server') {
        const { name } = await captureAI.suggest(connection, provider, file, modelId);
        if (active.current) setSuggestion(name);
      }
    } catch (error) {
      const code = nativeErrorCode(error);
      if (!active.current) return;
      setMessage(
        code === 'quota'
          ? t`Your ChatGPT plan reached a usage limit.`
          : code === 'ai_unavailable'
            ? t`AI isn't set up here`
            : code === 'ai_paused'
              ? t`AI paused`
              : code === 'reconnect'
                ? t`Reconnect ChatGPT and try again.`
                : review
                  ? t`Could not suggest items from this photo.`
                  : t`Could not suggest a description from this photo.`,
      );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  if (!captureAI || !status) return null;

  const appleMessage =
    status.apple === 'disabled'
      ? t`Turn on Apple Intelligence in your iPhone settings.`
      : status.apple === 'notReady'
        ? t`Apple Intelligence is still getting ready.`
        : status.apple === 'unsupported'
          ? t`Photo suggestions need Apple Intelligence on iOS 27 or later.`
          : null;
  const canSuggest =
    provider === 'apple'
      ? status.apple === 'available'
      : provider === 'chatgpt' && models.some(({ id }) => id === model);
  const canReview =
    canSuggest || (provider === 'server' && !!locationId && !!captureAI.serverProposals);

  return (
    <div className="kept-card">
      <Select
        label={t`AI provider`}
        items={providers}
        value={provider}
        isDisabled={busy || disabled}
        onChange={(key) => {
          const choice = providers.find(({ id }) => id === key);
          if (!choice) return;
          setMessage('');
          setSuggestion('');
          onProviderChange(choice.id);
        }}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={item.name}>
            {item.name}
          </SelectItem>
        )}
      </Select>
      {provider === 'apple' && appleMessage && (
        <p className="text-small text-ink-2">{appleMessage}</p>
      )}
      {provider === 'chatgpt' && (
        <>
          <p className="text-small text-ink-2">
            <Trans>ChatGPT receives a copy of this photo and uses your plan allowance.</Trans>
          </p>
          {(!status.chatGPT || message) && (
            <ChatGPTConnection
              connection={connection}
              account={status.chatGPT}
              isDisabled={busy || disabled}
              onChange={(account) => {
                setMessage('');
                setAccount(account);
              }}
            />
          )}
          {models.length > 0 && (
            <Select
              label={t`Model`}
              items={models}
              value={model}
              isDisabled={busy || disabled}
              onChange={(key) => {
                setModel(String(key ?? ''));
                setSuggestion('');
                setMessage('');
              }}
            >
              {(item) => (
                <SelectItem id={item.id} textValue={item.name}>
                  {item.name}
                </SelectItem>
              )}
            </Select>
          )}
        </>
      )}
      {canSuggest && (
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={disabled}
          onPress={() => void suggest()}
        >
          <Trans>Suggest description</Trans>
        </Button>
      )}
      {canReview && onProposals && (
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={disabled}
          onPress={() => void suggest('items')}
        >
          <Trans>Suggest items</Trans>
        </Button>
      )}
      {canReview && onCategories && (
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={disabled}
          onPress={() => void suggest('categories')}
        >
          <Trans>Suggest categories</Trans>
        </Button>
      )}
      {suggestion && (
        <div className="grid gap-2">
          <bdi role="status" className="break-words text-small">
            {suggestion}
          </bdi>
          <Button
            variant="secondary"
            isDisabled={disabled}
            onPress={() => {
              onUse(suggestion);
              setSuggestion('');
            }}
          >
            <Trans>Use this description</Trans>
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-small text-ink-2">
          {message}
        </p>
      )}
    </div>
  );
}

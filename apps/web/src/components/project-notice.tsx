const PROJECT = 'https://github.com/e3742526/kept-nfc';

export function ProjectNotice({ revision }: { revision?: string | undefined }) {
  const source = revision ? `${PROJECT}/tree/${revision}` : PROJECT;
  const files = `${PROJECT}/blob/${revision || 'main'}`;
  return (
    <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-small text-ink-2">
      <a className="underline" href={source} target="_blank" rel="noreferrer">
        SheepKeep
      </a>
      <a className="underline" href={`${files}/UPSTREAM.md`} target="_blank" rel="noreferrer">
        Kept upstream
      </a>
      <a className="underline" href={`${files}/LICENSE`} target="_blank" rel="noreferrer">
        GNU AGPL v3
      </a>
    </p>
  );
}

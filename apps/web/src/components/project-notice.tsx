const PROJECT = 'https://github.com/e3742526/kept-nfc';

export function ProjectNotice() {
  return (
    <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-small text-ink-2">
      <a className="underline" href={PROJECT} target="_blank" rel="noreferrer">
        SheepKeep
      </a>
      <a
        className="underline"
        href={`${PROJECT}/blob/main/UPSTREAM.md`}
        target="_blank"
        rel="noreferrer"
      >
        Kept upstream
      </a>
      <a
        className="underline"
        href={`${PROJECT}/blob/main/LICENSE`}
        target="_blank"
        rel="noreferrer"
      >
        GNU AGPL v3
      </a>
    </p>
  );
}

import { cn } from '@/lib/utils';

/** Keeps a quarter-turned image centered in its original thumbnail or preview frame. */
export function PhotoImage({
  src,
  alt = '',
  className,
  rotation = 0,
  contain = false,
  loading = 'lazy',
}: {
  src: string;
  alt?: string;
  className?: string;
  rotation?: number | undefined;
  contain?: boolean;
  loading?: 'lazy' | 'eager';
}) {
  const sideways = rotation === 90 || rotation === 270;
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden [container-type:size] [grid-template:minmax(0,1fr)/minmax(0,1fr)]',
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        loading={loading}
        className={cn(
          'max-w-none',
          sideways ? 'h-[100cqw] w-[100cqh]' : 'size-full',
          contain ? 'object-contain' : 'object-cover',
        )}
        style={rotation ? { rotate: `${rotation}deg` } : undefined}
      />
    </span>
  );
}

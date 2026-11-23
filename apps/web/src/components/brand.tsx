import lockupLight from '@/assets/sheepkeep-horizontal-evergreen.svg';
import lockupDark from '@/assets/sheepkeep-horizontal-ivory.svg';
import markLight from '@/assets/sheepkeep-mark-evergreen.svg';
import markDark from '@/assets/sheepkeep-mark-ivory.svg';
import smallMarkLight from '@/assets/sheepkeep-mark-small-evergreen.svg';
import smallMarkDark from '@/assets/sheepkeep-mark-small-ivory.svg';
import { cn } from '@/lib/utils';

function BrandImage({
  light,
  dark,
  width,
  height,
  label = '',
  className,
}: {
  light: string;
  dark: string;
  width: number;
  height: number;
  label?: string;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn('inline-block shrink-0', className)}
      style={{ width, height }}
      role="img"
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <img src={light} alt="" width={width} height={height} className="block dark:hidden" />
      <img src={dark} alt="" width={width} height={height} className="hidden dark:block" />
    </span>
  );
}

export function BrandLockup({ className, width = 120 }: { className?: string; width?: number }) {
  return (
    <BrandImage
      light={lockupLight}
      dark={lockupDark}
      width={width}
      height={Math.round((width * 512) / 1975.7)}
      label="SheepKeep"
      className={className}
    />
  );
}

export function AppMark({
  size = 32,
  label,
  className,
}: {
  size?: number;
  /** Accessible name; without one the mark is decorative. */
  label?: string;
  className?: string;
}) {
  const small = size < 48;
  return (
    <BrandImage
      light={small ? smallMarkLight : markLight}
      dark={small ? smallMarkDark : markDark}
      width={size}
      height={size}
      {...(label === undefined ? {} : { label })}
      {...(className === undefined ? {} : { className })}
    />
  );
}

import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Icon back button shared by every phone sub-screen (iOS best practice). */
export function BackButton({ onPress, isDisabled }: { onPress: () => void; isDisabled?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="small"
      className="kept-back justify-self-start"
      onPress={onPress}
      isDisabled={isDisabled}
    >
      <ChevronLeft size={20} className="rtl:rotate-180" aria-hidden />
      <Trans>Back</Trans>
    </Button>
  );
}

/** Compact iOS-style navigation bar for sub-screens: back button, title, optional trailing action. */
export function ScreenHeader({
  title,
  onBack,
  backDisabled,
  icon,
  trailing,
}: {
  title?: ReactNode;
  onBack: () => void;
  backDisabled?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="kept-screen-header">
      <BackButton onPress={onBack} isDisabled={backDisabled} />
      {title && (
        <h2 className="kept-screen-title">
          {icon}
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        </h2>
      )}
      {trailing && <div className="kept-screen-trailing">{trailing}</div>}
    </div>
  );
}

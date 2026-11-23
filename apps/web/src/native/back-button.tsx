import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Icon back button shared by every phone sub-screen (iOS best practice). */
export function BackButton({ onPress, isDisabled }: { onPress: () => void; isDisabled?: boolean }) {
  return (
    <Button
      variant="ghost"
      className="kept-back justify-self-start"
      onPress={onPress}
      isDisabled={isDisabled}
    >
      <ChevronLeft size={20} aria-hidden />
      <Trans>Back</Trans>
    </Button>
  );
}

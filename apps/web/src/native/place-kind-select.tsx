import { useLingui } from '@lingui/react/macro';
import type { BuiltinPlaceKind } from '@/api/inventory/types';
import { PLACE_KINDS, usePlaceKindLabels } from '@/components/places/labels';
import { Select, SelectItem } from '@/components/ui/select';

export function PlaceKindSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (kind: BuiltinPlaceKind) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const labels = usePlaceKindLabels();
  return (
    <Select
      label={t`Kind`}
      items={PLACE_KINDS.map((id) => ({ id, name: labels[id] }))}
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key) => {
        const kind = PLACE_KINDS.find((id) => id === key);
        if (kind) onChange(kind);
      }}
    >
      {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
    </Select>
  );
}

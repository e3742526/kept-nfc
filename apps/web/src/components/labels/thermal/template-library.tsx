import { resolveLabelTemplate, supportsDrawerTemplate } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTrigger, Modal } from '@/components/ui/dialog';
import type { ThermalOptions } from './document';

/** A small library of the layouts the renderer actually supports on this stock. */
export function TemplateLibrary({
  stock,
  options,
  onSelect,
}: {
  stock: string;
  options: ThermalOptions;
  onSelect?: (options: ThermalOptions) => void;
}) {
  const { t } = useLingui();
  const selected = resolveLabelTemplate(stock, options);
  const templates = [
    {
      id: 'standard' as const,
      name: t`Standard inventory label`,
      description: t`QR code and item details`,
    },
    ...(supportsDrawerTemplate(stock)
      ? [
          {
            id: 'drawer' as const,
            name: t`Small-parts drawer`,
            description: t`QR code, category and contents`,
          },
        ]
      : []),
  ];
  return (
    <DialogTrigger>
      <Button variant="secondary">
        <Trans>View templates</Trans>
      </Button>
      <Modal>
        <Dialog title={<Trans>Label templates</Trans>}>
          <div className="grid gap-3">
            {templates.map((item) => (
              <section key={item.id} className="grid gap-2 rounded-lg border border-line p-3">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-12 w-24 shrink-0 items-center gap-1 rounded border border-line bg-sunken p-1"
                  >
                    <QrCode size={30} />
                    <span className="grid flex-1 gap-1">
                      <span className="h-1 w-full rounded bg-ink-2" />
                      <span className="h-1 w-4/5 rounded bg-ink-2" />
                      {item.id === 'drawer' && <span className="h-1 w-3/5 rounded bg-ink-2" />}
                    </span>
                  </span>
                  <div>
                    <p className="m-0 font-semibold">{item.name}</p>
                    <p className="m-0 text-small text-ink-2">{item.description}</p>
                  </div>
                </div>
                {onSelect && (
                  <Button
                    variant="secondary"
                    aria-pressed={selected === item.id}
                    onPress={() =>
                      onSelect({
                        ...options,
                        template: item.id === 'drawer' ? 'drawer' : undefined,
                      })
                    }
                  >
                    {selected === item.id ? t`Selected` : t`Use template`}
                  </Button>
                )}
              </section>
            ))}
          </div>
        </Dialog>
      </Modal>
    </DialogTrigger>
  );
}

import { fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderUI } from '@/test/render';
import { WorkshopPhoto } from './workshop-photo';

it('applies a photo recommendation only when the user chooses it', async () => {
  const suggest = vi.fn(async () => 'HEX' as const);
  const apply = vi.fn();
  const { container } = await renderUI(<WorkshopPhoto suggest={suggest} apply={apply} />);
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('Photo input is missing');
  expect(suggest).not.toHaveBeenCalled();
  const photo = new File(['fixture'], 'drawer.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [photo] } });
  const approval = await screen.findByRole('button', { name: 'Use suggested icon: Hex bits' });
  expect(suggest).toHaveBeenCalledWith(photo);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(approval);
  expect(apply).toHaveBeenCalledWith('HEX');
});

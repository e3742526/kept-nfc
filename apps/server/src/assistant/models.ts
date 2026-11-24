import type { AssistantModel } from '@kept/shared';
import type pg from 'pg';

export type SelectedModel = { id: string; providerId: string };

export async function modelsFor(
  client: pg.ClientBase,
  locationId: string | null,
): Promise<(AssistantModel & { providerId: string })[]> {
  const { rows } = await client.query<{
    provider_id: string;
    model: string;
    vision: boolean;
    is_default: boolean;
  }>('SELECT * FROM kept.assistant_models($1)', [locationId]);
  return rows.map((r) => ({
    providerId: r.provider_id,
    id: r.model,
    vision: r.vision,
    isDefault: r.is_default,
  }));
}

export function chooseModel(
  models: Awaited<ReturnType<typeof modelsFor>>,
  id: string | undefined,
  hasPhoto: boolean,
) {
  const eligible = models.filter((model) => !hasPhoto || model.vision);
  return id ? eligible.find((model) => model.id === id) : eligible[0];
}

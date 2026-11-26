import { capturePaths } from '@/api/capture/paths';
import type {
  CreateLabelBatchBody,
  CreateLabelBatchResult,
  LabelBatch,
  LabelBatchPreview,
  RegisterLabelTag,
  ReplaceLabelBody,
  ReplaceLabelResult,
} from '@/api/capture/types';
import { api } from '@/api/client';

export type PrintApi = {
  address: () => Promise<string>;
  preview: (body: CreateLabelBatchBody) => Promise<LabelBatchPreview>;
  create: (body: CreateLabelBatchBody) => Promise<CreateLabelBatchResult>;
  confirm: (id: string) => Promise<LabelBatch>;
  replace: (body: ReplaceLabelBody) => Promise<ReplaceLabelResult>;
  registerTag: (body: RegisterLabelTag) => Promise<{ configured: true }>;
};

export const webPrintApi: PrintApi = {
  address: async () => (await api.get<{ url: string }>(capturePaths.labelAddress)).url,
  preview: (body) => api.post(capturePaths.labelBatches, { ...body, dryRun: true }),
  create: (body) =>
    api.post(capturePaths.labelBatches, body, body.id ? { 'idempotency-key': body.id } : undefined),
  confirm: (id) => api.post(capturePaths.labelBatchPrinted(id)),
  replace: (body) => api.post(capturePaths.labelReplace, body),
  registerTag: (body) => api.post(capturePaths.labelTags, body),
};

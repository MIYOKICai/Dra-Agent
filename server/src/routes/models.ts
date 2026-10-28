import { Router } from 'express';
import type { ModelsResponse } from '../../../shared/types';
import { listAdapters } from '../providers';

export const modelsRouter = Router();

/** GET /api/models：服务商清单（含可用性与模型列表，mock 始终 available） */
modelsRouter.get('/', (_req, res) => {
  const body: ModelsResponse = {
    providers: listAdapters().map((adapter) => adapter.toInfo()),
  };
  res.json(body);
});

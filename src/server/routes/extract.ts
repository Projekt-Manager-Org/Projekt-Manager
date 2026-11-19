/**
 * Extraction route — LLM-based email data extraction.
 *
 * POST /api/extract receives raw email text and returns structured
 * customer + project data via OpenRouter. See ADR-0016.
 * GET /api/extract/status tells the client whether extraction is
 * configured, so it can hide the entry point (AC-734).
 */

import type { FastifyInstance } from 'fastify';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { ExtractionService } from '../services/ExtractionService.js';
import { getEnv } from '../config/env.js';
import { featureStatus } from '../config/features.js';
import type { Database } from '../db/connection.js';

export function extractRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const extractionService = new ExtractionService();

    requireSession(app, db);

    app.get(
      '/api/extract/status',
      { preHandler: requirePermission('customer:write') },
      async (_request, reply) => {
        const configured = featureStatus(getEnv(), 'llm').enabled;
        return reply.code(200).send({ configured });
      },
    );

    app.post(
      '/api/extract',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 50000 },
            },
          },
        },
        preHandler: requirePermission('customer:write'),
      },
      async (request, reply) => {
        const { text } = request.body as { text: string };
        const result = await extractionService.extract(text, request.log);
        return reply.code(200).send(result);
      },
    );
  };
}

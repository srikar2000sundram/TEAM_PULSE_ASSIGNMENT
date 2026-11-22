import { z } from 'zod';

/**
 * RFC 9457 problem details, the error body returned by every HTTP API.
 * `code` is the stable machine-readable identifier (see `AppError.code`);
 * `detail` is human-readable and must never contain internals or personal data.
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
  correlationId: z.string().optional(),
  errors: z
    .array(
      z.strictObject({
        field: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

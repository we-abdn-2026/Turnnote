import { z } from 'zod';
import type {
  AppSettings,
  ErrorCode,
  MeetingNote,
  TranscriptSegment,
  TurnnoteInvokeApi,
} from '../contracts';
import { errorMessages, TurnnoteError } from '../result';

export const meetingIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const titleSchema = z.string().trim().min(1).max(200);
export const querySchema = z.string().trim().max(200).optional();
export const keywordsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(50)
  .transform((keywords) => [...new Set(keywords)]);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const textSchema = z.string().max(200_000);
const nonemptyTextSchema = textSchema.min(1);

export const meetingNoteSchema = z.strictObject({
  summary: textSchema,
  keyTopics: z.array(nonemptyTextSchema).max(1000),
  decisions: z
    .array(z.strictObject({ text: nonemptyTextSchema, timestampMs: timestampSchema.optional() }))
    .max(1000),
  openQuestions: z.array(nonemptyTextSchema).max(1000),
  actionItems: z
    .array(
      z.strictObject({
        task: nonemptyTextSchema,
        owner: z.string().min(1).max(200),
        dueDate: z.string().min(1).max(200),
        timestampMs: timestampSchema.optional(),
      }),
    )
    .max(1000),
}) satisfies z.ZodType<MeetingNote>;

export const transcriptSegmentsSchema = z
  .array(
    z
      .strictObject({ startMs: timestampSchema, endMs: timestampSchema, text: nonemptyTextSchema })
      .refine((segment) => segment.endMs > segment.startMs),
  )
  .max(100_000)
  .refine((segments) =>
    segments.every((segment, i) => i === 0 || segment.startMs >= segments[i - 1].startMs),
  ) satisfies z.ZodType<TranscriptSegment[]>;

const modelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const settingsSchema = z.strictObject({
  microphoneDeviceId: z.string().min(1).max(256).nullable(),
  includeSystemAudio: z.boolean(),
  transcriptionModel: modelSchema,
  transcriptionLanguage: z.enum(['en', 'zh', 'auto']),
  deepseekModel: modelSchema,
}) satisfies z.ZodType<AppSettings>;
export const settingsPatchSchema = settingsSchema
  .partial()
  .refine((patch) => Object.values(patch).every((value) => value !== undefined));
export const defaultSettings: AppSettings = {
  microphoneDeviceId: null,
  includeSystemAudio: true,
  transcriptionModel: 'small',
  transcriptionLanguage: 'auto',
  // deepseek-chat 已于 2026-07-24 停用
  deepseekModel: 'deepseek-flash',
};

export const errorCodeSchema = z.enum(Object.keys(errorMessages) as [ErrorCode, ...ErrorCode[]]);
export const captureErrorCodeSchema = z.enum([
  'PERMISSION_DENIED',
  'DEVICE_NOT_FOUND',
  'CAPTURE_FAILED',
  'WRITE_FAILED',
]);
export const expectedVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idArgs = z.tuple([meetingIdSchema]);
const jobArgs = z.tuple([meetingIdSchema, meetingIdSchema]);
const noArgs = z.tuple([]);

/** 所有 invoke 方法都有同一套运行时参数校验；多余字段/参数被拒绝。 */
export const invokeSchemas = {
  app: { getInfo: noArgs },
  meetings: {
    list: z
      .tuple([])
      .rest(querySchema)
      .refine((args) => args.length <= 1),
    get: idArgs,
    create: z.tuple([titleSchema]),
    rename: z.tuple([meetingIdSchema, titleSchema]),
    setRetainAudio: z.tuple([meetingIdSchema, z.boolean()]),
    setKeywords: z.tuple([meetingIdSchema, keywordsSchema]),
    delete: idArgs,
    importAudio: noArgs,
  },
  recording: {
    getPermissions: noArgs,
    start: idArgs,
    appendChunk: z.tuple([
      meetingIdSchema,
      meetingIdSchema,
      z.custom<Int16Array>(
        (value) => value instanceof Int16Array && value.length > 0 && value.length <= 32_000,
      ),
    ]),
    stop: jobArgs,
    cancel: jobArgs,
    fail: z.tuple([meetingIdSchema, meetingIdSchema, captureErrorCodeSchema]),
  },
  transcription: { start: idArgs, cancel: jobArgs, getSegments: idArgs },
  notes: {
    generate: idArgs,
    getLatest: idArgs,
    saveEdit: z.tuple([meetingIdSchema, meetingNoteSchema, expectedVersionSchema]),
  },
  exports: { markdown: idArgs },
  settings: {
    get: noArgs,
    update: z.tuple([settingsPatchSchema]),
    hasApiKey: noArgs,
    setApiKey: z.tuple([z.string().trim().min(1).max(4096)]),
    clearApiKey: noArgs,
  },
} satisfies { [N in keyof TurnnoteInvokeApi]: { [M in keyof TurnnoteInvokeApi[N]]: z.ZodType } };

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TurnnoteError('INVALID_INPUT');
  return result.data;
}

export { MeetingStore } from '../../apps/desktop/main/storage/database';
export { createStorageHandlers } from '../../apps/desktop/main/storage/handlers';
export { migrate, migrations } from '../../apps/desktop/main/storage/migrations';
export { SidecarError, transcribe, withFakeFlag } from '../../apps/desktop/main/services/sidecar';
export { resolveSidecarCommand } from '../../apps/desktop/main/services/sidecar-command';
export { createSessionServices } from '../../apps/desktop/main/services/session';
export { createMockApi } from '../../apps/desktop/renderer/mock/mock-api';
export { AudioDeviceSelector } from '../../apps/desktop/renderer/components/AudioDeviceSelector';
export {
  ENUMERATE_FAILED_MESSAGE,
  LOAD_FAILED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  deriveDeviceView,
  loadDeviceSettings,
  saveDeviceSettings,
  scanAudioInputs,
} from '../../apps/desktop/renderer/components/audio-device-state';
export {
  REQUEST_FAILED_MESSAGE,
  TRANSCRIPT_LOAD_FAILED_MESSAGE,
  availableActions,
  createMeetingSession,
  isRecording,
} from '../../apps/desktop/renderer/workspace/meeting-session';
export {
  activeConfirmation,
  deriveRecordingControls,
} from '../../apps/desktop/renderer/workspace/recording-controls';
export { createInvokeApi } from '../../packages/contracts/src/bridge';
export { createDispatcher } from '../../packages/contracts/src/invoke';
export {
  invokeChannels,
  eventChannels,
  loopbackChannels,
} from '../../packages/contracts/src/contracts';
export {
  defaultSettings,
  invokeSchemas,
  meetingNoteSchema,
  settingsPatchSchema,
  transcriptSegmentsSchema,
} from '../../packages/contracts/src/schemas';
export { errorMessages, ok, fail, TurnnoteError } from '../../packages/contracts/src/result';

export { createAudioWriter, repairWavHeader } from '../../apps/desktop/main/platform/audio-writer';
export { createRecordingHandlers } from '../../apps/desktop/main/platform/recording';
export { PcmEncoder } from '../../apps/desktop/renderer/audio/pcm';
export { startCapture } from '../../apps/desktop/renderer/audio/capture';

export { createCaptureRecording } from '../../apps/desktop/renderer/audio/meeting-recording';
export { createMockRecording } from '../../apps/desktop/renderer/mock/mock-recording';
export { App } from '../../apps/desktop/renderer/App';

export { checkPackagedSidecar, runPackagingSmoke } from '../../apps/desktop/main/packaging-smoke';

export {
  NOTE_EXAMPLE,
  NOTE_RESPONSE_FORMAT,
  NOTE_SYSTEM_PROMPT,
  UNSPECIFIED,
  buildNoteMessages,
  formatTranscript,
  parseNoteResponse,
} from '../../apps/desktop/main/services/note-prompt';

export {
  DeepSeekError,
  MAX_OUTPUT_TOKENS,
  requestChatCompletion,
} from '../../apps/desktop/main/services/deepseek';
export {
  CHUNK_CHAR_BUDGET,
  MAX_CHUNKS,
  alignSources,
  chunkSegments,
  dedupeNote,
  generateNote,
} from '../../apps/desktop/main/services/note-pipeline';
export {
  buildMergeMessages,
  MERGE_SYSTEM_PROMPT,
} from '../../apps/desktop/main/services/note-prompt';

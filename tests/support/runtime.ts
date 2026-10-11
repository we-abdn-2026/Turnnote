export { MeetingStore } from '../../apps/desktop/main/storage/database';
export { createStorageHandlers } from '../../apps/desktop/main/storage/handlers';
export { migrate, migrations } from '../../apps/desktop/main/storage/migrations';
export { SidecarError, transcribe, withFakeFlag } from '../../apps/desktop/main/services/sidecar';
export { resolveSidecarCommand } from '../../apps/desktop/main/services/sidecar-command';
export { createSessionServices } from '../../apps/desktop/main/services/session';
export { createMockApi } from '../../apps/desktop/renderer/mock/mock-api';
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
} from '../../packages/contracts/src/schemas';
export { errorMessages, ok, fail, TurnnoteError } from '../../packages/contracts/src/result';

export { createAudioWriter, repairWavHeader } from '../../apps/desktop/main/platform/audio-writer';
export { createRecordingHandlers } from '../../apps/desktop/main/platform/recording';
export { PcmEncoder } from '../../apps/desktop/renderer/audio/pcm';
export { startCapture } from '../../apps/desktop/renderer/audio/capture';

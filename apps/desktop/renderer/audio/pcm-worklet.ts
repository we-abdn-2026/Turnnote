import { PcmEncoder } from './pcm';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false;
  private readonly encoder = new PcmEncoder(sampleRate, (chunk) =>
    this.port.postMessage({ chunk }, [chunk.buffer]),
  );
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.stopped = true;
        this.encoder.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs: Float32Array[][]): boolean {
    if (!this.stopped) this.encoder.push(inputs);
    // Output is left silent: connection to destination keeps processing alive without feedback.
    return true;
  }
}
registerProcessor('turnnote-capture', CaptureProcessor);

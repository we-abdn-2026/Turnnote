/** Streaming area resampler; carries fractional windows across render quanta. */
export class PcmEncoder {
  private readonly ratio: number;
  private remaining: number;
  private sum = 0;
  private block = new Int16Array(16000);
  private length = 0;
  constructor(
    rate: number,
    private readonly send: (chunk: Int16Array) => void,
  ) {
    if (!Number.isFinite(rate) || rate < 16000) throw new Error('Unsupported sample rate');
    this.ratio = rate / 16000;
    this.remaining = this.ratio;
  }
  push(inputs: Float32Array[][]): void {
    const active = inputs.filter((channels) => channels.length > 0 && channels[0].length > 0);
    const frames = active[0]?.[0].length ?? 0;
    for (let frame = 0; frame < frames; frame++) {
      let sample = 0;
      for (const channels of active) {
        sample +=
          channels.reduce((total, channel) => total + (channel[frame] ?? 0), 0) / channels.length;
      }
      sample /= active.length;
      let available = 1;
      while (available > 1e-9) {
        const used = Math.min(available, this.remaining);
        this.sum += sample * used;
        available -= used;
        this.remaining -= used;
        if (this.remaining < 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.block[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0;
          this.remaining = this.ratio;
          if (this.length === this.block.length) this.flush();
        }
      }
    }
  }
  flush(): void {
    if (!this.length) return;
    this.send(this.block.slice(0, this.length));
    this.length = 0;
  }
}

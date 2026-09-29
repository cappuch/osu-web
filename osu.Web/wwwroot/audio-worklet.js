// osu!web - AudioWorklet output sink.
//
// Pulls interleaved stereo float samples from a ring buffer in WebAssembly shared memory, which is filled by the managed
// mixer thread (osu.Framework/Audio/Web/WebAudioOutput.cs, RingBufferAudioOutput). Layout at `pointer`:
//   int32 [0] writeFrame  (total frames written by C#, wraps)
//   int32 [1] readFrame   (total frames read here, wraps)
//   int32 [2] capacityFrames (power of two)
//   int32 [3] sampleRate
//   float32[capacityFrames * 2] samples, frame n at index (n & (capacity - 1)) * 2

class OsuRingBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { memory, pointer, capacity } = options.processorOptions;
    this.header = new Int32Array(memory, pointer, 4);
    this.samples = new Float32Array(memory, pointer + 16, capacity * 2);
    this.mask = capacity - 1;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const frames = left.length;

    const write = Atomics.load(this.header, 0);
    let read = Atomics.load(this.header, 1);
    const available = (write - read) | 0;
    const count = Math.max(0, Math.min(available, frames));

    const samples = this.samples;
    const mask = this.mask;

    for (let i = 0; i < count; i++) {
      const index = ((read + i) & mask) * 2;
      left[i] = samples[index];
      if (right) right[i] = samples[index + 1];
    }

    for (let i = count; i < frames; i++) {
      left[i] = 0;
      if (right) right[i] = 0;
    }

    read = (read + count) | 0;
    Atomics.store(this.header, 1, read);

    return true;
  }
}

registerProcessor('osu-ring-buffer', OsuRingBufferProcessor);

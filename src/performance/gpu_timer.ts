export interface GpuSample {
    passMs: Record<string, number>;
    totalMs: number;
    spanMs: number;
    cpuEncodeMs: number;
}

interface QuerySlot {
    queries: GPUQuerySet;
    resolve: GPUBuffer;
    read: GPUBuffer;
    busy: boolean;
    pending: Promise<unknown>;
}

const maxPasses = 8;
const resultBytes = maxPasses * 2 * 8;

// Persistent resources and a small readback ring avoid synchronizing the live render loop.
export class GpuTimer {
    readonly supported: boolean;
    private slots: QuerySlot[] = [];

    constructor(private device: GPUDevice) {
        this.supported = device.features.has('timestamp-query');
        if (!this.supported) return;
        for (let i = 0; i < 3; i++) {
            this.slots.push({
                queries: device.createQuerySet({ label: 'frame timestamps', type: 'timestamp', count: maxPasses * 2 }),
                resolve: device.createBuffer({ label: 'timestamp resolve', size: resultBytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
                read: device.createBuffer({ label: 'timestamp readback', size: resultBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
                busy: false,
                pending: Promise.resolve()
            });
        }
    }

    beginFrame(): GpuTimingFrame | undefined {
        const slot = this.slots.find(candidate => !candidate.busy);
        if (!slot) return undefined;
        slot.busy = true;
        return new GpuTimingFrame(slot);
    }

    async drain() {
        await Promise.all(this.slots.map(slot => slot.pending));
        await this.device.queue.onSubmittedWorkDone();
    }
}

export class GpuTimingFrame {
    private labels: string[] = [];

    constructor(private slot: QuerySlot) {}

    writes(label: string): GPURenderPassTimestampWrites {
        if (this.labels.length >= maxPasses) throw new Error('GPU timer pass capacity exceeded');
        const index = this.labels.length * 2;
        this.labels.push(label);
        return { querySet: this.slot.queries, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 };
    }

    resolve(encoder: GPUCommandEncoder) {
        if (!this.labels.length) throw new Error('No passes were measured');
        const count = this.labels.length * 2;
        encoder.resolveQuerySet(this.slot.queries, 0, count, this.slot.resolve, 0);
        encoder.copyBufferToBuffer(this.slot.resolve, 0, this.slot.read, 0, count * 8);
    }

    read(cpuEncodeMs: number): Promise<GpuSample> {
        const pending = (async () => {
            try {
                await this.slot.read.mapAsync(GPUMapMode.READ);
                const timestamps = new BigUint64Array(this.slot.read.getMappedRange());
                const passMs: Record<string, number> = {};
                this.labels.forEach((label, i) => {
                    const ticks = timestamps[i * 2 + 1] - timestamps[i * 2];
                    if (ticks < 0n) throw new Error('Non-monotonic GPU timestamp');
                    passMs[label] = Number(ticks) / 1e6;
                });
                // Unlike the pass sum, this also includes inter-pass work (e.g. flag clears).
                const spanMs = Number(timestamps[this.labels.length * 2 - 1] - timestamps[0]) / 1e6;
                if (spanMs < 0) throw new Error('Non-monotonic GPU span');
                return { passMs, totalMs: Object.values(passMs).reduce((sum, ms) => sum + ms, 0), spanMs, cpuEncodeMs };
            } finally {
                if (this.slot.read.mapState === 'mapped') this.slot.read.unmap();
                this.slot.busy = false;
            }
        })();
        // Consumers receive errors; drain() only waits until all slots can be reused.
        this.slot.pending = pending.catch(() => undefined);
        return pending;
    }
}

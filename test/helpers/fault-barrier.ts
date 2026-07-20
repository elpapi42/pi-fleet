export interface FaultBarrier {
  readonly reached: Promise<void>;
  reach(): Promise<void>;
  release(): void;
}

export function createFaultBarrier(): FaultBarrier {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    async reach() {
      markReached();
      await released;
    },
    release,
  };
}

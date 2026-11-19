export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private readonly fixed: Date) {}

  now(): Date {
    return new Date(this.fixed.getTime());
  }
}

export class OffsetClock implements Clock {
  constructor(private readonly offsetMs: number) {}

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

let globalClock: Clock | null = null;

export function clockFromEnv(overrideIso?: string): Clock {
  const iso = overrideIso ?? process.env.CLOCK_OVERRIDE;
  if (iso?.trim()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      console.error(`Invalid CLOCK_OVERRIDE: ${iso}`);
      process.exit(1);
    }
    return new FixedClock(d);
  }
  return new SystemClock();
}

export function getClock(): Clock {
  if (!globalClock) globalClock = clockFromEnv();
  return globalClock;
}

export function setClock(clock: Clock): void {
  globalClock = clock;
}

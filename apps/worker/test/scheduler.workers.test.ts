import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { DurableObjectNamespace, DurableObjectStorage } from '@cloudflare/workers-types';
import {
  cancelTask,
  cancelTasksByType,
  runDueTasks,
  scheduleTask,
  type SchedulerStorage,
} from '../src/scheduler';

const ROOM = (env as { ROOM: DurableObjectNamespace }).ROOM;

/**
 * Drives the scheduler against the room DO's real ctx.storage (SQLite + real
 * setAlarm/getAlarm/deleteAlarm). The DO constructor already ran initSchema,
 * so `scheduled_task` exists when we enter the callback.
 *
 * Mock-vs-real difference flagged here: the better-sqlite3 mock blindly stored
 * whatever timestamp setAlarm received, so tests used small absolutes like
 * 3_000/5_000/9_999. Real DO setAlarm clamps past timestamps to "now-ish" and
 * getAlarm reads back the clamped value, not the requested past value. Tests
 * now use `now + N` so the DO doesn't clamp and getAlarm readback is
 * deterministic — same scheduler invariants, just future-relative.
 */
async function withStorage<T>(name: string, fn: (storage: SchedulerStorage) => Promise<T>): Promise<T> {
  const stub = ROOM.get(ROOM.idFromName(name));
  const wake = await stub.fetch(new Request('https://do/state'));
  await wake.arrayBuffer();
  return await runInDurableObject(stub, async (_instance, state) => {
    return await fn(state.storage as unknown as DurableObjectStorage as SchedulerStorage);
  });
}

async function alarmOf(storage: SchedulerStorage): Promise<number | null> {
  return await storage.getAlarm();
}

// All test times are now-relative so the DO's "no past alarms" clamping
// doesn't kick in. The scheduler module computes MIN(at) and arms with it.
const FUTURE = (s: number) => Date.now() + s * 1000;

// ---- arm / re-arm / cancel ----

describe('scheduler — arm / re-arm / cancel (real DO SQLite + alarm)', () => {
  it('scheduleTask arms the alarm to the task at', async () => {
    await withStorage('sched-arm-1', async (storage) => {
      const at = FUTURE(5);
      await scheduleTask(storage, '__test_marker', at);
      expect(await alarmOf(storage)).toBe(at);
    });
  });

  it('a second, earlier task re-arms the alarm to the earlier at', async () => {
    await withStorage('sched-arm-2', async (storage) => {
      const later = FUTURE(10);
      const earlier = FUTURE(3);
      await scheduleTask(storage, '__test_marker', later);
      expect(await alarmOf(storage)).toBe(later);
      await scheduleTask(storage, '__test_marker', earlier);
      expect(await alarmOf(storage)).toBe(earlier);
    });
  });

  it('a later task does NOT delay an existing earlier alarm', async () => {
    await withStorage('sched-arm-3', async (storage) => {
      const earlier = FUTURE(3);
      const later = FUTURE(10);
      await scheduleTask(storage, '__test_marker', earlier);
      await scheduleTask(storage, '__test_marker', later);
      expect(await alarmOf(storage)).toBe(earlier);
    });
  });

  it('cancelTask re-arms the alarm to the next earliest', async () => {
    await withStorage('sched-cancel-1', async (storage) => {
      const earlier = FUTURE(3);
      const later = FUTURE(10);
      const a = await scheduleTask(storage, '__test_marker', earlier);
      await scheduleTask(storage, '__test_marker', later);
      await cancelTask(storage, a);
      expect(await alarmOf(storage)).toBe(later);
    });
  });

  it('cancelTask with no tasks remaining clears the alarm', async () => {
    await withStorage('sched-cancel-2', async (storage) => {
      const a = await scheduleTask(storage, '__test_marker', FUTURE(5));
      await cancelTask(storage, a);
      expect(await alarmOf(storage)).toBeNull();
    });
  });

  it('cancelTasksByType clears every task of that type and re-arms accordingly', async () => {
    await withStorage('sched-cancel-3', async (storage) => {
      await scheduleTask(storage, 'host_vacant', FUTURE(3));
      await scheduleTask(storage, 'host_vacant', FUTURE(9));
      const surviving = FUTURE(7);
      await scheduleTask(storage, 'async_window', surviving);
      await cancelTasksByType(storage, 'host_vacant');
      expect(await alarmOf(storage)).toBe(surviving);
    });
  });
});

// ---- runDueTasks ----

describe('scheduler — runDueTasks (real DO SQLite)', () => {
  it('runs only at <= now; due tasks are deleted; alarm re-arms to the next not-yet-due', async () => {
    await withStorage('sched-run-1', async (storage) => {
      const now = Date.now();
      await scheduleTask(storage, '__test_marker', now - 4000, { tag: 'A' });
      await scheduleTask(storage, '__test_marker', now - 3000, { tag: 'B' });
      const future = now + 60_000;
      await scheduleTask(storage, '__test_marker', future, { tag: 'C' });

      const seen: string[] = [];
      await runDueTasks(storage, now, async (t) => {
        seen.push((t.payload as { tag: string }).tag);
      });

      expect(seen).toEqual(['A', 'B']);
      const left = storage.sql
        .exec<{ id: string; at: number }>(`SELECT id, at FROM scheduled_task ORDER BY at`)
        .toArray();
      expect(left).toHaveLength(1);
      expect(left[0].at).toBe(future);
      expect(await alarmOf(storage)).toBe(future);
    });
  });

  it('all tasks due → table empties + alarm cleared', async () => {
    await withStorage('sched-run-2', async (storage) => {
      const now = Date.now();
      await scheduleTask(storage, '__test_marker', now - 4000);
      await scheduleTask(storage, '__test_marker', now - 3000);
      await runDueTasks(storage, now, vi.fn());
      const left = storage.sql
        .exec<{ id: string }>(`SELECT id FROM scheduled_task`)
        .toArray();
      expect(left).toHaveLength(0);
      expect(await alarmOf(storage)).toBeNull();
    });
  });

  it('a throwing handler does NOT strand sibling due tasks; alarm still re-arms', async () => {
    await withStorage('sched-run-3', async (storage) => {
      const now = Date.now();
      await scheduleTask(storage, 'throwy', now - 4000);
      await scheduleTask(storage, '__test_marker', now - 3000, { tag: 'survivor' });
      const future = now + 60_000;
      await scheduleTask(storage, '__test_marker', future, { tag: 'later' });

      const seen: string[] = [];
      await runDueTasks(storage, now, async (t) => {
        if (t.type === 'throwy') throw new Error('boom');
        seen.push((t.payload as { tag: string }).tag);
      });

      expect(seen).toEqual(['survivor']);
      const left = storage.sql
        .exec<{ type: string }>(`SELECT type FROM scheduled_task ORDER BY at`)
        .toArray();
      expect(left.map((r) => r.type)).toEqual(['__test_marker']);
      expect(await alarmOf(storage)).toBe(future);
    });
  });

  it('payload round-trips through JSON', async () => {
    await withStorage('sched-payload-1', async (storage) => {
      const now = Date.now();
      await scheduleTask(storage, '__test_marker', now - 1000, { foo: 'bar', n: 42 });
      let captured: unknown = null;
      await runDueTasks(storage, now, async (t) => { captured = t.payload; });
      expect(captured).toEqual({ foo: 'bar', n: 42 });
    });
  });

  it('omitted payload arrives as null', async () => {
    await withStorage('sched-payload-2', async (storage) => {
      const now = Date.now();
      await scheduleTask(storage, '__test_marker', now - 1000);
      let captured: unknown = 'unchanged';
      await runDueTasks(storage, now, async (t) => { captured = t.payload; });
      expect(captured).toBeNull();
    });
  });
});

// ---- Room.alarm() integration ----

describe('scheduler — Room.alarm() integration (real DO)', () => {
  it('dispatches __test_marker through Room.alarm(); marker shows up in processed_message', async () => {
    const stub = ROOM.get(ROOM.idFromName('sched-room-alarm-1'));
    const wake = await stub.fetch(new Request('https://do/state'));
    await wake.arrayBuffer();

    const id = await runInDurableObject(stub, async (_instance, state) => {
      const storage = state.storage as unknown as SchedulerStorage;
      return await scheduleTask(storage, '__test_marker', Date.now() - 1);
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const storage = state.storage as unknown as SchedulerStorage;
      const markers = storage.sql
        .exec<{ id: string }>(`SELECT id FROM processed_message WHERE id LIKE '__test_marker:%'`)
        .toArray();
      expect(markers).toHaveLength(1);
      expect(markers[0].id).toBe(`__test_marker:${id}`);
      expect(
        storage.sql.exec<{ id: string }>(`SELECT id FROM scheduled_task`).toArray(),
      ).toHaveLength(0);
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it('unknown task type → default case logs a warning, task is still removed, alarm still re-arms', async () => {
    const stub = ROOM.get(ROOM.idFromName('sched-room-alarm-2'));
    const wake = await stub.fetch(new Request('https://do/state'));
    await wake.arrayBuffer();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (_instance, state) => {
        const storage = state.storage as unknown as SchedulerStorage;
        await scheduleTask(storage, 'mystery_task', Date.now() - 1);
        await scheduleTask(storage, '__test_marker', Date.now() + 60_000);
      });

      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { alarm: () => Promise<void> }).alarm();
      });

      expect(warn).toHaveBeenCalled();
      await runInDurableObject(stub, async (_instance, state) => {
        const left = state.storage.sql
          .exec<{ type: string }>(`SELECT type FROM scheduled_task`)
          .toArray();
        expect(left.map((r) => r.type)).toEqual(['__test_marker']);
      });
    } finally {
      warn.mockRestore();
    }
  });
});

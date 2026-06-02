import { describe, it, expect, vi } from 'vitest';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { initSchema } from '../src/schema';
import {
  cancelTask,
  cancelTasksByType,
  runDueTasks,
  scheduleTask,
  type SchedulerStorage,
} from '../src/scheduler';
import { Room } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import type { Env } from '../src/worker';

function makeStorage(): SchedulerStorage {
  const state = createMockDoState();
  initSchema(state.storage.sql);
  // The mock's storage shape is a strict subset that already satisfies
  // SchedulerStorage; the cast through the real type keeps the test honest.
  return state.storage as unknown as DurableObjectStorage;
}

function alarmOf(storage: SchedulerStorage): number | null {
  // getAlarm() in our mock returns synchronously; the real signature is async,
  // and the scheduler awaits it — both shapes work.
  return storage.getAlarm() as unknown as number | null;
}

describe('scheduler — arm / re-arm / cancel', () => {
  it('scheduleTask arms the alarm to the task at', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 5_000);
    expect(alarmOf(storage)).toBe(5_000);
  });

  it('a second, earlier task re-arms the alarm to the earlier at', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 10_000);
    expect(alarmOf(storage)).toBe(10_000);
    await scheduleTask(storage, '__test_marker', 3_000);
    expect(alarmOf(storage)).toBe(3_000);
  });

  it('a later task does NOT delay an existing earlier alarm', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 3_000);
    await scheduleTask(storage, '__test_marker', 10_000);
    expect(alarmOf(storage)).toBe(3_000);
  });

  it('cancelTask re-arms the alarm to the next earliest', async () => {
    const storage = makeStorage();
    const a = await scheduleTask(storage, '__test_marker', 3_000);
    await scheduleTask(storage, '__test_marker', 10_000);
    await cancelTask(storage, a);
    expect(alarmOf(storage)).toBe(10_000);
  });

  it('cancelTask with no tasks remaining clears the alarm', async () => {
    const storage = makeStorage();
    const a = await scheduleTask(storage, '__test_marker', 5_000);
    await cancelTask(storage, a);
    expect(alarmOf(storage)).toBeNull();
  });

  it('cancelTasksByType clears every task of that type and re-arms accordingly', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, 'host_vacant', 3_000);
    await scheduleTask(storage, 'host_vacant', 9_000);
    await scheduleTask(storage, 'async_window', 7_000);
    await cancelTasksByType(storage, 'host_vacant');
    expect(alarmOf(storage)).toBe(7_000);
  });
});

describe('scheduler — runDueTasks', () => {
  it('runs only at <= now; due tasks are deleted; alarm re-arms to the next not-yet-due', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 1_000, { tag: 'A' });
    await scheduleTask(storage, '__test_marker', 2_000, { tag: 'B' });
    await scheduleTask(storage, '__test_marker', 9_999, { tag: 'C' });

    const seen: string[] = [];
    await runDueTasks(storage, 5_000, async (t) => {
      seen.push((t.payload as { tag: string }).tag);
    });

    expect(seen).toEqual(['A', 'B']); // C was not due
    const left = storage.sql
      .exec<{ id: string; at: number }>(`SELECT id, at FROM scheduled_task ORDER BY at`)
      .toArray();
    expect(left).toHaveLength(1);
    expect(left[0].at).toBe(9_999);
    expect(alarmOf(storage)).toBe(9_999);
  });

  it('all tasks due → table empties + alarm cleared', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 1_000);
    await scheduleTask(storage, '__test_marker', 2_000);
    await runDueTasks(storage, 5_000, vi.fn());
    const left = storage.sql
      .exec<{ id: string }>(`SELECT id FROM scheduled_task`)
      .toArray();
    expect(left).toHaveLength(0);
    expect(alarmOf(storage)).toBeNull();
  });

  it('a throwing handler does NOT strand sibling due tasks; alarm still re-arms', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, 'throwy', 1_000);
    await scheduleTask(storage, '__test_marker', 2_000, { tag: 'survivor' });
    await scheduleTask(storage, '__test_marker', 9_999, { tag: 'later' });

    const seen: string[] = [];
    await runDueTasks(storage, 5_000, async (t) => {
      if (t.type === 'throwy') throw new Error('boom');
      seen.push((t.payload as { tag: string }).tag);
    });

    expect(seen).toEqual(['survivor']);
    // Throwy task deleted alongside its sibling — the scheduler tolerates failure.
    const left = storage.sql
      .exec<{ type: string }>(`SELECT type FROM scheduled_task ORDER BY at`)
      .toArray();
    expect(left.map((r) => r.type)).toEqual(['__test_marker']);
    expect(alarmOf(storage)).toBe(9_999);
  });

  it('payload round-trips through JSON', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 1_000, { foo: 'bar', n: 42 });
    let captured: unknown = null;
    await runDueTasks(storage, 2_000, async (t) => { captured = t.payload; });
    expect(captured).toEqual({ foo: 'bar', n: 42 });
  });

  it('omitted payload arrives as null', async () => {
    const storage = makeStorage();
    await scheduleTask(storage, '__test_marker', 1_000);
    let captured: unknown = 'unchanged';
    await runDueTasks(storage, 2_000, async (t) => { captured = t.payload; });
    expect(captured).toBeNull();
  });
});

describe('scheduler — Room.alarm() integration', () => {
  it('dispatches __test_marker through Room.alarm(); marker shows up in processed_message', async () => {
    const state = createMockDoState();
    const room = new Room(state, {} as Env);
    const storage = state.storage as unknown as SchedulerStorage;

    const id = await scheduleTask(storage, '__test_marker', Date.now() - 1);
    await room.alarm();

    const markers = storage.sql
      .exec<{ id: string }>(`SELECT id FROM processed_message WHERE id LIKE '__test_marker:%'`)
      .toArray();
    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe(`__test_marker:${id}`);

    // Task consumed + alarm cleared.
    expect(
      storage.sql.exec<{ id: string }>(`SELECT id FROM scheduled_task`).toArray(),
    ).toHaveLength(0);
    expect(alarmOf(storage)).toBeNull();
  });

  it('unknown task type → default case logs a warning, task is still removed, alarm still re-arms', async () => {
    const state = createMockDoState();
    const room = new Room(state, {} as Env);
    const storage = state.storage as unknown as SchedulerStorage;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduleTask(storage, 'mystery_task', Date.now() - 1);
    await scheduleTask(storage, '__test_marker', Date.now() + 60_000); // future, survives
    await room.alarm();

    expect(warn).toHaveBeenCalled();
    const left = storage.sql
      .exec<{ type: string }>(`SELECT type FROM scheduled_task`)
      .toArray();
    expect(left.map((r) => r.type)).toEqual(['__test_marker']);
    warn.mockRestore();
  });
});

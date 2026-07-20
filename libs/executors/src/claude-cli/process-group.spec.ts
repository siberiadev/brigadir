import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  // Default: pgrep finds no children (exit 1, no stdout) → group-signal only.
  execFile: vi.fn((_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) =>
    cb(new Error('no matches'), ''),
  ),
}));

import { spawn, execFile } from 'node:child_process';
import { spawnGroup } from './process-group';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

type FakeChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };

function fakeChild(pid = 4242): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.pid = pid;
  emitter.exitCode = null;
  emitter.signalCode = null;
  return emitter;
}

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

describe('spawnGroup / terminate (T081)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: pgrep reports no children unless a test overrides it.
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: Error | null, out: string) => void) =>
        cb(new Error('no matches'), ''),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    spawnMock.mockReset();
    execFileMock.mockReset();
  });

  it('spawns detached, with no shell, and never calls unref()', () => {
    const child = fakeChild();
    const unrefSpy = vi.fn();
    (child as unknown as { unref: () => void }).unref = unrefSpy;
    spawnMock.mockReturnValue(child);

    spawnGroup('claude', ['-p'], { cwd: '/tmp/wt', env: { HOME: '/home/x' } });

    expect(spawn).toHaveBeenCalledWith('claude', ['-p'], {
      cwd: '/tmp/wt',
      env: { HOME: '/home/x' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(unrefSpy).not.toHaveBeenCalled();
  });

  it('terminate() sends SIGTERM immediately, then SIGKILL only after the grace window elapses', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });
    const done = group.terminate(5000);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
  });

  it('does not send SIGKILL if the process exits within the grace window', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });
    const done = group.terminate(5000);
    child.emit('exit', 0, null);
    await done;

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('calling terminate() twice, or on an already-exited pid, does not throw (ESRCH swallowed)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });
    const first = group.terminate(10);
    const second = group.terminate(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('killGroup swallows ESRCH but rethrows other errors', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(() => group.killGroup('SIGTERM')).not.toThrow();

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => group.killGroup('SIGTERM')).toThrow('boom');
  });

  it('SIGKILLs setsid-escaped descendants by pid after the grace window (incident 2026-07-19)', async () => {
    const child = fakeChild(4242);
    spawnMock.mockReturnValue(child);
    // Leader 4242 has one escaped grandchild (9001) that ignored the group
    // SIGTERM; 9001 itself has no children.
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], cb: (e: Error | null, out: string) => void) => {
        if (args[1] === '4242') cb(null, '9001\n');
        else cb(new Error('no matches'), '');
      },
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });
    const done = group.terminate(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    // The escaped grandchild the negative-pid signal never reached is reaped by pid.
    expect(killSpy).toHaveBeenCalledWith(9001, 'SIGKILL');
  });

  it('falls back to group-signal-only (no throw) when descendant lookup fails', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    execFileMock.mockImplementation(() => {
      throw new Error('pgrep: command not found');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const group = spawnGroup('claude', ['-p'], { cwd: '/tmp', env: {} });
    const done = group.terminate(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBeUndefined();

    expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledTimes(2);
  });
});

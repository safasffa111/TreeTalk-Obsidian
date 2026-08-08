import { describe, expect, it, vi } from "vitest";
import { createPrivateStorageRuntime } from "../../src/storage/runtime-private-storage";

describe("createPrivateStorageRuntime", () => {
  it("binds the adapter to roots below the vault configuration directory", () => {
    const adapter = {
      exists: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      process: vi.fn(),
      remove: vi.fn(),
      mkdir: vi.fn(),
      list: vi.fn(),
      rename: vi.fn()
    };

    const runtime = createPrivateStorageRuntime({
      configDir: ".settings",
      adapter
    } as never);

    expect(runtime.roots).toEqual({
      root: ".settings/treetalk-data",
      active: ".settings/treetalk-data/active",
      history: ".settings/treetalk-data/history"
    });
    expect(runtime.port).toBeDefined();
  });
});

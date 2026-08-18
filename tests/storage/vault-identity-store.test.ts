import { describe, expect, it, beforeEach } from "vitest";
import { VaultIdentityStore } from "../../src/storage/vault-identity-store";
import { FakeVault } from "../storage/fake-vault";

function newVault(initial: Record<string, string> = {}): FakeVault {
  return new FakeVault(initial);
}

describe("VaultIdentityStore", () => {
  it("creates a marker at <configDir>/treetalk-vault-id.json when none exists", async () => {
    const vault = newVault();
    const store = new VaultIdentityStore(vault, ".obsidian");
    const id = await store.getVaultId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/iu);
    const raw = await vault.read(".obsidian/treetalk-vault-id.json");
    const parsed = JSON.parse(raw) as { version: number; vaultId: string };
    expect(parsed.version).toBe(1);
    expect(parsed.vaultId).toBe(id);
  });

  it("reuses an existing well-formed marker instead of regenerating", async () => {
    const existing = "11111111-2222-3333-4444-555555555555";
    const vault = newVault({
      ".obsidian/treetalk-vault-id.json": JSON.stringify({
        version: 1,
        vaultId: existing
      })
    });
    const store = new VaultIdentityStore(vault, ".obsidian");
    expect(await store.getVaultId()).toBe(existing);
    const filesAfter = vault.paths().filter((path) => path.endsWith(".json"));
    expect(filesAfter).toEqual([".obsidian/treetalk-vault-id.json"]);
  });

  it("rejects a malformed marker and does not silently rewrite it", async () => {
    const vault = newVault({
      ".obsidian/treetalk-vault-id.json": "{not json}"
    });
    const store = new VaultIdentityStore(vault, ".obsidian");
    await expect(store.getVaultId()).rejects.toThrow(/vault.*marker/i);
    const raw = await vault.read(".obsidian/treetalk-vault-id.json");
    expect(raw).toBe("{not json}");
  });

  it("rejects an unsupported marker version", async () => {
    const vault = newVault({
      ".obsidian/treetalk-vault-id.json": JSON.stringify({
        version: 2,
        vaultId: "not-a-uuid"
      })
    });
    const store = new VaultIdentityStore(vault, ".obsidian");
    await expect(store.getVaultId()).rejects.toThrow(/version/i);
  });

  it("rejects a marker whose vaultId is not a valid UUID", async () => {
    const vault = newVault({
      ".obsidian/treetalk-vault-id.json": JSON.stringify({
        version: 1,
        vaultId: "not-a-uuid"
      })
    });
    const store = new VaultIdentityStore(vault, ".obsidian");
    await expect(store.getVaultId()).rejects.toThrow(/vaultId/i);
  });

  it("lives outside the plugin folder so copying plugin data does not copy identity", async () => {
    const vault = newVault();
    const store = new VaultIdentityStore(vault, ".obsidian");
    await store.getVaultId();
    const paths = vault.paths();
    expect(paths).toContain(".obsidian/treetalk-vault-id.json");
    expect(
      paths.some((path) => path.startsWith(".obsidian/plugins/TreeTalk"))
    ).toBe(false);
  });

  it("normalizes configDir slashes when locating the marker", async () => {
    const existing = "22222222-3333-4444-5555-666666666666";
    const vault = newVault({
      ".obsidian/treetalk-vault-id.json": JSON.stringify({
        version: 1,
        vaultId: existing
      })
    });
    const store = new VaultIdentityStore(vault, ".obsidian\\");
    expect(await store.getVaultId()).toBe(existing);
  });

  describe("startup usage", () => {
    it("creates and persists the marker on first plugin load", async () => {
      const vault = newVault();
      const store = new VaultIdentityStore(vault, ".obsidian");
      const first = await store.getVaultId();
      const raw = await vault.read(".obsidian/treetalk-vault-id.json");
      const parsed = JSON.parse(raw) as { version: number; vaultId: string };
      expect(parsed.version).toBe(1);
      expect(parsed.vaultId).toBe(first);
    });

    it("reuses the marker across subsequent loads without re-reading the file", async () => {
      const existing = "33333333-4444-5555-6666-777777777777";
      const vault = newVault({
        ".obsidian/treetalk-vault-id.json": JSON.stringify({
          version: 1,
          vaultId: existing
        })
      });
      const store = new VaultIdentityStore(vault, ".obsidian");
      const first = await store.getVaultId();
      const second = await store.getVaultId();
      expect(first).toBe(existing);
      expect(second).toBe(existing);
    });

    it("fails closed when the startup marker is unreadable", async () => {
      const vault = newVault({
        ".obsidian/treetalk-vault-id.json": "{not json"
      });
      const store = new VaultIdentityStore(vault, ".obsidian");
      await expect(store.getVaultId()).rejects.toThrow(/vault.*marker/i);
      // 失败时绝不能悄悄覆盖原 marker。
      const raw = await vault.read(".obsidian/treetalk-vault-id.json");
      expect(raw).toBe("{not json");
    });
  });

  beforeEach(() => {
    // Each test starts with its own FakeVault; nothing global to reset.
  });
});

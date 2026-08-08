import { describe, expect, it } from "vitest";
import {
  angleWithinSector,
  planRelationshipGraphRadialLayout,
  type RelationshipGraphRadialLayoutNode
} from "../../src/relationship-graph/radial-layout";

const viewport = { width: 1000, height: 800 };

function conversation(
  id: string,
  parentId: string | undefined,
  order: number,
  root = false
): RelationshipGraphRadialLayoutNode {
  return {
    id,
    kind: "conversation",
    ...(parentId === undefined ? {} : { parentId }),
    order,
    root
  };
}

describe("radial relationship graph layout", () => {
  it("places the primary root at the viewport center and deeper nodes on increasing rings", () => {
    const plan = planRelationshipGraphRadialLayout([
      conversation("root", undefined, 0, true),
      conversation("a", "root", 0),
      conversation("a1", "a", 0),
      conversation("a2", "a1", 0)
    ], viewport);
    expect(plan.targets.get("root")).toMatchObject({ x: 500, y: 400, radius: 0, depth: 0 });
    expect(plan.targets.get("a")?.radius).toBeLessThan(plan.targets.get("a1")?.radius ?? 0);
    expect(plan.targets.get("a1")?.radius).toBeLessThan(plan.targets.get("a2")?.radius ?? 0);
  });

  it("keeps each first-level subtree inside a disjoint stable angular sector", () => {
    const nodes = [
      conversation("root", undefined, 0, true),
      conversation("a", "root", 0),
      conversation("a1", "a", 0),
      conversation("a2", "a", 1),
      conversation("b", "root", 1),
      conversation("b1", "b", 0),
      conversation("c", "root", 2)
    ];
    const plan = planRelationshipGraphRadialLayout(nodes, viewport);
    const a = plan.targets.get("a");
    const b = plan.targets.get("b");
    const c = plan.targets.get("c");
    if (a === undefined || b === undefined || c === undefined) throw new Error("missing branch targets");
    expect(a.sectorEnd).toBeLessThanOrEqual(b.sectorStart);
    expect(b.sectorEnd).toBeLessThanOrEqual(c.sectorStart);
    for (const id of ["a", "a1", "a2"]) {
      const target = plan.targets.get(id);
      if (target === undefined) throw new Error(`missing ${id}`);
      expect(angleWithinSector(target.angle, a.sectorStart, a.sectorEnd)).toBe(true);
    }
  });

  it("gives a larger sector to the branch with the larger subtree", () => {
    const plan = planRelationshipGraphRadialLayout([
      conversation("root", undefined, 0, true),
      conversation("large", "root", 0),
      conversation("large-1", "large", 0),
      conversation("large-2", "large", 1),
      conversation("large-3", "large", 2),
      conversation("small", "root", 1)
    ], viewport);
    const large = plan.targets.get("large");
    const small = plan.targets.get("small");
    if (large === undefined || small === undefined) throw new Error("missing targets");
    expect(large.sectorEnd - large.sectorStart).toBeGreaterThan(small.sectorEnd - small.sectorStart);
  });

  it("places notes outside and near their host branch", () => {
    const plan = planRelationshipGraphRadialLayout([
      conversation("root", undefined, 0, true),
      conversation("branch", "root", 0),
      { id: "note-a", kind: "note", hostId: "branch", order: 0, orbitIndex: 0, orbitCount: 2, noteRelation: "source-note" },
      { id: "note-b", kind: "note", hostId: "branch", order: 1, orbitIndex: 1, orbitCount: 2, noteRelation: "related-note" }
    ], viewport);
    const host = plan.targets.get("branch");
    const noteA = plan.targets.get("note-a");
    const noteB = plan.targets.get("note-b");
    if (host === undefined || noteA === undefined || noteB === undefined) throw new Error("missing note targets");
    expect(noteA.radius).toBeGreaterThan(host.radius);
    expect(noteB.radius).toBeGreaterThan(noteA.radius);
    expect(Math.abs(noteA.angle - host.angle)).toBeLessThan(Math.PI / 5);
    expect(Math.abs(noteB.angle - host.angle)).toBeLessThan(Math.PI / 5);
  });

  it("expands a crowded first ring enough to separate sibling branch targets", () => {
    const children = Array.from({ length: 40 }, (_, index) =>
      conversation(`branch-${index}`, "root", index)
    );
    const plan = planRelationshipGraphRadialLayout([
      conversation("root", undefined, 0, true),
      ...children
    ], viewport);
    const ordered = children.map((child) => plan.targets.get(child.id));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) throw new Error("missing crowded target");
      const chord = Math.hypot(current.x - previous.x, current.y - previous.y);
      expect(chord).toBeGreaterThanOrEqual(52);
    }
  });

  it("uses additional note rings when a host has many notes", () => {
    const notes = Array.from({ length: 14 }, (_, index) => ({
      id: `note-${index}`,
      kind: "note" as const,
      hostId: "branch",
      order: index,
      orbitIndex: index,
      orbitCount: 14,
      noteRelation: "source-note" as const
    }));
    const plan = planRelationshipGraphRadialLayout([
      conversation("root", undefined, 0, true),
      conversation("branch", "root", 0),
      ...notes
    ], viewport);
    const radii = new Set(notes.map((note) => Math.round(plan.targets.get(note.id)?.radius ?? 0)));
    expect(radii.size).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic for the same topology", () => {
    const nodes = [
      conversation("root", undefined, 0, true),
      conversation("b", "root", 1),
      conversation("a", "root", 0),
      conversation("a1", "a", 0)
    ];
    const first = planRelationshipGraphRadialLayout(nodes, viewport);
    const second = planRelationshipGraphRadialLayout(nodes, viewport);
    expect([...first.targets.entries()]).toEqual([...second.targets.entries()]);
  });
});

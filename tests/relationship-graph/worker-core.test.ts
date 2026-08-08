import { describe, expect, it } from "vitest";
import { RelationshipGraphForceCore, RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET } from "../../src/relationship-graph/worker-core";

const nodes = (ids: string[]) => ids.map((id) => ({ id }));

describe("relationship graph force core", () => {
  it("seeds a connected new node near its existing neighbor", () => {
    const core = new RelationshipGraphForceCore();
    core.reconcile(1, nodes(["a", "b"]), [{ id: "a-b", sourceId: "a", targetId: "b" }]);
    core.beginDrag("a", 200, 160);
    core.endDrag("a");
    const anchor = core.node("a");
    if (anchor === undefined) throw new Error("missing anchor");
    core.reconcile(2, nodes(["a", "b", "c"]), [
      { id: "a-b", sourceId: "a", targetId: "b" },
      { id: "a-c", sourceId: "a", targetId: "c" }
    ]);
    const created = core.node("c");
    if (created === undefined) throw new Error("missing created node");
    expect(Math.hypot(created.x - anchor.x, created.y - anchor.y)).toBeLessThanOrEqual(18.000001);
  });

  it("reheats for drag and cools to an idle target after release", () => {
    const core = new RelationshipGraphForceCore();
    core.reconcile(1, nodes(["a"]), []);
    expect(core.beginDrag("a", 10, 20)).toBe(true);
    expect(core.alphaTarget()).toBeGreaterThan(0);
    expect(core.endDrag("a")).toBe(true);
    expect(core.alphaTarget()).toBe(RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET);
    for (let index = 0; index < 500; index += 1) core.tick();
    expect(core.isActive()).toBe(false);
  });

  it("uses the supplied viewport center for the center force", () => {
    const core = new RelationshipGraphForceCore();
    core.setViewport(1000, 600);
    core.reconcile(1, [{ id: "a", x: 0, y: 0 }], []);
    core.tick(20);
    const node = core.node("a");
    if (node === undefined) throw new Error("missing node");
    expect(node.x).toBeGreaterThan(0);
    expect(node.y).toBeGreaterThan(0);
  });

  it("becomes inactive after settling so the display loop can stop", () => {
    const core = new RelationshipGraphForceCore();
    core.reconcile(1, nodes(["a", "b"]), [{ id: "a-b", sourceId: "a", targetId: "b" }]);
    for (let index = 0; index < 500; index += 1) core.tick();
    expect(core.alphaTarget()).toBe(0);
    expect(core.isActive()).toBe(false);
  });

  it("reuses the position snapshot container between ticks", () => {
    const core = new RelationshipGraphForceCore();
    core.reconcile(1, nodes(["a", "b"]), [{ id: "a-b", sourceId: "a", targetId: "b" }]);
    const first = core.positionSnapshot();
    core.tick();
    const second = core.positionSnapshot();
    expect(second).toBe(first);
  });
});

it("settles conversation nodes into center-out depth rings and branch sectors", () => {
  const core = new RelationshipGraphForceCore();
  core.setViewport(1000, 800);
  core.reconcile(1, [
    { id: "root", kind: "conversation", root: true, order: 0, x: 20, y: 20 },
    { id: "a", kind: "conversation", parentId: "root", order: 0, x: 30, y: 30 },
    { id: "a1", kind: "conversation", parentId: "a", order: 0, x: 40, y: 40 },
    { id: "b", kind: "conversation", parentId: "root", order: 1, x: 50, y: 50 },
    { id: "b1", kind: "conversation", parentId: "b", order: 0, x: 60, y: 60 }
  ], [
    { id: "r-a", sourceId: "root", targetId: "a", kind: "parent-child" },
    { id: "a-a1", sourceId: "a", targetId: "a1", kind: "parent-child" },
    { id: "r-b", sourceId: "root", targetId: "b", kind: "parent-child" },
    { id: "b-b1", sourceId: "b", targetId: "b1", kind: "parent-child" }
  ]);
  for (let index = 0; index < 650; index += 1) core.tick();
  const root = core.node("root");
  const a = core.node("a");
  const a1 = core.node("a1");
  const b = core.node("b");
  const b1 = core.node("b1");
  if (root === undefined || a === undefined || a1 === undefined || b === undefined || b1 === undefined) throw new Error("missing nodes");
  const radius = (node: { x: number; y: number }): number => Math.hypot(node.x - 500, node.y - 400);
  expect(radius(root)).toBeLessThan(8);
  expect(radius(a1) - radius(a)).toBeGreaterThan(70);
  expect(radius(b1) - radius(b)).toBeGreaterThan(70);
  const branchDelta = Math.abs(Math.atan2(
    Math.sin(Math.atan2(a.y - 400, a.x - 500) - Math.atan2(b.y - 400, b.x - 500)),
    Math.cos(Math.atan2(a.y - 400, a.x - 500) - Math.atan2(b.y - 400, b.x - 500))
  ));
  expect(branchDelta).toBeGreaterThan(1.8);
});

it("keeps note nodes outside their host and returns released nodes to their radial target", () => {
  const core = new RelationshipGraphForceCore();
  core.setViewport(1000, 800);
  core.reconcile(1, [
    { id: "root", kind: "conversation", root: true, order: 0 },
    { id: "branch", kind: "conversation", parentId: "root", order: 0 },
    { id: "note", kind: "note", hostId: "branch", noteRelation: "source-note", order: 0, orbitIndex: 0, orbitCount: 1 }
  ], [
    { id: "r-b", sourceId: "root", targetId: "branch", kind: "parent-child" },
    { id: "b-n", sourceId: "branch", targetId: "note", kind: "source-note" }
  ]);
  for (let index = 0; index < 500; index += 1) core.tick();
  const branch = core.node("branch");
  const note = core.node("note");
  if (branch === undefined || note === undefined) throw new Error("missing nodes");
  const radius = (node: { x: number; y: number }): number => Math.hypot(node.x - 500, node.y - 400);
  expect(radius(note)).toBeGreaterThan(radius(branch));
  core.beginDrag("branch", 720, 280);
  core.tick(5);
  expect(core.node("branch")).toMatchObject({ x: 720, y: 280 });
  core.endDrag("branch");
  for (let index = 0; index < 450; index += 1) core.tick();
  const released = core.node("branch");
  if (released === undefined) throw new Error("missing released node");
  expect(Math.hypot(released.x - released.target.x, released.y - released.target.y)).toBeLessThan(70);
});

it("keeps fully restored coordinates idle through the first viewport synchronization", () => {
  const core = new RelationshipGraphForceCore();
  core.reconcile(1, [
    { id: "root", kind: "conversation", root: true, order: 0, x: 420, y: 310, restored: true },
    { id: "child", kind: "conversation", parentId: "root", order: 0, x: 610, y: 355, restored: true }
  ], [
    { id: "root-child", sourceId: "root", targetId: "child", kind: "parent-child" }
  ]);
  core.setViewport(880, 550);
  for (let index = 0; index < 120; index += 1) core.tick();
  expect(core.node("root")).toMatchObject({ x: 420, y: 310 });
  expect(core.node("child")).toMatchObject({ x: 610, y: 355 });
  expect(core.isActive()).toBe(false);
});

import { describe, expect, it } from "vitest";
import type { ConversationFile } from "../../src/domain/types";
import {
  RelationshipGraphModelAdapter,
  noteRelationshipNodeId,
  relationshipEdgeId,
  relationshipGraphInputSignature,
  relationshipGraphVisualStateSignature
} from "../../src/relationship-graph/model";

function conversationWithLegacyState(): ConversationFile {
  return {
    id: "conversation-space",
    title: "Root",
    createdAt: 1,
    updatedAt: 1,
    rootNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: undefined,
        question: "Question",
        answer: "Answer",
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        children: []
      }
    },
    order: ["root"],
    depositGraphState: {
      protocol: "deposit-graph:v1",
      nodeStates: {},
      edgeOverrides: {},
      nodePositions: { "conversation:root": { x: 42, y: -18, fixed: false } }
    }
  } as unknown as ConversationFile;
}

describe("relationship graph model adapter", () => {
  it("keeps stable IDs while reading legacy persisted positions", () => {
    const snapshot = new RelationshipGraphModelAdapter().snapshot(
      "space-a",
      conversationWithLegacyState()
    );
    expect(snapshot.sessionId).toBe("space-a");
    expect(snapshot.positions["conversation:root"]).toEqual({ x: 42, y: -18, fixed: false });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["conversation:root"]);
  });

  it("projects disabled note nodes and their edges while keeping them visible", () => {
    const conversation = conversationWithLegacyState();
    const root = conversation.nodes.root;
    const graphState = conversation.depositGraphState;
    if (root === undefined || graphState === undefined) throw new Error("Missing legacy fixture state");
    root.messages = [{
      id: "question",
      role: "user",
      content: "question",
      status: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      selectionContexts: [{
        sourceType: "note",
        filePath: "Notes/example.md",
        fileName: "example.md",
        basis: "note-source-v1",
        startOffset: 0,
        endOffset: 3,
        quote: "one",
        prefix: "",
        suffix: "",
        contentHash: "hash"
      }]
    }];
    const noteId = noteRelationshipNodeId("Notes/example.md");
    graphState.nodeStates[noteId] = {
      included: false,
      content: { question: true, answer: true, selection: true, sourceLinks: true, relatedLinks: true, attachments: true }
    };
    const snapshot = new RelationshipGraphModelAdapter().snapshot("space-a", conversation);
    expect(snapshot.nodes.find((node) => node.id === noteId)?.included).toBe(false);
    const edgeId = relationshipEdgeId("source-note", "conversation:root", noteId);
    expect(snapshot.edges.find((edge) => edge.id === edgeId)?.included).toBe(false);
  });

  it("ignores assistant stream text but detects graph-visible inputs and inclusion state", () => {
    const conversation = conversationWithLegacyState();
    const root = conversation.nodes.root;
    if (root === undefined || conversation.depositGraphState === undefined) throw new Error("missing fixture");
    const inputBefore = relationshipGraphInputSignature(conversation);
    root.messages.push({
      id: "assistant",
      role: "assistant",
      content: "first chunk",
      status: "streaming",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(relationshipGraphInputSignature(conversation)).toBe(inputBefore);
    const assistant = root.messages[0];
    if (assistant === undefined) throw new Error("missing assistant fixture");
    assistant.content = "second chunk";
    expect(relationshipGraphInputSignature(conversation)).toBe(inputBefore);

    root.title = "Visible title change";
    expect(relationshipGraphInputSignature(conversation)).not.toBe(inputBefore);
    const visualBefore = relationshipGraphVisualStateSignature(conversation);
    conversation.depositGraphState.nodeStates.root = {
      included: false,
      content: { question: true, answer: true, selection: true, sourceLinks: true, relatedLinks: true, attachments: true }
    };
    expect(relationshipGraphVisualStateSignature(conversation)).not.toBe(visualBefore);
  });
});

it("adds stable radial hierarchy metadata for conversation branches and note orbits", () => {
  const conversation = conversationWithLegacyState();
  const root = conversation.nodes.root;
  if (root === undefined) throw new Error("missing root");
  root.childIds = ["branch-b", "branch-a"];
  conversation.nodes["branch-a"] = {
    ...root,
    id: "branch-a",
    parentId: "root",
    childIds: [],
    title: "A",
    messages: [{
      id: "a-question",
      role: "user",
      content: "question",
      status: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      selectionContexts: [{
        sourceType: "note",
        filePath: "Notes/a.md",
        fileName: "a.md",
        basis: "note-source-v1",
        startOffset: 0,
        endOffset: 1,
        quote: "a",
        prefix: "",
        suffix: "",
        contentHash: "a"
      }]
    }]
  };
  conversation.nodes["branch-b"] = {
    ...root,
    id: "branch-b",
    parentId: "root",
    childIds: [],
    title: "B",
    messages: []
  };
  const snapshot = new RelationshipGraphModelAdapter().snapshot("space-a", conversation);
  const graphRoot = snapshot.nodes.find((node) => node.id === "conversation:root");
  const branchB = snapshot.nodes.find((node) => node.id === "conversation:branch-b");
  const branchA = snapshot.nodes.find((node) => node.id === "conversation:branch-a");
  const note = snapshot.nodes.find((node) => node.id === noteRelationshipNodeId("Notes/a.md"));
  expect(graphRoot?.layoutRoot).toBe(true);
  expect(branchB).toMatchObject({ layoutParentId: "conversation:root", layoutOrder: 0 });
  expect(branchA).toMatchObject({ layoutParentId: "conversation:root", layoutOrder: 1 });
  expect(note).toMatchObject({
    layoutHostId: "conversation:branch-a",
    layoutNoteRelation: "source-note",
    layoutOrbitIndex: 0,
    layoutOrbitCount: 1
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { splitText, historyKey, providerKey, parseCohereResponse, parseOpenRouterResponse } from "../index.js";

test("splitText keeps all text and respects the chunk limit", () => {
  const source = "alpha beta gamma\ndelta epsilon zeta";
  const chunks = splitText(source, 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), source.replace(/\s+/g, " ").trim());
});

test("history and provider keys are isolated by chat and user", () => {
  assert.notEqual(historyKey("group", "user-a"), historyKey("group", "user-b"));
  assert.notEqual(providerKey("group", "user-a"), providerKey("group", "user-b"));
  assert.notEqual(historyKey("chat-a", "user-a"), historyKey("chat-b", "user-a"));
});

test("parseCohereResponse extracts only text blocks", () => {
  const response = {
    message: {
      content: [
        { type: "text", text: "Hello" },
        { type: "tool-call", id: "x" },
        { type: "text", text: "World" },
      ],
    },
  };
  assert.equal(parseCohereResponse(response), "Hello\nWorld");
});

test("parseCohereResponse handles missing content", () => {
  assert.equal(parseCohereResponse({}), "");
});

test("parseOpenRouterResponse extracts chat completion text", () => {
  assert.equal(parseOpenRouterResponse({ choices: [{ message: { content: "Hello from OpenRouter" } }] }), "Hello from OpenRouter");
});

test("parseOpenRouterResponse handles missing content", () => {
  assert.equal(parseOpenRouterResponse({}), "");
});

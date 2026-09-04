import { describe, expect, test } from "bun:test";
import { classifyIntent } from "../core/intent-router";

describe("classifyIntent — TOOL path", () => {
  test("open <app> resolves to a structured open_app action, not conversational text", () => {
    const route = classifyIntent("Open Spotify.");
    expect(route.path).toBe("tool");
    expect(route.action).toEqual({ name: "open_app", target: "Spotify" });
  });

  test("launch/start are also recognized as open", () => {
    expect(classifyIntent("launch notepad").action?.name).toBe("open_app");
    expect(classifyIntent("start the calculator").action?.target).toBe("calculator");
  });

  test("close/quit/exit resolve to a structured close_app action", () => {
    const route = classifyIntent("Please close Notepad");
    expect(route.path).toBe("tool");
    expect(route.action).toEqual({ name: "close_app", target: "Notepad" });
  });

  test("does not misfire on a question that merely contains 'open'", () => {
    expect(classifyIntent("What's open right now near me?").path).not.toBe("tool");
  });
});

describe("classifyIntent — DEEP path", () => {
  test("explicit research/thoroughness requests route to deep", () => {
    expect(classifyIntent("Can you research this thoroughly and write a report?").path).toBe("deep");
  });

  test("multi-step requests with sequential clauses route to deep", () => {
    expect(classifyIntent("Check my email, and then summarize the important ones").path).toBe("deep");
  });

  test("a genuinely long request routes to deep on length alone", () => {
    const long = "Tell me about the history of the Roman Empire, ".repeat(6);
    expect(long.length).toBeGreaterThan(220);
    expect(classifyIntent(long).path).toBe("deep");
  });
});

describe("classifyIntent — REASONING path", () => {
  test("comparison/judgment requests route to reasoning", () => {
    expect(classifyIntent("What are the pros and cons of switching to Ollama?").path).toBe("reasoning");
    expect(classifyIntent("Should I use Postgres or SQLite for this project?").path).toBe("reasoning");
  });

  test("a bare 'should i' with no real content stays fast (too short to be worth the extra tier)", () => {
    expect(classifyIntent("should i?").path).toBe("fast");
  });
});

describe("classifyIntent — FAST path (default)", () => {
  test("greetings and simple factual questions stay fast", () => {
    expect(classifyIntent("Hi Jarvis").path).toBe("fast");
    expect(classifyIntent("What's the capital of France?").path).toBe("fast");
    expect(classifyIntent("How many ounces are in a pound?").path).toBe("fast");
  });
});

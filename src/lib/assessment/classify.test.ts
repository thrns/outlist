import { describe, expect, it } from "vitest";
import { classifyRepository, CLASSIFICATION_POLICY_VERSION, type ClassificationInput } from "./classify";

const categories = [
  ["developer-tools", "Developer Tools"], ["ai-machine-learning", "AI & Machine Learning"], ["productivity", "Productivity"],
  ["design", "Design"], ["analytics", "Analytics"], ["infrastructure", "Infrastructure"], ["data-databases", "Data & Databases"],
  ["communication", "Communication"], ["self-hosted", "Self-hosted"], ["security-privacy", "Security & Privacy"], ["automation-workflows", "Automation & Workflows"],
].map(([slug, name], index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, slug, name, is_active: true }));
const input = (overrides: Partial<ClassificationInput> = {}): ClassificationInput => ({
  name: "sample-project", description: null, descriptionState: "null", topics: [], topicsComplete: true,
  primaryLanguage: "Python", languages: [{ name: "Python", bytes: 900 }], categories, ...overrides,
});

describe("deterministic project classification", () => {
  it("maps strong topic evidence to an existing category with explanation", () => {
    const result = classifyRepository(input({ topics: ["machine-learning"] }));
    expect(result).toMatchObject({ status: "classified", primaryCategoryId: categories[1]!.id, policyVersion: CLASSIFICATION_POLICY_VERSION });
    expect(result.suggestions[0]?.evidence[0]).toMatchObject({ source: "topic", value: "machine-learning" });
  });
  it("retains supported secondary categories", () => {
    const result = classifyRepository(input({ name: "workflow-automation-tool", topics: ["developer-tools", "cli"] }));
    expect(result.status).toBe("classified");
    expect(result.suggestions.map((suggestion) => suggestion.categorySlug)).toContain("automation-workflows");
    expect(result.suggestions.map((suggestion) => suggestion.categorySlug)).toContain("developer-tools");
  });
  it("requires review when signals conflict", () => {
    const result = classifyRepository(input({ topics: ["machine-learning", "database"] }));
    expect(result).toMatchObject({ status: "conflicting_signals", primaryCategoryId: null, confidence: "low" });
  });
  it("bounds conflicting suggestions to the database payload limit", () => {
    const result = classifyRepository(input({ topics: [
      "developer-tools", "machine-learning", "productivity", "design", "analytics", "infrastructure",
      "database", "communication", "self-hosted", "security", "automation",
    ] }));
    expect(result.status).toBe("conflicting_signals");
    expect(result.suggestions).toHaveLength(3);
  });
  it("ignores unknown and ambiguous topics", () => {
    expect(classifyRepository(input({ topics: ["misc", "cool-project"] }))).toMatchObject({ status: "insufficient_evidence", suggestions: [] });
  });
  it("does not classify from programming language alone", () => {
    expect(classifyRepository(input())).toMatchObject({ status: "insufficient_evidence", primaryCategoryId: null });
  });
  it("does not treat incomplete topics as a complete observation", () => {
    expect(classifyRepository(input({ topics: ["machine-learning"], topicsComplete: false }))).toMatchObject({ status: "insufficient_evidence", primaryCategoryId: null });
  });
  it("lowers support for negative description evidence", () => {
    const result = classifyRepository(input({ description: "Not a machine learning toolkit", descriptionState: "present" }));
    expect(result.status).toBe("insufficient_evidence");
  });
  it("is stable for identical source and policy inputs", () => {
    const source = input({ topics: ["machine-learning", "developer-tools"] });
    expect(classifyRepository(source)).toEqual(classifyRepository(source));
    expect(classifyRepository(source)).toEqual(classifyRepository({ ...source, topics: [...source.topics].reverse() }));
  });
  it("uses only active seeded taxonomy categories", () => {
    const result = classifyRepository(input({ categories: categories.filter((category) => category.slug !== "developer-tools") as ClassificationInput["categories"], topics: ["developer-tools"] }));
    expect(result).toMatchObject({ status: "insufficient_evidence", suggestions: [] });
    expect(result.suggestions.some((suggestion) => suggestion.categorySlug === "made-up")).toBe(false);
  });
});

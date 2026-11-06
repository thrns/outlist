import { z } from "zod";

export const CLASSIFICATION_POLICY_VERSION = "outlist-category-rules-v1" as const;

const categorySchema = z.object({ id: z.string().uuid(), slug: z.string().min(1), name: z.string().min(1), is_active: z.boolean() });
const sourceFieldStateSchema = z.enum(["present", "null", "absent", "unavailable", "unsupported", "rejected"]);
const inputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable(),
  descriptionState: sourceFieldStateSchema,
  topics: z.array(z.string().min(1).max(100)).max(100),
  topicsComplete: z.boolean(),
  primaryLanguage: z.string().max(100).nullable(),
  languages: z.array(z.object({ name: z.string().min(1).max(100), bytes: z.number().int().nonnegative() })).max(100),
  categories: z.array(categorySchema).max(100),
});

export type ClassificationInput = z.input<typeof inputSchema>;
export type ClassificationEvidence = { rule: string; source: "topic" | "name" | "description"; value: string; explanation: string };
export type CategorySuggestion = { categoryId: string; categorySlug: string; categoryName: string; score: number; confidence: "low" | "medium" | "high"; evidence: ClassificationEvidence[] };
export type ClassificationResult = {
  policyVersion: typeof CLASSIFICATION_POLICY_VERSION;
  status: "classified" | "insufficient_evidence" | "conflicting_signals";
  primaryCategoryId: string | null;
  suggestions: CategorySuggestion[];
  confidence: "low" | "medium" | "high" | "none";
  explanation: string;
};

type Rule = { id: string; category: string; topics: string[]; phrases: string[] };
const RULES: Rule[] = [
  { id: "devtools-v1", category: "developer-tools", topics: ["developer-tools", "devtools", "cli", "code-editor", "ide", "compiler", "debugger", "sdk", "git"], phrases: ["developer tool", "command line", "code editor", "software development kit", "debugging tool"] },
  { id: "ai-ml-v1", category: "ai-machine-learning", topics: ["artificial-intelligence", "machine-learning", "deep-learning", "llm", "large-language-model", "computer-vision", "natural-language-processing", "generative-ai"], phrases: ["machine learning", "large language model", "artificial intelligence", "neural network", "computer vision"] },
  { id: "productivity-v1", category: "productivity", topics: ["productivity", "task-management", "note-taking", "project-management", "calendar", "personal-knowledge-management"], phrases: ["task manager", "note taking", "project management", "personal knowledge", "time tracking"] },
  { id: "design-v1", category: "design", topics: ["design", "design-system", "ui", "ux", "figma", "typography", "color-palette", "wireframe"], phrases: ["design system", "user interface", "user experience", "graphic design", "color palette"] },
  { id: "analytics-v1", category: "analytics", topics: ["analytics", "business-intelligence", "data-visualization", "observability", "monitoring", "metrics"], phrases: ["data analytics", "business intelligence", "data visualization", "product analytics", "metrics dashboard"] },
  { id: "infrastructure-v1", category: "infrastructure", topics: ["infrastructure", "devops", "kubernetes", "docker", "cloud-native", "platform-engineering", "terraform"], phrases: ["cloud infrastructure", "infrastructure as code", "container orchestration", "platform engineering"] },
  { id: "data-databases-v1", category: "data-databases", topics: ["database", "databases", "sql", "postgresql", "mysql", "data-warehouse", "data-lake", "vector-database"], phrases: ["database management", "data warehouse", "data lake", "database engine", "vector database"] },
  { id: "communication-v1", category: "communication", topics: ["communication", "chat", "messaging", "email", "video-conferencing", "federation", "matrix"], phrases: ["team chat", "instant messaging", "video conferencing", "email client", "communication platform"] },
  { id: "self-hosted-v1", category: "self-hosted", topics: ["self-hosted", "selfhosting", "homelab", "on-premise", "on-premises"], phrases: ["self hosted", "self-hosted", "self hosting", "run on your own server"] },
  { id: "security-privacy-v1", category: "security-privacy", topics: ["security", "privacy", "encryption", "cryptography", "authentication", "authorization", "password-manager", "security-audit"], phrases: ["data privacy", "end-to-end encryption", "password manager", "identity and access", "security scanner"] },
  { id: "automation-workflows-v1", category: "automation-workflows", topics: ["automation", "workflow", "workflows", "ci", "continuous-integration", "continuous-deployment", "orchestration", "no-code"], phrases: ["workflow automation", "continuous integration", "continuous deployment", "automated workflow", "task automation"] },
];

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function classifyRepository(input: ClassificationInput): ClassificationResult {
  const repo = inputSchema.parse(input);
  const taxonomy = new Map(repo.categories.filter((category) => category.is_active).map((category) => [category.slug, category]));
  const scores = new Map<string, { score: number; evidence: ClassificationEvidence[] }>();
  const add = (rule: Rule, evidence: ClassificationEvidence, score: number) => {
    if (!taxonomy.has(rule.category)) return;
    const current = scores.get(rule.category) ?? { score: 0, evidence: [] };
    current.score += score;
    current.evidence.push(evidence);
    scores.set(rule.category, current);
  };

  const orderedTopics = repo.topicsComplete ? [...repo.topics].sort((a, b) => {
    const left = normalize(a).replaceAll(" ", "-");
    const right = normalize(b).replaceAll(" ", "-");
    return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
  }) : [];
  for (const topic of orderedTopics) {
    const normalizedTopic = normalize(topic).replaceAll(" ", "-");
    for (const rule of RULES) if (rule.topics.includes(normalizedTopic)) add(rule, {
      rule: rule.id, source: "topic", value: topic, explanation: `GitHub topic “${topic}” maps to ${taxonomy.get(rule.category)?.name}.`,
    }, 3);
  }
  const textFields = [
    { source: "name" as const, value: repo.name },
    ...(repo.descriptionState === "present" && repo.description ? [{ source: "description" as const, value: repo.description }] : []),
  ];
  for (const field of textFields) {
    const normalizedText = normalize(field.value);
    for (const rule of RULES) for (const phrase of rule.phrases) {
      const normalizedPhrase = normalize(phrase);
      if (normalizedText.includes(normalizedPhrase)) {
        const negative = new RegExp(`\\b(?:not|no|without|non)\\s+(?:[a-z0-9]+\\s+){0,2}${normalizedPhrase.replaceAll(" ", "\\s+")}\\b`).test(normalizedText);
        add(rule, {
          rule: rule.id, source: field.source, value: field.value.slice(0, 240),
          explanation: negative
            ? `The repository ${field.source} qualifies “${phrase}” negatively; this lowers support for ${taxonomy.get(rule.category)?.name}.`
            : `The repository ${field.source} contains “${phrase}”.`,
        }, negative ? -2 : 2);
      }
    }
  }

  // Programming-language names and byte distributions are deliberately not category evidence.
  void repo.primaryLanguage;
  void repo.languages;
  const suggestions = [...scores.entries()].map(([slug, value]) => {
    const category = taxonomy.get(slug)!;
    const score = value.score;
    return {
      categoryId: category.id, categorySlug: category.slug, categoryName: category.name,
      score, confidence: score >= 6 ? "high" as const : score >= 3 ? "medium" as const : "low" as const,
      evidence: value.evidence.slice(0, 12),
    };
  }).filter((suggestion) => suggestion.score >= 2)
    .sort((a, b) => b.score - a.score || (a.categorySlug < b.categorySlug ? -1 : a.categorySlug > b.categorySlug ? 1 : 0));

  if (!suggestions.length) return {
    policyVersion: CLASSIFICATION_POLICY_VERSION, status: "insufficient_evidence", primaryCategoryId: null,
    suggestions: [], confidence: "none", explanation: "No supported category evidence was found in the repository name, description, or topics.",
  };
  const gap = suggestions.length > 1 ? suggestions[0]!.score - suggestions[1]!.score : suggestions[0]!.score;
  const primary = suggestions[0]!;
  const boundedSuggestions = suggestions.slice(0, 3);
  if (primary.score < 3 || gap < 2) return {
    policyVersion: CLASSIFICATION_POLICY_VERSION, status: "conflicting_signals", primaryCategoryId: null,
    suggestions: boundedSuggestions, confidence: "low", explanation: "Multiple category signals are close or too weak to select a primary category.",
  };
  return {
    policyVersion: CLASSIFICATION_POLICY_VERSION, status: "classified", primaryCategoryId: primary.categoryId,
    suggestions: boundedSuggestions, confidence: primary.confidence,
    explanation: `Suggested ${primary.categoryName} from ${primary.evidence.map((evidence) => evidence.source).join(" and ")} evidence.`,
  };
}

import { getTravelBotSettings, readKnowledgeDataFromTrips } from "./travelOps";

export type ProgramPrice = number | "NEEDS_MANUAL_FIX";

export type Program = {
  name: string;
  duration: string;
  price: ProgramPrice;
  target: string;
  description: string;
};

export type SpecialOffer = Program & {
  eligibility: string;
};

export type DiscountPolicy = {
  name: string;
  discount: string;
  applies_to: string;
  eligibility: string;
  description: string;
  verification: string;
};

export type VerifiedCredential = {
  title: string;
  issuer: string;
  issued_on: string;
  description: string;
};

export type FAQItem = {
  question: string;
  answer: string;
};

export type KnowledgeData = {
  packages: Program[];
  modules: Program[];
  special_offers: SpecialOffer[];
  discount_policies: DiscountPolicy[];
  verified_credentials: VerifiedCredential[];
  faq: FAQItem[];
  conflicts_found: string[];
};

export type ProgramsData = Pick<
  KnowledgeData,
  "packages" | "modules" | "special_offers" | "discount_policies" | "conflicts_found"
>;

export type FAQData = Pick<KnowledgeData, "faq" | "verified_credentials">;

export type PromptBusinessData = {
  name: string;
  knowledgeBase: string;
};

export type BusinessDataFile = {
  systemPrompt: string;
  business: PromptBusinessData;
  knowledge: KnowledgeData;
};

export function formatPrice(price: ProgramPrice) {
  return typeof price === "number" ? String(price) : "Үнэ тодорхойгүй";
}

function formatKnowledgeBase(data: KnowledgeData) {
  const lines: string[] = [];

  lines.push("Packages:");
  for (const program of data.packages) {
    lines.push(
      `- ${program.name} | duration: ${program.duration} | price: ${formatPrice(program.price)} | target: ${program.target} | description: ${program.description}`,
    );
  }

  lines.push("");
  lines.push("Modules:");
  for (const program of data.modules) {
    lines.push(
      `- ${program.name} | duration: ${program.duration} | price: ${formatPrice(program.price)} | target: ${program.target} | description: ${program.description}`,
    );
  }

  lines.push("");
  lines.push("Special offers:");
  for (const offer of data.special_offers) {
    lines.push(
      `- ${offer.name} | duration: ${offer.duration} | price: ${formatPrice(offer.price)} | target: ${offer.target} | description: ${offer.description} | eligibility: ${offer.eligibility}`,
    );
  }

  lines.push("");
  lines.push("Discount policies:");
  for (const policy of data.discount_policies) {
    lines.push(
      `- ${policy.name} | discount: ${policy.discount} | applies to: ${policy.applies_to} | eligibility: ${policy.eligibility} | description: ${policy.description} | verification: ${policy.verification}`,
    );
  }

  lines.push("");
  lines.push("Verified credentials:");
  for (const credential of data.verified_credentials) {
    lines.push(
      `- ${credential.title} | issuer: ${credential.issuer} | issued on: ${credential.issued_on} | description: ${credential.description}`,
    );
  }

  lines.push("");
  lines.push("FAQ:");
  for (const item of data.faq) {
    lines.push(`- Q: ${item.question}`);
    lines.push(`  A: ${item.answer}`);
  }

  return lines.join("\n");
}

export async function readKnowledgeData(): Promise<KnowledgeData> {
  return readKnowledgeDataFromTrips();
}

export async function readPrograms(): Promise<ProgramsData> {
  const knowledge = await readKnowledgeData();
  return {
    packages: knowledge.packages,
    modules: knowledge.modules,
    special_offers: knowledge.special_offers,
    discount_policies: knowledge.discount_policies,
    conflicts_found: knowledge.conflicts_found,
  };
}

export async function readFAQ(): Promise<FAQData> {
  const knowledge = await readKnowledgeData();
  return {
    faq: knowledge.faq,
    verified_credentials: knowledge.verified_credentials,
  };
}

export async function readBusinessData(): Promise<BusinessDataFile> {
  const [knowledge, settings] = await Promise.all([
    readKnowledgeData(),
    getTravelBotSettings(),
  ]);

  return {
    systemPrompt: settings.system_prompt,
    business: {
      name: settings.business_name,
      knowledgeBase: formatKnowledgeBase(knowledge),
    },
    knowledge,
  };
}

export async function buildContext(intent: string) {
  const data = await readKnowledgeData();

  if (intent === "price") {
    return {
      packages: data.packages,
      modules: data.modules,
      special_offers: data.special_offers,
      discount_policies: data.discount_policies,
    };
  }

  if (intent === "duration") {
    return {
      packages: data.packages,
      modules: data.modules,
      special_offers: data.special_offers,
    };
  }

  if (intent === "program") {
    return {
      packages: data.packages,
      modules: data.modules,
      special_offers: data.special_offers,
      discount_policies: data.discount_policies,
      verified_credentials: data.verified_credentials,
    };
  }

  if (intent === "faq" || intent === "scholarship" || intent === "contact") {
    return {
      faq: data.faq,
      special_offers: data.special_offers,
      discount_policies: data.discount_policies,
      verified_credentials: data.verified_credentials,
    };
  }

  return {
    packages: data.packages,
    modules: data.modules,
    special_offers: data.special_offers,
    discount_policies: data.discount_policies,
    verified_credentials: data.verified_credentials,
    faq: data.faq,
  };
}

export function detectIntent(message: string): string {
  const m = message.toLowerCase();

  if (
    m.includes("website") ||
    m.includes("вэбсайт") ||
    m.includes("сайт") ||
    (m.includes("site") && !m.includes("opposite"))
  ) {
    return "faq";
  }

  if (
    m.includes("үнэ") ||
    m.includes("une") ||
    m.includes("төлбөр") ||
    m.includes("price") ||
    m.includes("cost") ||
    m.includes("how much")
  ) {
    return "price";
  }

  if (
    m.includes("хугацаа") ||
    m.includes("сар") ||
    m.includes("хэр удаан") ||
    m.includes("duration") ||
    m.includes("how long")
  ) {
    return "duration";
  }

  if (
    m.includes("багц") ||
    m.includes("plan") ||
    m.includes("starter") ||
    m.includes("growth") ||
    m.includes("pro") ||
    m.includes("enterprise") ||
    m.includes("free") ||
    m.includes("үнэгүй")
  ) {
    return "program";
  }

  if (
    m.includes("feature") ||
    m.includes("функц") ||
    m.includes("flow") ||
    m.includes("broadcast") ||
    m.includes("sequence") ||
    m.includes("comment")
  ) {
    return "program";
  }

  if (
    m.includes("утас") ||
    m.includes("phone") ||
    m.includes("email") ||
    m.includes("и-мэйл") ||
    m.includes("мэйл") ||
    m.includes("facebook") ||
    m.includes("instagram") ||
    m.includes("telegram") ||
    m.includes("contact") ||
    m.includes("холбоо")
  ) {
    return "contact";
  }

  if (
    m.includes("бүртг") ||
    m.includes("register") ||
    m.includes("signup") ||
    m.includes("sign up") ||
    m.includes("join") ||
    m.includes("эхл") ||
    m.includes("start")
  ) {
    return "join";
  }

  return "general";
}

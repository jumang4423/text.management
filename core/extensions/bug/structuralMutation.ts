import type { Random } from "./math";

const MUTATION_CHANCE = 0.05;
const MAX_WRAPPERS = 3;

/** Wrap a complete, single-line d-channel pattern, preserving its comment. */
export function mutatePatternStructure(line: string, random: Random): string | null {
  const prefix = line.match(/^\s*d\d+\s*\$\s*/)?.[0];
  if (!prefix || line.length > 2_000) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let codeEnd = line.length;
  let visibleCode = "";
  for (let index = prefix.length; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (line.slice(index, index + 2) === "--") { codeEnd = index; break; }
    // Leave block comments, character literals, explicit layout and multiline
    // expressions to the language parser rather than guessing their extent.
    if (char === "{" || char === "}" || char === ";" || char === "'") return null;
    visibleCode += char;
    if (char === "(" || char === "[") stack.push(char);
    if (char === ")" || char === "]") {
      if (stack.pop() !== (char === ")" ? "(" : "[")) return null;
    }
    if (stack.length > 12) return null;
  }
  if (inString || stack.length) return null;
  const expression = line.slice(prefix.length, codeEnd).trimEnd();
  if (!expression || /[!#$%&*+./<=>?@\\^|,:~-]$/.test(expression)) return null;
  if (/\b(?:let|in|where|do)\b/.test(visibleCode)) return null;
  // Bound repeated growth, including wrappers subsequently changed by a bite.
  if ((visibleCode.match(/\b(?:rev|palindrome|loopFirst|brak|press|always|almostAlways|often|sometimes|rarely|someCycles)\b/g) ?? []).length >= MAX_WRAPPERS) return null;
  if (random.next() >= MUTATION_CHANCE) return null;
  const wrapper = random.pick(["rev", "sometimes (fast 2)"]) ?? "rev";
  const suffix = line.slice(prefix.length + expression.length);
  return `${prefix}${wrapper} (${expression})${suffix}`;
}
